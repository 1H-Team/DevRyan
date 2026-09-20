import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSupabaseServerClient } from '../../packages/web/server/lib/multi-user/supabase-client.js';
import { PRODUCTION_BOTS_MIGRATION } from '../../packages/web/server/lib/multi-user/auth-compat.js';
import { BOT_TABLES, createBotStore } from '../../packages/web/server/lib/bots/store.js';
import { createTelegramStore } from '../../packages/web/server/lib/bots/telegram/store.js';
import { createBotAuditQuery } from '../../packages/web/server/lib/bots/audit-query.js';
import { createBotAuthorization } from '../../packages/web/server/lib/bots/authorization.js';
import { createBotBlobStore } from '../../packages/web/server/lib/bots/blob-store.js';
import { createEncryptedFileStorage } from './encrypted-files.mjs';
import { localDatabase, localPort, parityDatabase, parityPort, sql, workspace } from './fixtures.mjs';

// The identical contract calls the production repositories in both environments.
// No provider, bot execution, Telegram network call or installed-app data is used.
export async function runRepositoryContract(target) {
  assert(['local', 'supabase'].includes(target));
  const local = target === 'local';
  const database = local ? localDatabase : parityDatabase;
  const credentials = JSON.parse(await readFile(path.join(workspace, local ? 'local-credentials.json' : 'parity-credentials.json'), 'utf8'));
  const base = `http://127.0.0.1:${local ? localPort : parityPort}`;
  const secretKey = local ? credentials.serviceKey : credentials.SERVICE_ROLE_KEY;
  const client = createSupabaseServerClient({ url: base, publishableKey: '', secretKey,
    // Bare PostgREST omits Kong's /rest/v1 mount point. No repository changes.
    fetchImpl: (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, base, 'Only the selected loopback fixture is reachable');
      if (local) parsed.pathname = parsed.pathname.replace(/^\/rest\/v1/, '');
      return fetch(parsed, options);
    },
  });
  const files = local ? await createEncryptedFileStorage(path.join(workspace, 'objects')) : {};
  const transport = { ...client, ...files };
  const store = createBotStore({ supabase: transport });
  const telegram = createTelegramStore({ supabase: client });
  const audit = createBotAuditQuery({ supabase: client, assertSchemaVersion: store.assertSchemaVersion, logger: {} });
  const checks = [];
  const check = async (label, action) => { await action(); checks.push(label); console.log(`${target}: PASS ${label}`); };
  const actorId = randomUUID();
  const outsiderId = randomUUID();
  const botId = randomUUID();
  const revisionId = randomUUID();
  const channelId = randomUUID();
  const principal = { id: actorId, role: 'admin', scope: 'managed' };
  // Fresh synthetic identities have no Auth credentials or usable logins.
  sql(database, `insert into auth.users(id,email) values ('${actorId}','${actorId}@example.test'), ('${outsiderId}','${outsiderId}@example.test');
    insert into public.user_profiles(id,email,display_name,role) values ('${actorId}','${actorId}@example.test','Spike owner','admin'), ('${outsiderId}','${outsiderId}@example.test','Spike outsider','admin');`);
  await check('schema marker and every Bot table projection', async () => {
    await store.assertSchemaVersion(PRODUCTION_BOTS_MIGRATION);
    for (const [name, config] of Object.entries(BOT_TABLES)) {
      assert(Array.isArray(await client.rest(name, { select: config.select, query: { limit: 1 } })));
    }
    assert.equal(await store.userProfileExists(actorId), true);
    assert.equal((await store.listUserAccountKinds([actorId])).get(actorId), 'human');
  });
  await check('atomic Bot/revision/membership creation and duplicate rollback', async () => {
    const input = { botId, revisionId, name: 'Isolated spike bot', tenancy: 'team',
      contract: { model: { providerId: 'fixture', modelId: 'fixture' } }, compiledHash: 'a'.repeat(64), actorId };
    const result = await store.createBot(input);
    assert.equal(result.bot.id, botId);
    assert.equal(result.revision.id, revisionId);
    assert.equal(result.membership.user_id, actorId);
    const duplicateRevision = randomUUID();
    await assert.rejects(store.createBot({ ...input, revisionId: duplicateRevision }));
    assert.equal(await store.get('bot_revisions', { id: duplicateRevision }), null);
  });
  await check('optimistic concurrency admits exactly one writer', async () => {
    const row = await store.get('bots', { id: botId });
    const writes = await Promise.allSettled(['First', 'Second'].map((summary) => store.updateIfRevision('bots', { id: botId }, { summary }, row.updated_at)));
    assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(writes.find((result) => result.status === 'rejected').reason.code, 'bot_revision_conflict');
  });
  await store.activateRevision({ botId, revisionId, actorId });
  await store.insert('bot_channels', { id: channelId, bot_id: botId, owner_user_id: actorId });
  const authorization = createBotAuthorization({ store });
  await check('existing channel permissions deny another member', async () => {
    await store.insert('bot_memberships', { bot_id: botId, user_id: outsiderId, role: 'member', assigned_by: actorId });
    await authorization.requireChannelSend(principal, botId, channelId);
    await assert.rejects(authorization.requireChannelSend({ id: outsiderId, scope: 'managed', role: 'developer' }, botId, channelId));
  });
  await check('row locks allocate distinct monotonic message sequences', async () => {
    const sequences = await Promise.all(Array.from({ length: 16 }, () => store.allocateMessageSequence(channelId)));
    assert.equal(new Set(sequences).size, 16);
    const sorted = sequences.map(Number).sort((a, b) => a - b);
    assert.equal(sorted.at(-1) - sorted[0], 15);
  });
  const runId = randomUUID();
  await check('atomic message/acknowledgment/run admission is idempotent', async () => {
    const input = { botId, channelId, revisionId, runId, messageId: randomUUID(), acknowledgmentId: randomUUID(),
      idempotencyKey: randomUUID(), modelSnapshot: { providerId: 'fixture', modelId: 'fixture' },
      contextSnapshot: { version: 1 }, computerScopeKey: `bot:${botId}`, actorUserId: actorId,
      bodyEnvelope: { ciphertext: 'synthetic-fixture' }, acknowledgmentBodyEnvelope: { ciphertext: 'synthetic-ack' },
      attachmentCount: 0, finalizedAt: new Date().toISOString(), sharedFiles: [] };
    // Existing READ COMMITTED RPCs can return 23505 to a racing duplicate;
    // their contract is one committed admission and a safe subsequent replay.
    // Assert both outcomes explicitly instead of changing the shared SQL rules.
    const results = await Promise.allSettled([store.enqueueMessageRun(input), store.enqueueMessageRun(input)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value.created).length, 1);
    for (const result of results) {
      if (result.status === 'rejected') assert.equal(result.reason.payload?.code, '23505');
      else assert.equal(result.value.run.id, runId);
    }
    const replay = await store.enqueueMessageRun(input);
    assert.equal(replay.created, false);
    assert.equal(replay.run.id, runId);
    assert.equal(replay.message.id, input.messageId);
    assert.equal(replay.acknowledgment.id, input.acknowledgmentId);
    assert.equal((await store.list('bot_messages', { filters: { channel_id: channelId } })).items.length, 2);
  });
  await check('advisory/row locks prevent concurrent run ownership', async () => {
    const results = await Promise.all(['worker-one', 'worker-two'].map((runtimeOwner) => store.claimRun({
      computerScopeKey: `bot:${botId}`, runtimeOwner, leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(results.find(Boolean).id, runId);
  });
  await check('Telegram projections and fenced lease ownership', async () => {
    const generation = randomUUID();
    const ownerId = randomUUID();
    await telegram.insert('connections', { bot_id: botId, generation,
      telegram_bot_id: String(100000000 + Math.floor(Math.random() * 100000000)), username: 'fixture_bot', credential_id: randomUUID() });
    assert.equal(await telegram.lease(botId, generation, ownerId), false);
    await telegram.patch('connections', { bot_id: botId }, { enabled: true });
    assert.equal(await telegram.lease(botId, generation, ownerId), true);
    assert.equal(await telegram.lease(botId, generation, randomUUID()), false);
    assert.equal(await telegram.ingest(botId, generation, randomUUID(), []), false);
    for (const name of ['connections', 'pairings', 'inbox', 'outbox']) assert(Array.isArray(await telegram.list(name, { bot_id: botId })));
    assert(Array.isArray(await telegram.listWork('inbox', { bot_id: botId })));
    await telegram.patch('connections', { bot_id: botId }, { enabled: false });
  });
  await check('audit view, filters, hydration, cursor and detail', async () => {
    for (let index = 0; index < 3; index += 1) {
      await store.insert('bot_audit_events', { event_id: randomUUID(), bot_id: botId, actor_user_id: actorId,
        target_type: 'bot', target_id: botId, action: 'bot.updated', result: 'success', metadata: {} });
    }
    const page = await audit.list(principal, { bot: botId, actor: actorId, result: 'all', limit: '1' });
    assert.equal(page.logs.length, 1);
    assert(page.nextCursor);
    const next = await audit.list(principal, { bot: botId, actor: actorId, result: 'all', limit: '1', cursor: page.nextCursor });
    assert.notEqual(next.logs[0].eventId, page.logs[0].eventId);
    assert.equal((await audit.detail(principal, page.logs[0].eventId)).log.eventId, page.logs[0].eventId);
    await assert.rejects(audit.list({ ...principal, role: 'developer' }, {}));
  });
  const key = randomBytes(32);
  const encryption = { getKey: async () => Buffer.from(key) };
  const blobs = createBotBlobStore({ store, authorization, encryption });
  let object;
  const cleartext = Buffer.from(`Encrypted feasibility object ${randomUUID()}`);
  await check('existing AES-GCM blob contract on the selected storage', async () => {
    object = await blobs.uploadPrivate({ principal, botId, channelId, contentType: 'text/plain', bytes: cleartext });
    assert.deepEqual((await blobs.download({ principal, botId, objectId: object.id })).bytes, cleartext);
    const ciphertext = await store.storage.download(object.storage_bucket, object.storage_object_name, { maximumBytes: 1024 });
    assert.equal(ciphertext.includes(cleartext), false);
    const wrongKeyBlobs = createBotBlobStore({ store, authorization, encryption: { getKey: async () => randomBytes(32) } });
    await assert.rejects(wrongKeyBlobs.download({ principal, botId, objectId: object.id }));
  });
  await check('missing and forged API credentials cannot read Bot tables', async () => {
    const endpoint = `${base}${local ? '' : '/rest/v1'}/bots?select=id`;
    for (const headers of [{}, { Authorization: 'Bearer forged', apikey: 'forged' }]) {
      const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(5000) });
      assert([401, 403].includes(response.status), `Unexpected status ${response.status}`);
    }
  });
  if (local) {
    await writeFile(path.join(workspace, 'object-recovery-fixture.json'), JSON.stringify({ botId, object, key: key.toString('base64'), cleartext: cleartext.toString('base64') }), { mode: 0o600 });
  }
  key.fill(0);
  return { target, checks, botId, objectId: object.id };
}

if (process.argv[1] === import.meta.filename) {
  const results = [];
  for (const target of ['local', 'supabase']) results.push(await runRepositoryContract(target));
  await writeFile(path.join(workspace, 'repository-contract-results.json'), JSON.stringify(results, null, 2));
}
