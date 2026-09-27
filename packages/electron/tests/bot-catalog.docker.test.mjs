// Opt-in real-Docker acceptance for the local Bot catalog:
//   DEVRYAN_RUN_BOT_DB_DOCKER_TESTS=1 bun test tests/bot-catalog.docker.test.mjs
// Requires the development images (devryan/bot-database:dev, devryan/bot-rest:dev).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { BOT_DB_MIGRATIONS } from '@openchamber/bot-db';
import { createLocalBotCatalogTransport } from '@openchamber/web/server/lib/bots/local-catalog.js';
import { createLocalBotObjectStorage } from '@openchamber/web/server/lib/bots/local-object-storage.js';
import { createBotStore } from '@openchamber/web/server/lib/bots/store.js';
import { createBotAuthorization } from '@openchamber/web/server/lib/bots/authorization.js';
import { createBotBlobStore } from '@openchamber/web/server/lib/bots/blob-store.js';
import { encryptBotJson } from '@openchamber/web/server/lib/bots/encryption.js';
import { messageAssociatedData } from '@openchamber/web/server/lib/bots/channels.js';
import { validateBotCatalogCandidate } from '@openchamber/web/server/lib/bots/catalog-validation.js';

import { COMPOSE_PATH, REPOSITORY_ROOT, createCatalogHarness, runProcess } from './bot-catalog-docker-harness.mjs';

const enabled = process.env.DEVRYAN_RUN_BOT_DB_DOCKER_TESTS === '1';
const suite = enabled ? describe : describe.skip;

suite('local Bot catalog on real PostgreSQL and PostgREST', () => {
  let harness;
  let store;
  let owner;
  let objectStorage;

  const ownerPrincipal = () => ({ id: owner, role: 'admin', scope: 'bot-owner', botOwner: true });
  const psql = (database, sql) => harness.databaseManager.exec(harness.context, database, sql);
  const count = async (table, database = 'devryan_bots') => Number(String(await psql(database, `select count(*) from public.${table};`)).trim());

  const createFixtureBot = async (name) => {
    const botId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    await store.createBot({
      botId, revisionId, name, tenancy: 'team',
      contract: { model: { providerId: 'fixture', modelId: 'fixture' } },
      compiledHash: 'a'.repeat(64), actorId: owner,
    });
    await store.activateRevision({ botId, revisionId, actorId: owner });
    const channelId = crypto.randomUUID();
    await store.insert('bot_channels', { id: channelId, bot_id: botId, owner_user_id: owner });
    const key = Buffer.from(harness.deploymentKey);
    const messageId = crypto.randomUUID();
    const acknowledgmentId = crypto.randomUUID();
    const envelope = (id, text) => encryptBotJson({
      key, keyId: 'deployment-v1', value: { version: 1, text, attachmentIds: [] },
      associatedData: messageAssociatedData(channelId, id),
    });
    await store.enqueueMessageRun({
      botId, channelId, revisionId, runId: crypto.randomUUID(), messageId, acknowledgmentId,
      idempotencyKey: crypto.randomUUID(), modelSnapshot: { providerId: 'fixture', modelId: 'fixture' },
      contextSnapshot: { version: 1 }, computerScopeKey: `bot:${botId}`, actorUserId: owner,
      bodyEnvelope: envelope(messageId, `hello ${name}`), acknowledgmentBodyEnvelope: envelope(acknowledgmentId, ''),
      attachmentCount: 0, finalizedAt: new Date().toISOString(), sharedFiles: [],
    });
    key.fill(0);
    const authorization = createBotAuthorization({ store });
    const blobs = createBotBlobStore({ store, authorization, encryption: harness.encryption });
    const object = await blobs.uploadPrivate({
      principal: { id: owner, role: 'admin', scope: 'managed' }, botId, channelId,
      contentType: 'text/plain', bytes: Buffer.from(`object for ${name}`),
    });
    await store.insert('bot_audit_events', {
      event_id: crypto.randomUUID(), bot_id: botId, actor_user_id: owner,
      target_type: 'bot', target_id: botId, action: 'bot.updated', result: 'success', metadata: {},
    });
    return { botId, channelId, objectId: object.id };
  };

  beforeAll(async () => {
    harness = await createCatalogHarness();
    const prepared = await harness.databaseManager.prepare(harness.context, { allowInitialize: true });
    expect(prepared).toMatchObject({ state: 'ready', initialized: true, migrated: BOT_DB_MIGRATIONS.length });
    await harness.startRest();
    objectStorage = await createLocalBotObjectStorage({ directory: path.join(harness.dataDirectory, 'bots', 'objects') });
    const transport = createLocalBotCatalogTransport({
      catalog: {
        getContext: () => harness.databaseManager.context(harness.context),
        ensure: async () => {},
      },
      objectStorage,
    });
    store = createBotStore({ supabase: transport });
    owner = crypto.randomUUID();
    await transport.rpc('devryan_local_upsert_identity', {
      p_user_id: owner, p_email: `owner-${owner}@workstation.invalid`, p_display_name: 'Workstation owner',
      p_account_kind: 'human', p_role: 'admin', p_status: 'active',
    });
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 120_000);

  test('never exposes a TCP listener, anonymous access or host bookkeeping', async () => {
    const listeners = await runProcess('docker', harness.composeArgs(['exec', '-T', '--user', 'postgres', 'database',
      'psql', '-XAt', '-c', "select setting from pg_settings where name = 'listen_addresses';"]), { env: harness.environment });
    expect(listeners.stdout.trim()).toBe('');
    const context = await harness.databaseManager.context(harness.context);
    const anonymous = await fetch(`${context.url}/bots?select=id`);
    expect(anonymous.status).toBe(401);
    const hidden = await fetch(`${context.url}/schema_migrations`, { headers: { Authorization: `Bearer ${context.token}` } });
    expect(hidden.status).toBe(404);
    const sessions = await fetch(`${context.url}/app_sessions?select=id`, { headers: { Authorization: `Bearer ${context.token}` } });
    expect(sessions.status).toBe(403);
  });

  test('backs up, restores into a verified candidate and swaps with a journal', async () => {
    const first = await createFixtureBot('Before backup');
    const backup = await harness.backups.createBackup(harness.context, { kind: 'manual' });
    expect(backup).toMatchObject({ kind: 'manual', objectCount: 1 });
    expect((await harness.backups.listBackups()).map((entry) => entry.id)).toContain(backup.id);

    await createFixtureBot('After backup');
    expect(await count('bots')).toBe(2);

    const candidate = await harness.backups.prepareRestore(harness.context, backup.id);
    const report = await validateBotCatalogCandidate({
      readPage: async ({ table, columns, keyColumn = 'id', afterId, limit }) => JSON.parse(String(await psql(candidate.database, `
        select coalesce(json_agg(row_to_json(t) order by t."${keyColumn}"), '[]'::json) from (
          select ${columns.map((column) => `"${column}"`).join(', ')} from public."${table}"
          ${afterId ? `where "${keyColumn}" > '${afterId}'` : ''} order by "${keyColumn}" limit ${limit}) t;`)).trim()),
      encryption: harness.encryption,
      objectsDirectory: candidate.objectsDirectory,
      hostStateDirectory: candidate.hostStateDirectory,
    });
    expect(report.objects).toBe(1);
    expect(report.envelopes).toBeGreaterThanOrEqual(3);

    const expected = await harness.backups.fingerprintDatabase(harness.context, candidate.database);
    await harness.backups.replaceWithCandidate(harness.context, candidate, {
      stopRest: harness.stopRest,
      startRest: async () => {
        const databaseId = JSON.parse(String(await psql('devryan_bots',
          "select json_build_object('id', (select database_id::text from devryan_local.installation));")).trim()).id;
        await harness.databaseManager.adoptLiveDatabaseId(databaseId);
        await harness.startRest();
      },
    });
    expect(await harness.backups.fingerprintLive(harness.context)).toEqual(expected);
    await harness.backups.commitReplacement(harness.context);
    expect(await harness.backups.readJournal()).toBeNull();
    const bots = (await store.list('bots', { limit: 10 })).items.map((bot) => bot.id);
    expect(bots).toEqual([first.botId]);
    const objectRow = await store.get('bot_objects', { id: first.objectId });
    await expect(objectStorage.storageDownload('devryan-bot-objects', objectRow.storage_object_name))
      .resolves.toBeInstanceOf(Buffer);
    const names = await harness.backups.databaseNames(harness.context);
    expect([...names].filter((name) => name.startsWith('devryan_bots_retired_'))).toEqual([]);
  }, 300_000);

  test('rolls an uncommitted replacement back to the retained catalog', async () => {
    await createFixtureBot('Kept');
    const before = await harness.backups.fingerprintLive(harness.context);
    const backup = await harness.backups.createBackup(harness.context, { kind: 'manual' });
    await createFixtureBot('Also kept');
    const live = await harness.backups.fingerprintLive(harness.context);
    const candidate = await harness.backups.prepareRestore(harness.context, backup.id);
    const handlers = { stopRest: harness.stopRest, startRest: harness.startRest };
    await harness.backups.replaceWithCandidate(harness.context, candidate, handlers);
    expect(await harness.backups.fingerprintLive(harness.context)).not.toEqual(live);
    // A crash before commit (or a failed post-verification) rolls back.
    expect(await harness.backups.recoverInterruptedReplacement(harness.context, handlers)).toBe('rolled_back');
    expect(await harness.backups.fingerprintLive(harness.context)).toEqual(live);
    expect(before).not.toEqual(live);
    expect(await count('bots')).toBe(3);
  }, 300_000);

  test('refuses history from a newer release and changed identity', async () => {
    await psql('devryan_bots', `insert into devryan_local.schema_migrations (ordinal, name, sha256, kind)
      values (${BOT_DB_MIGRATIONS.length}, 'local:9999_future', '${'f'.repeat(64)}', 'local');`);
    await expect(harness.databaseManager.prepare(harness.context)).rejects.toMatchObject({ code: 'bot_database_schema_newer' });
    expect(await harness.databaseManager.inspect(harness.context)).toMatchObject({ state: 'recovery_required', code: 'bot_database_schema_newer' });
    await psql('devryan_bots', `delete from devryan_local.schema_migrations where name = 'local:9999_future';`);
    await expect(harness.databaseManager.prepare(harness.context)).resolves.toMatchObject({ state: 'ready', migrated: 0 });
  }, 120_000);

  test('starts empty only by retiring the previous database', async () => {
    await harness.stopRest();
    const result = await harness.databaseManager.startEmpty(harness.context, { retiredSuffix: crypto.randomBytes(8).toString('hex') });
    expect(result.retiredDatabase).toMatch(/^devryan_bots_retired_/);
    await harness.startRest();
    expect(await count('bots')).toBe(0);
    expect(await count('bots', result.retiredDatabase)).toBe(3);
    expect(await harness.databaseManager.inspect(harness.context)).toMatchObject({ state: 'ready' });
  }, 300_000);

  test('keeps the cluster across a cold restart and refuses to initialize over it', async () => {
    await runProcess('docker', harness.composeArgs(['stop', 'database-rest', 'database']), { env: harness.environment });
    const init = await runProcess('docker', harness.composeArgs(['run', '--rm', '--no-deps', '-T',
      '--env', 'DEVRYAN_BOT_DATABASE_INITIALIZE=allow', 'database', '--initialize-only']), { env: harness.environment });
    expect(init.exitCode).toBe(66);
    await expect(harness.databaseManager.prepare(harness.context)).resolves.toMatchObject({ state: 'ready', initialized: false });
    await harness.startRest();
    expect(await harness.databaseManager.inspect(harness.context)).toMatchObject({ state: 'ready' });
    const state = JSON.parse(await fs.readFile(path.join(harness.dataDirectory, 'bots', 'runtime', 'database.v1.json'), 'utf8'));
    expect(state.schema).toEqual({ head: BOT_DB_MIGRATIONS.at(-1).name, appliedCount: BOT_DB_MIGRATIONS.length });
  }, 300_000);
});

suite('cloud Bot import into the local catalog', () => {
  let harness;
  let manager;
  let store;
  let transport;
  let cloud;
  let importer;
  let resetObjects;
  const cloudOwner = crypto.randomUUID();
  const localOwner = crypto.randomUUID();

  const upsertIdentity = (id, name) => transport.rpc('devryan_local_upsert_identity', {
    p_user_id: id, p_email: `${name}-${id}@example.test`, p_display_name: name,
    p_account_kind: 'human', p_role: 'admin', p_status: 'active',
  });
  const psql = (sql) => runProcess('docker', harness.composeArgs(['exec', '-T', '--user', 'postgres', 'database',
    'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-d', 'devryan_bots']), { env: harness.environment, input: sql })
    .then((result) => {
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    });

  const createBot = async (actorId, name) => {
    const botId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    await store.createBot({
      botId, revisionId, name, tenancy: 'team',
      contract: { model: { providerId: 'fixture', modelId: 'fixture' } }, compiledHash: 'b'.repeat(64), actorId,
    });
    await store.activateRevision({ botId, revisionId, actorId });
    const channelId = crypto.randomUUID();
    await store.insert('bot_channels', { id: channelId, bot_id: botId, owner_user_id: actorId });
    const key = Buffer.from(harness.deploymentKey);
    const envelope = (id) => encryptBotJson({
      key, keyId: 'deployment-v1', value: { version: 1, text: `from ${name}`, attachmentIds: [] },
      associatedData: messageAssociatedData(channelId, id),
    });
    const messageId = crypto.randomUUID();
    const acknowledgmentId = crypto.randomUUID();
    await store.enqueueMessageRun({
      botId, channelId, revisionId, runId: crypto.randomUUID(), messageId, acknowledgmentId,
      idempotencyKey: crypto.randomUUID(), modelSnapshot: { providerId: 'fixture', modelId: 'fixture' },
      contextSnapshot: { version: 1 }, computerScopeKey: `bot:${botId}`, actorUserId: actorId,
      bodyEnvelope: envelope(messageId), acknowledgmentBodyEnvelope: envelope(acknowledgmentId),
      attachmentCount: 0, finalizedAt: new Date().toISOString(), sharedFiles: [],
    });
    key.fill(0);
    const blobs = createBotBlobStore({ store, authorization: createBotAuthorization({ store }), encryption: harness.encryption });
    await blobs.uploadPrivate({
      principal: { id: actorId, role: 'admin', scope: 'managed' }, botId, channelId,
      contentType: 'text/plain', bytes: Buffer.from(`object for ${name}`),
    });
    for (let index = 0; index < 2; index += 1) {
      await store.insert('bot_audit_events', {
        event_id: crypto.randomUUID(), bot_id: botId, actor_user_id: actorId,
        target_type: 'bot', target_id: botId, action: 'bot.updated', result: 'success', metadata: {},
      });
    }
    return botId;
  };

  const waitForImport = async () => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const status = importer.status();
      if (!status.import?.running && ['completed', 'failed', 'blocked', 'cancelled'].includes(status.import?.phase)) return status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('import did not finish');
  };

  const newImporter = async () => {
    const { createBotCatalogImport } = await import('@openchamber/web/server/lib/bots/catalog-import.js');
    const { createBotActivationHold } = await import('@openchamber/web/server/lib/bots/activation-hold.js');
    const host = {
      backup: (options) => manager.backupCatalog(options),
      prepareRestore: (id) => manager.prepareCatalogRestore(id),
      readCandidate: (id, request) => manager.readCatalogCandidate(id, request),
      commitRestore: (id) => manager.commitCatalogRestore(id),
      discardCandidate: (id) => manager.discardCatalogCandidate(id),
      createImportSource: (marker) => manager.createImportSource(marker),
      migrateImportSource: (handle) => manager.migrateImportSource(handle),
      runImportSql: (target, chunks) => manager.runImportSql(target, chunks),
      exportImportPage: (target, request) => manager.exportImportPage(target, request),
      countRows: (target) => manager.countCatalogRows(target),
      dropImportSource: (handle) => manager.dropImportSource(handle),
    };
    const hold = createBotActivationHold({ dataDirectory: harness.dataDirectory });
    importer = createBotCatalogImport({
      dataDirectory: harness.dataDirectory,
      encryption: harness.encryption,
      host,
      runMaintenance: (_kind, operation) => operation({ markReplaced: () => resetObjects() }),
      activationHold: hold,
      readCloudSource: () => ({ url: cloud.url, secretKey: 'sb_secret_import_fixture' }),
      resolveVerifiedSourceOwner: async () => cloudOwner,
      validateCandidate: (candidate, options) => validateBotCatalogCandidate({
        readPage: (request) => host.readCandidate(candidate.operationId, request),
        encryption: harness.encryption,
        objectsDirectory: candidate.objectsDirectory,
        hostStateDirectory: candidate.hostStateDirectory,
        ...options,
      }),
      wait: async () => {},
    });
    await importer.initialize();
    return hold;
  };

  beforeAll(async () => {
    const { BOT_RUNTIME_IMAGE_KEYS, validateBotRuntimeManifest } = await import('../bot-runtime-manifest.mjs');
    const { createBotRuntimeManager } = await import('../bot-runtime-manager.mjs');
    const { loadBotDatabaseSql } = await import('@openchamber/bot-db');
    const { startFakeCloud } = await import('./fake-cloud-postgrest.mjs');
    harness = await createCatalogHarness();
    await harness.databaseManager.prepare(harness.context, { allowInitialize: true });
    const manifest = validateBotRuntimeManifest({
      version: 1,
      channel: 'development',
      images: Object.fromEntries(BOT_RUNTIME_IMAGE_KEYS.map((key) => [key, { reference: `devryan/bot-${key}:dev` }])),
    }, { isPackaged: false, architecture: process.arch });
    let installed = { version: 1, current: manifest, previous: null, staged: null };
    manager = createBotRuntimeManager({
      composePath: COMPOSE_PATH,
      loadManifest: async () => manifest,
      stateStore: { read: async () => structuredClone(installed), write: async (value) => { installed = structuredClone(value); } },
      dataDirectory: harness.dataDirectory,
      baseEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: harness.environment.DOCKER_CONFIG },
      loadRuntimeEnvironment: async () => harness.serviceEnvironment,
      loadDatabaseSql: () => loadBotDatabaseSql({
        supabaseMigrationsDirectory: path.join(REPOSITORY_ROOT, 'supabase/migrations'),
        sqlDirectory: path.join(REPOSITORY_ROOT, 'packages/bot-db/sql'),
      }),
      loadBackupKey: async () => Buffer.from(harness.backupKey),
      resourceNamespace: harness.resourceNamespace,
      projectName: harness.projectName,
    });
    await manager.ensureCatalog();
    // Like the server runtime, object storage is rebuilt after a replacement
    // swaps the live objects directory.
    let objects = null;
    const liveObjects = () => {
      objects ||= createLocalBotObjectStorage({ directory: path.join(harness.dataDirectory, 'bots', 'objects') });
      return objects;
    };
    resetObjects = () => { objects = null; };
    transport = createLocalBotCatalogTransport({
      catalog: { getContext: () => manager.databaseContext(), ensure: () => manager.ensureCatalog() },
      objectStorage: {
        storageUpload: async (...args) => (await liveObjects()).storageUpload(...args),
        storageDownload: async (...args) => (await liveObjects()).storageDownload(...args),
        storageDelete: async (...args) => (await liveObjects()).storageDelete(...args),
      },
    });
    store = createBotStore({ supabase: transport });

    // The hosted catalog: two Bots owned by a cloud account.
    await upsertIdentity(cloudOwner, 'Cloud owner');
    await createBot(cloudOwner, 'Cloud one');
    await createBot(cloudOwner, 'Cloud two');
    const tables = new Map();
    const names = (await psql("select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public' and (tablename = 'bots' or tablename like 'bot\\_%' or tablename = 'user_profiles');")).split(',');
    for (const name of names) {
      if (name === 'bot_local_owner_mappings') continue;
      tables.set(name, JSON.parse(await psql(`select coalesce(json_agg(t), '[]') from public.${name} t;`)));
    }
    const cloudObjects = new Map();
    for (const file of await fs.readdir(path.join(harness.dataDirectory, 'bots', 'objects'))) {
      cloudObjects.set(file, await fs.readFile(path.join(harness.dataDirectory, 'bots', 'objects', file)));
    }
    cloud = await startFakeCloud({ tables, objects: cloudObjects });

    // The local catalog starts empty and gains its own Bot.
    await manager.startEmptyCatalog();
    resetObjects();
    await upsertIdentity(localOwner, 'Workstation owner');
    await createBot(localOwner, 'Local one');
  }, 600_000);

  afterAll(async () => {
    await cloud?.close();
    await harness?.cleanup();
  }, 120_000);

  test('rejects equal-count drift between export and verification', async () => {
    await newImporter();
    const audit = cloud.tables.get('bot_audit_events');
    const original = structuredClone(audit[0]);
    let mutated = false;
    cloud.hooks.beforeResponse = () => {
      if (!mutated && importer.status().import?.phase === 'verifying') {
        audit[0] = { ...audit[0], action: 'bot.renamed' };
        mutated = true;
      }
    };
    await importer.start({ mode: 'merge', writersStopped: true });
    const status = await waitForImport();
    cloud.hooks.beforeResponse = null;
    expect(mutated).toBe(true);
    expect(status.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_source_changed' } });
    // Nothing reached the local catalog and nothing was written to the cloud.
    expect((await store.list('bots', { limit: 10 })).items).toHaveLength(1);
    expect(cloud.requests.every((request) => request.method === 'GET')).toBe(true);
    audit[0] = original;
    await importer.cancel();
  }, 600_000);

  test('blocks resumably on a hosted quota response while local Bots stay usable', async () => {
    let blocked = true;
    cloud.hooks.status = (url) => (blocked && url.pathname === '/rest/v1/bot_messages' ? 402 : null);
    await importer.start({ mode: 'merge', writersStopped: true });
    const status = await waitForImport();
    expect(status.import).toMatchObject({ phase: 'blocked', error: { code: 'bot_import_source_quota_exceeded', retryable: true } });
    expect((await store.list('bots', { limit: 10 })).items).toHaveLength(1);
    blocked = false;
    cloud.hooks.status = null;
  }, 600_000);

  test('merges disjoint hosted Bots with regenerated identities, owner mappings and a hold', async () => {
    const localMaxAudit = Number(await psql('select max(id) from public.bot_audit_events;'));
    const localMaxQueue = Number(await psql('select max(queue_sequence) from public.bot_runs;'));
    await importer.start({ mode: 'merge', writersStopped: true });
    const status = await waitForImport();
    expect(status.import).toMatchObject({ phase: 'completed', result: { importedBotCount: 2 } });
    expect(Number(await psql('select count(*) from public.bots;'))).toBe(3);
    // Imported numeric identities sit above the local maxima, in source order.
    expect(Number(await psql(`select min(a.id) from public.bot_audit_events a join public.bots b on b.id = a.bot_id where b.created_by = '${cloudOwner}';`)))
      .toBeGreaterThan(localMaxAudit);
    expect(Number(await psql(`select min(r.queue_sequence) from public.bot_runs r join public.bots b on b.id = r.bot_id where b.created_by = '${cloudOwner}';`)))
      .toBeGreaterThan(localMaxQueue);
    // The owner acts as the verified source owner for the imported Bots only.
    expect(await psql('select count(*) || \':\' || count(distinct source_owner_user_id) from public.bot_local_owner_mappings;')).toBe('2:1');
    expect(await psql(`select source_owner_user_id from public.bot_local_owner_mappings limit 1;`)).toBe(cloudOwner);
    // Nothing autonomous runs until the owner resumes.
    const hold = JSON.parse(await fs.readFile(path.join(harness.dataDirectory, 'bots', 'runtime', 'activation-hold.v1.json'), 'utf8'));
    expect(hold).toMatchObject({ reason: 'import' });
    // Imported envelopes and objects authenticate in the live catalog.
    const live = await validateBotCatalogCandidate({
      readPage: async ({ table, columns, keyColumn = 'id', afterId, limit }) => JSON.parse(await psql(`
        select coalesce(json_agg(row_to_json(t) order by t."${keyColumn}"), '[]'::json) from (
          select ${columns.map((column) => `"${column}"`).join(', ')} from public."${table}"
          ${afterId ? `where "${keyColumn}" > '${afterId}'` : ''} order by "${keyColumn}" limit ${limit}) t;`)),
      encryption: harness.encryption,
      objectsDirectory: path.join(harness.dataDirectory, 'bots', 'objects'),
      hostStateDirectory: harness.dataDirectory,
    });
    expect(live.objects).toBe(3);
    expect(cloud.requests.every((request) => request.method === 'GET')).toBe(true);
  }, 600_000);

  test('aborts a conflicting import without overwriting local Bots', async () => {
    const before = await psql('select string_agg(id::text, \',\' order by id) from public.bots;');
    await importer.start({ mode: 'merge', writersStopped: true });
    const status = await waitForImport();
    expect(status.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_bot_conflict' } });
    expect(await psql('select string_agg(id::text, \',\' order by id) from public.bots;')).toBe(before);
    await expect(importer.start({ mode: 'empty', writersStopped: false })).rejects.toMatchObject({
      code: 'bot_import_writers_unconfirmed',
    });
  }, 600_000);
});
