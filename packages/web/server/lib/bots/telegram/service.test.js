import { describe, expect, test } from 'vitest';
import { createBotTelegramService } from './service.js';
import { encryptBotJson, decryptBotJson } from '../encryption.js';
import { messageAssociatedData } from '../channels.js';

const BOT = 'b4000000-0000-4000-8000-000000000001';
const USER = 'a4000000-0000-4000-8000-000000000001';
const OTHER = 'a4000000-0000-4000-8000-000000000002';
const CHANNEL = 'c4000000-0000-4000-8000-000000000001';
const OTHER_CHANNEL = 'c4000000-0000-4000-8000-000000000002';
const RUN = 'd4000000-0000-4000-8000-000000000001';
const RESULT = 'e4000000-0000-4000-8000-000000000001';
const OBJECT = 'f4000000-0000-4000-8000-000000000001';
const token = `123456:${'a'.repeat(35)}`;
const KEY = Buffer.alloc(32, 4);
const principal = { id: USER, role: 'admin', scope: 'managed', status: 'active' };
const clone = (value) => structuredClone(value);
const uniqueError = () => Object.assign(new Error('unique violation'), { code: '23505' });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const waitFor = async (check) => {
  const until = Date.now() + 1000;
  while (!check()) { if (Date.now() > until) throw new Error('Telegram responsiveness fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); }
};

function fixture({ speech = null } = {}) {
  const tables = { connections: [], pairings: [], inbox: [], outbox: [] };
  let clock = Date.parse('2026-08-31T01:00:00.000Z');
  const timestamp = () => new Date(clock).toISOString();
  const state = { active: true, membership: true, manager: true, owner: true, dispatcherReady: true, updates: [], sent: [], calls: [], enqueued: [], cancelled: [], upload: [], runRows: [], messageRows: [], transportFailure: false, crashAfterSend: false, admissionFailure: false, webhook: '', identity: 123456, failIngest: false };
  const matches = (row, filters) => Object.entries(filters).every(([key, value]) => row[key] === value);
  const repository = {
    async get(name, keys) { return clone(tables[name].find((row) => matches(row, keys)) || null); },
    async list(name, keys = {}, query = {}) {
      let rows = tables[name].filter((row) => matches(row, keys));
      for (const [key, filter] of Object.entries(query)) {
        if (filter.startsWith?.('in.(')) rows = rows.filter((row) => filter.slice(4, -1).split(',').includes(row[key]));
        if (filter.startsWith?.('not.in.(')) rows = rows.filter((row) => !filter.slice(8, -1).split(',').includes(row[key]));
        if (filter.startsWith?.('lte.')) rows = rows.filter((row) => row[key] <= filter.slice(4));
        if (filter.startsWith?.('lt.')) rows = rows.filter((row) => row[key] < Number(filter.slice(3)));
        if (filter.startsWith?.('gt.')) rows = rows.filter((row) => row[key] > filter.slice(3));
      }
      const sortKey = query.order?.split('.')[0] || 'created_at';
      rows = [...rows].sort((a, b) => typeof a[sortKey] === 'number' ? a[sortKey] - b[sortKey] : String(a[sortKey]).localeCompare(String(b[sortKey])));
      if (query.order?.includes('desc')) rows.reverse();
      return clone(rows.slice(0, query.limit || 100));
    },
    async listWork(name, keys, query) { return (await repository.list(name, keys, query)).map(({ payload_envelope: _payload, ...row }) => row); },
    async insert(name, body) {
      if (tables[name].some((row) => name === 'connections' ? row.bot_id === body.bot_id || row.telegram_bot_id === body.telegram_bot_id : row.id === body.id)) throw uniqueError();
      const row = { created_at: timestamp(), updated_at: timestamp(), error_code: null, attempts: 0, next_attempt_at: timestamp(), telegram_user_id: null, chat_id: null, display_name: null, confirmed_at: null, ...(name === 'inbox' ? { request_kind: 'message', cancel_requested_at: null } : {}), ...clone(body) };
      tables[name].push(row); return clone(row);
    },
    async patch(name, keys, body) {
      if (state.crashAfterSend && name === 'outbox' && keys.state === 'sending' && body.part_index > 0) { state.crashAfterSend = false; throw new Error('persistence unavailable'); }
      let result = null;
      for (const row of tables[name]) if (matches(row, keys)) { Object.assign(row, clone(body), { updated_at: timestamp() }); result ||= row; }
      return clone(result);
    },
    async remove(name, keys) { tables[name] = tables[name].filter((row) => !matches(row, keys)); if (name === 'connections') for (const child of ['pairings', 'inbox', 'outbox']) tables[child] = tables[child].filter((row) => row.bot_id !== keys.bot_id); },
    async lease() { return true; },
    async ingest(botId, generation, owner, items) {
      if (state.failIngest) throw new Error('database unavailable');
      const connection = tables.connections.find((row) => row.bot_id === botId);
      for (const original of items) if (original.update_id >= connection.update_offset && !tables.inbox.some((row) => row.id === original.id)) {
        const item = clone(original);
        const active = tables.inbox.filter((row) => row.bot_id === botId && !['settled', 'rejected', 'quota_rejected'].includes(row.state));
        const command = item.request_kind === 'command';
        if (item.state === 'received' && active.filter((row) => (row.request_kind === 'command') === command).length >= (command ? 100 : 1000)) Object.assign(item, { state: 'quota_rejected', error_code: command ? 'telegram_control_limit' : 'telegram_inbox_limit', payload_envelope: item.rejection_envelope || {} });
        delete item.rejection_envelope;
        await repository.insert('inbox', { ...item, bot_id: botId, generation });
      }
      connection.update_offset = Math.max(connection.update_offset, ...items.map((row) => row.update_id + 1)); return true;
    },
    async confirm(botId, generation, pairingId, userId) {
      const candidate = tables.pairings.find((row) => row.id === pairingId && row.user_id === userId && row.bot_id === botId && row.generation === generation && row.state === 'claimed' && row.expires_at > timestamp());
      if (!candidate || !state.active || tables.pairings.some((row) => row.bot_id === botId && row.generation === generation && row.state === 'confirmed' && row.telegram_user_id === candidate.telegram_user_id && row.user_id !== userId)) return false;
      await repository.patch('pairings', { bot_id: botId, user_id: userId, state: 'confirmed' }, { state: 'revoked' });
      Object.assign(candidate, { state: 'confirmed', confirmed_at: timestamp(), nonce_hash: null }); return true;
    },
  };
  const credentialRows = new Map();
  const vault = {
    async create(input) { credentialRows.set(input.id, clone(input)); },
    async read(id) { const row = credentialRows.get(id); if (!row || row.revoked) throw new Error('revoked'); return { credential: row, secret: row.secret }; },
    async revoke(id) { credentialRows.get(id).revoked = true; },
    async deleteCreated(id) { credentialRows.delete(id); },
    async deleteForBot(botId) { for (const [id, row] of credentialRows) if (row.botId === botId) credentialRows.delete(id); },
  };
  const store = { repositories: Object.fromEntries([['bot_messages', state.messageRows], ['bot_runs', state.runRows]].map(([name, rows]) => [name, { async get(keys) { return clone(rows.find((row) => matches(row, keys)) || null); }, async list({ filters = {} } = {}) { return { items: clone(rows.filter((row) => matches(row, filters))), nextCursor: null }; } }])) };
  const authorization = {
    async requireActiveMembership() { if (!state.active || !state.membership) throw Object.assign(new Error('revoked'), { statusCode: 403, code: 'bot_membership_required' }); return { membership: { role: state.manager ? 'manager' : 'member' } }; },
    async requireManager() { if (!state.manager) throw Object.assign(new Error('manager required'), { statusCode: 403 }); },
  };
  const channels = { async getOrCreateOwnerChannel({ principal: actor }) { return { id: actor.id === USER ? CHANNEL : OTHER_CHANNEL }; }, async authorizeChannelRead() { await authorization.requireActiveMembership(); }, async authorizeChannelSend() { await authorization.requireActiveMembership(); } };
  const dispatcher = {
    async enqueueMessage(input) { state.enqueued.push(clone(input)); state.messageRows.push({ id: input.message.messageId, channel_id: input.channelId, role: 'user', run_id: RUN }); if (state.admissionFailure) throw new Error('lost admission response'); return { run: { id: RUN } }; },
    async cancelRun(input) { state.cancelled.push(input); },
  };
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1); const body = options.body instanceof FormData ? options.body : JSON.parse(options.body || '{}'); state.calls.push({ method, body });
    const response = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
    if (method === 'getMe') return response({ id: state.identity, username: 'example_bot', is_bot: true });
    if (method === 'getWebhookInfo') return response({ url: state.webhook });
    if (method === 'getUpdates') return state.pollWait ? state.pollWait(url, options.signal, response) : response(state.updates.filter((update) => update.update_id >= body.offset).slice(0, 25));
    if (method === 'getFile') return response({ file_path: 'documents/input.txt', file_size: 5 });
    if (method === 'input.txt') return state.downloadWait ? state.downloadWait(options.signal) : new Response('hello');
    if (['sendMessage', 'sendDocument', 'sendVoice'].includes(method)) { if (state.transportFailure) throw new Error(`failed ${url}`); state.sent.push({ method, body }); if (state.sendWait) return state.sendWait(method, options.signal, response); return response({ message_id: state.sent.length }); }
    throw new Error('unexpected request');
  };
  const blobStore = { async uploadPrivate(input) { state.upload.push(input); return { id: OBJECT }; }, async download() { return { bytes: Buffer.from('generated'), object: { content_type: 'text/plain', provenance: { filename: 'result.txt' } } }; } };
  let api;
  return {
    tables, state, repository, vault, credentialRows, principal, dispatcher,
    get api() { return api; },
    advance(ms = 2000) { clock += ms; },
    update(updateId, message) { state.updates.push({ update_id: updateId, message: { message_id: updateId, date: clock / 1000, from: { id: 123, is_bot: false, first_name: 'Tester' }, chat: { id: 123, type: 'private' }, ...message } }); },
    complete({ text = 'Verified answer', attachmentIds = [], state: runState = 'completed', routine = null } = {}) {
      state.runRows.push({ id: RUN, bot_id: BOT, channel_id: CHANNEL, state: runState, created_at: timestamp(), context_snapshot: routine ? { routine } : {} });
      state.messageRows.push({ id: RESULT, channel_id: CHANNEL, role: 'assistant', assistant_phase: 'result', run_id: RUN, finalized_at: timestamp(), body_envelope: encryptBotJson({ key: KEY, keyId: 'deployment-v1', associatedData: messageAssociatedData(CHANNEL, RESULT), value: { version: 1, text, attachmentIds } }) });
    },
    decode(name, row) { return decryptBotJson({ key: KEY, expectedKeyId: 'deployment-v1', associatedData: `devryan:telegram:${name}:${row.id}`, envelope: row.payload_envelope }); },
    async create() { api = await createBotTelegramService({ repository, credentialVault: vault, store, channels, authorization, blobStore, encryption: { getKey: async () => Buffer.from(KEY) }, resolvePrincipal: async (id) => state.active ? { ...principal, id } : null, getDispatcher: () => state.dispatcherReady ? dispatcher : null, isOwner: () => state.owner, speech, fetchImpl, now: () => clock }); return api; },
    async connect() { await api.configure(principal, BOT, { enabled: true, token }); const link = await api.createPairing(principal, BOT); this.update(1, { text: `/start ${new URL(link.url).searchParams.get('start')}` }); await api.tick(); await api.confirmPairing(principal, BOT, { pairingId: link.pairingId }); return link; },
  };
}

describe('durable native Telegram service', () => {
  for (const stage of ['transcription', 'synthesis']) for (const action of ['stop', 'disconnect', 'rotate', 'revoke', 'purge', 'owner']) test(`${action} aborts and joins pending ${stage} even if its provider ignores cancellation`, async () => {
    const pending = deferred(); let signal; let finished = false;
    const f = fixture({ speech: {
      async transcribe(input) { if (stage !== 'transcription') return { text: 'Voice prompt' }; signal = input.signal; return pending.promise; },
      async synthesize(input) { signal = input.signal; return pending.promise; },
    } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } });
    if (stage === 'synthesis') { await f.api.tick(); f.complete(); }
    const first = f.api.tick().finally(() => { finished = true; });
    try {
      await waitFor(() => Boolean(signal));
      if (action === 'stop') await f.api.stop();
      else if (action === 'disconnect') await f.api.disconnect(principal, BOT);
      else if (action === 'rotate') await f.api.configure(principal, BOT, { enabled: true, token: `123456:${'b'.repeat(35)}` });
      else if (action === 'revoke') await f.api.revokePairing(principal, BOT);
      else if (action === 'purge') await f.api.purgeBot({ botId: BOT });
      else { f.state.owner = false; await f.api.tick(); }
      await waitFor(() => signal.aborted && finished);
      expect(f.state.enqueued).toHaveLength(stage === 'synthesis' ? 1 : 0);
      expect(f.state.sent.map((row) => row.method)).toEqual(stage === 'synthesis' ? ['sendMessage'] : []);
    } finally {
      pending.resolve(stage === 'transcription' ? { text: 'Late transcript' } : { bytes: Buffer.from('late audio'), contentType: 'audio/ogg' });
      await first; await f.api.stop();
    }
  });
  test('duplicate ticks do not retranscribe an in-flight voice job', async () => {
    const pending = deferred(); let calls = 0;
    const f = fixture({ speech: { async transcribe() { calls += 1; return pending.promise; } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } }); const first = f.api.tick();
    try {
      await waitFor(() => calls === 1);
      for (let index = 0; index < 4; index += 1) await f.api.tick();
      expect(calls).toBe(1); expect(f.state.enqueued).toHaveLength(0);
    } finally { pending.resolve({ text: 'One transcript' }); await first; await f.api.stop(); }
    expect(f.state.enqueued).toHaveLength(1);
  });
  test('a command cannot cancel a later request from the same Telegram update batch', async () => {
    const f = fixture(); await f.create(); await f.connect();
    f.update(2, { text: '/cancel' }); f.update(3, { text: 'A new request after cancellation' }); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(1); expect(f.state.cancelled).toHaveLength(0);
    expect(f.tables.inbox.find((row) => row.update_id === 3).cancel_requested_at).toBeNull();
  });
  test('cancelling an audio send already in flight surfaces uncertainty without replaying its text or audio', async () => {
    const f = fixture({ speech: { async transcribe() { return { text: 'Voice prompt' }; }, async synthesize() { return { bytes: Buffer.from('audio'), contentType: 'audio/ogg' }; } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } }); await f.api.tick(); f.complete(); await f.api.tick(); f.advance();
    let signal; const pending = deferred();
    f.state.sendWait = (method, transportSignal, response) => { if (method !== 'sendVoice') return response({ message_id: f.state.sent.length }); signal = transportSignal; return pending.promise; };
    const first = f.api.tick();
    try {
      await waitFor(() => Boolean(signal)); f.update(3, { text: '/cancel' }); await f.api.tick(); await first;
      expect(signal.aborted).toBe(true);
      expect(f.tables.outbox.find((row) => row.kind === 'voice')).toMatchObject({ state: 'uncertain', part_index: 1, error_code: 'telegram_voice_cancel_uncertain' });
      f.advance(); await f.api.tick();
      expect(f.state.sent.filter((row) => row.method === 'sendVoice')).toHaveLength(1);
      expect(f.state.sent.filter((row) => row.body.text === 'Verified answer')).toHaveLength(1);
      expect(f.state.sent.some((row) => row.body.text?.includes('may already have arrived'))).toBe(true);
    } finally { pending.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }))); await first; await f.api.stop(); }
  });
  test('a still-running older request does not starve reconciliation of a later finished request', async () => {
    const f = fixture(); await f.create(); await f.connect();
    f.update(2, { text: 'Still running' }); f.update(3, { text: 'Finishes first' }); await f.api.tick();
    f.tables.inbox.find((row) => row.update_id === 3).run_id = OTHER;
    f.complete(); f.state.runRows[0].id = OTHER;
    f.state.messageRows.find((row) => row.role === 'assistant').run_id = OTHER;
    f.state.runRows.unshift({ id: RUN, bot_id: BOT, channel_id: CHANNEL, state: 'running' });
    await f.api.tick(); await f.api.tick();
    expect(f.tables.inbox.find((row) => row.update_id === 3).state).toBe('settled');
    expect(f.state.sent.some((row) => row.body.text === 'Verified answer')).toBe(true);
  });
  test('an uncertain admission with no visible canonical row is never resubmitted, including after restart', async () => {
    const f = fixture(); await f.create(); await f.connect();
    f.dispatcher.enqueueMessage = async (input) => { f.state.enqueued.push(input); throw new Error('Admission response lost before canonical record becomes visible'); };
    f.update(2, { text: 'Never repeat a consequential request' }); await f.api.tick();
    expect(f.tables.inbox.find((row) => row.update_id === 2).state).toBe('admission_uncertain');
    for (let index = 0; index < 12; index += 1) { f.advance(61_000); await f.api.tick(); }
    await f.api.stop(); await f.create(); f.advance(61_000); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(1);
    f.state.messageRows.push({ id: f.state.enqueued[0].message.messageId, channel_id: CHANNEL, role: 'user', run_id: RUN });
    f.advance(2000); await f.api.tick();
    expect(f.tables.inbox.find((row) => row.update_id === 2)).toMatchObject({ state: 'admitted', run_id: RUN });
    expect(f.state.enqueued).toHaveLength(1);
  });
  test('a crash leaving durable admitting intent never proves that resubmission is safe', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'Possible execution' }); await f.api.tick();
    f.tables.inbox.find((row) => row.update_id === 2).state = 'admitting'; f.state.messageRows.length = 0;
    await f.api.stop(); await f.create(); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(1);
    expect(f.tables.inbox.find((row) => row.update_id === 2).state).toBe('admission_uncertain');
  });
  test('a lost cancellation response retains the exact run marker and retries cancellation without a new prompt', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'Cancel this execution' }); await f.api.tick(); f.complete({ state: 'running' });
    let attempts = 0;
    f.dispatcher.cancelRun = async (input) => { f.state.cancelled.push(input); attempts += 1; if (attempts === 1) throw new Error('Cancellation response lost'); f.state.runRows[0].state = 'cancelled'; };
    f.update(3, { text: '/cancel' }); await f.api.tick(); f.advance(5001); await f.api.tick();
    expect(attempts).toBe(2); expect(f.state.cancelled.every((input) => input.runId === RUN)).toBe(true);
    expect(f.state.enqueued).toHaveLength(1); expect(f.tables.inbox.find((row) => row.update_id === 2).cancel_requested_at).not.toBeNull();
    expect(f.tables.inbox.find((row) => row.update_id === 2).state).toBe('settled');
  });
  test('cancel follows a pending request that advances to admitted during its durable marker write', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.state.dispatcherReady = false; f.update(2, { text: 'Pending startup' }); await f.api.tick();
    f.state.dispatcherReady = true;
    const request = f.tables.inbox.find((row) => row.update_id === 2);
    const patch = f.repository.patch;
    f.repository.patch = async (name, keys, body) => {
      if (name === 'inbox' && keys.id === request.id && body.cancel_requested_at) {
        request.state = 'admitted'; request.run_id = RUN;
        f.state.runRows.push({ id: RUN, channel_id: CHANNEL, bot_id: BOT, state: 'running' });
      }
      return patch(name, keys, body);
    };
    f.dispatcher.cancelRun = async (input) => { f.state.cancelled.push(input); f.state.runRows[0].state = 'cancelled'; };
    f.update(3, { text: '/cancel' }); await f.api.tick();
    expect(f.state.cancelled).toHaveLength(1); expect(f.state.cancelled[0].runId).toBe(RUN);
    expect(request.cancel_requested_at).not.toBeNull(); expect(f.state.enqueued).toHaveLength(0);
  });
  test('voice cancellation retries authoritative state when synthesis finishes during its write', async () => {
    const f = fixture({ speech: { async transcribe() { return { text: 'Voice prompt' }; }, async synthesize() { return { bytes: Buffer.from('audio'), contentType: 'audio/ogg' }; } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } }); await f.api.tick(); f.complete(); await f.api.tick();
    const row = f.tables.outbox.find((entry) => entry.kind === 'voice'); row.state = 'synthesis_pending';
    const patch = f.repository.patch; let advanced = false;
    f.repository.patch = async (name, keys, body) => {
      if (name === 'outbox' && keys.id === row.id && body.state === 'cancelled' && !advanced) { advanced = true; row.state = 'pending'; }
      return patch(name, keys, body);
    };
    f.update(3, { text: '/cancel' }); await f.api.tick(); f.advance(); await f.api.tick();
    expect(advanced).toBe(true); expect(row.state).toBe('cancelled');
    expect(f.state.sent.filter((entry) => entry.method === 'sendVoice')).toHaveLength(0);
    expect(f.state.sent.filter((entry) => entry.body.text === 'Verified answer')).toHaveLength(1);
  });
  test('purge waits for an in-flight initial configuration and removes its late vault write', async () => {
    const f = fixture(); await f.create(); const pending = deferred(); let entered = false; let purged = false;
    const create = f.vault.create;
    f.vault.create = async (input) => { entered = true; await pending.promise; return create(input); };
    const configure = f.api.configure(principal, BOT, { enabled: true, token });
    await waitFor(() => entered);
    const purge = f.api.purgeBot({ botId: BOT }).finally(() => { purged = true; });
    await Promise.resolve(); expect(purged).toBe(false); pending.resolve();
    await Promise.all([configure, purge]);
    expect(f.tables.connections).toHaveLength(0); expect(f.credentialRows.size).toBe(0);
  });
  test('a large delivery backlog for one member cannot hide another member behind the first metadata page', async () => {
    const f = fixture(); await f.create(); await f.connect();
    const other = { ...principal, id: OTHER }; const link = await f.api.createPairing(other, BOT);
    f.update(2, { from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' }, text: `/start ${new URL(link.url).searchParams.get('start')}` });
    await f.api.tick(); await f.api.confirmPairing(other, BOT, { pairingId: link.pairingId });
    for (let index = 0; index < 31; index += 1) {
      const pairing = f.tables.pairings[index === 30 ? 1 : 0]; const id = `e5000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await f.repository.insert('outbox', { id, bot_id: BOT, generation: f.tables.connections[0].generation, pairing_id: pairing.id, user_id: pairing.user_id, channel_id: pairing.channel_id, source_key: `notice:${index}`, kind: 'notice', state: 'pending', part_index: 0,
        payload_envelope: encryptBotJson({ key: KEY, keyId: 'deployment-v1', associatedData: `devryan:telegram:outbox:${id}`, value: { parts: [{ type: 'text', text: index === 30 ? 'Other member result' : 'Backlog' }], voiceText: null } }) });
    }
    await f.api.tick();
    expect(f.state.sent.some((row) => row.body.chat_id === '456' && row.body.text === 'Other member result')).toBe(true);
  });
  test('bounded connection scans eventually visit Bots beyond the first hundred', async () => {
    const f = fixture(); await f.create(); await f.connect(); const visited = new Set();
    for (let index = 2; index <= 101; index += 1) f.tables.connections.push({ ...f.tables.connections[0], bot_id: `b4000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
    f.repository.lease = async (botId) => { visited.add(botId); return true; };
    await f.api.tick(); await f.api.tick();
    expect(visited.size).toBe(101);
  });
  test('sixteen occupied long-poll slots cannot phase-starve connections beyond the first hundred', async () => {
    const f = fixture(); await f.create(); await f.api.configure(principal, BOT, { enabled: true, token });
    const first = f.tables.connections[0]; const credential = f.credentialRows.get(first.credential_id);
    for (let index = 2; index <= 101; index += 1) {
      const botId = `b4000000-0000-4000-8000-${String(index).padStart(12, '0')}`; const id = `c5000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      f.tables.connections.push({ ...first, bot_id: botId, credential_id: id, telegram_bot_id: String(200000 + index) });
      f.credentialRows.set(id, { ...credential, id, botId, secret: { token: `${200000 + index}:${'a'.repeat(35)}` } });
    }
    let active = 0; let peak = 0; const polls = []; const visited = new Set();
    f.state.pollWait = (url, signal, response) => {
      visited.add(url.match(/\/bot(\d+):/)[1]); active += 1; peak = Math.max(peak, active);
      const pending = deferred(); let settled = false;
      const finish = () => { if (settled) return; settled = true; active -= 1; pending.resolve(response([])); };
      signal.addEventListener('abort', finish, { once: true }); polls.push(finish); return pending.promise;
    };
    try {
      for (let step = 0; step < 161; step += 1) {
        if (step > 0 && step % 20 === 0) { for (const finish of polls.splice(0)) finish(); await new Promise((resolve) => setImmediate(resolve)); }
        f.advance(1000); await f.api.tick({ pollTimeout: 20, waitForJobs: false }); await new Promise((resolve) => setImmediate(resolve));
      }
      expect(visited.size).toBe(101); expect(visited.has('200101')).toBe(true); expect(peak).toBeLessThanOrEqual(16);
    } finally { await f.api.stop(); for (const finish of polls.splice(0)) finish(); }
    expect(active).toBe(0);
  });
  test('a full ordinary inbox still admits cancellation and visibly rejects new work without executing it', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.complete({ state: 'running' });
    const connection = f.tables.connections[0]; const pairing = f.tables.pairings[0];
    for (let index = 0; index < 1000; index += 1) await f.repository.insert('inbox', {
      id: `f6000000-0000-4000-8000-${String(index).padStart(12, '0')}`, bot_id: BOT, generation: connection.generation, pairing_id: pairing.id, user_id: USER, channel_id: CHANNEL,
      update_id: index + 2, message_id: `e6000000-0000-4000-8000-${String(index).padStart(12, '0')}`, run_id: RUN, request_kind: 'message', state: 'admitted', payload_envelope: {}, next_attempt_at: '2026-09-01T00:00:00.000Z',
    });
    f.dispatcher.cancelRun = async (input) => { f.state.cancelled.push(input); f.state.runRows[0].state = 'cancelled'; };
    f.update(1002, { text: 'Must be refused, not silently lost or executed' }); f.update(1003, { text: '/cancel' }); await f.api.tick();
    expect(connection.update_offset).toBe(1004); expect(f.state.cancelled.some((input) => input.runId === RUN)).toBe(true); expect(f.state.enqueued).toHaveLength(0);
    const rejected = f.tables.inbox.find((row) => row.update_id === 1002);
    expect(rejected.error_code).toBe('telegram_inbox_limit'); expect(f.decode('inbox', rejected)).toEqual({ update: { update_id: 1002 } });
    await f.api.stop(); await f.create(); // Durable refusal notices survive restart before delivery.
    f.advance(); await f.api.tick(); f.advance(); await f.api.tick();
    expect(f.state.sent.some((row) => row.body.text?.includes('queue is full'))).toBe(true);
    expect(f.state.enqueued).toHaveLength(0);
  });
  test('command capacity is bounded and a refused command gets an explicit retry notice', async () => {
    const f = fixture(); await f.create(); await f.connect(); const connection = f.tables.connections[0]; const pairing = f.tables.pairings[0];
    for (let index = 0; index < 100; index += 1) await f.repository.insert('inbox', { id: `f7000000-0000-4000-8000-${String(index).padStart(12, '0')}`, bot_id: BOT, generation: connection.generation, pairing_id: pairing.id, user_id: USER, channel_id: CHANNEL, update_id: index + 2, message_id: `e7000000-0000-4000-8000-${String(index).padStart(12, '0')}`, request_kind: 'command', state: 'ready', payload_envelope: {}, next_attempt_at: '2026-09-01T00:00:00.000Z' });
    f.update(102, { text: '/cancel' }); await f.api.tick();
    expect(f.tables.inbox.find((row) => row.update_id === 102)).toMatchObject({ state: 'rejected', error_code: 'telegram_control_limit' });
    expect(f.state.sent.some((row) => row.body.text?.includes('This command was not performed'))).toBe(true);
    expect(f.state.cancelled).toHaveLength(0); expect(f.state.enqueued).toHaveLength(0);
  });
  test('responsiveness: a pending voice transcription can be cancelled before Bot admission', async () => {
    const pending = deferred(); let entered = false; let aborted = false;
    const f = fixture({ speech: { async transcribe({ signal }) {
      entered = true;
      return Promise.race([pending.promise, new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('cancelled'), { code: 'bot_voice_cancelled' })); }, { once: true }))]);
    } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } });
    const first = f.api.tick(); let second;
    try {
      await waitFor(() => entered); f.update(3, { text: '/cancel' }); second = f.api.tick();
      await waitFor(() => aborted);
      expect(f.state.enqueued).toHaveLength(0);
    } finally { pending.resolve({ text: 'Too late to admit' }); await Promise.allSettled([first, second]); await f.api.stop(); }
  });
  test('responsiveness: slow optional speech never blocks a later text request', async () => {
    const pending = deferred(); let entered = false;
    const f = fixture({ speech: { async transcribe() { return { text: 'voice request' }; }, async synthesize() { entered = true; return pending.promise; } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } }); await f.api.tick(); f.complete();
    const first = f.api.tick(); let second;
    try {
      await waitFor(() => entered); f.update(3, { text: 'Respond independently' }); second = f.api.tick();
      await waitFor(() => f.state.enqueued.length === 2);
      expect(f.state.enqueued[1].message.text).toBe('Respond independently');
    } finally { pending.resolve({ bytes: Buffer.from('audio'), contentType: 'audio/ogg' }); await Promise.allSettled([first, second]); await f.api.stop(); }
  });
  test('responsiveness: another pairing cannot cancel a pending media download and its text still proceeds', async () => {
    const f = fixture(); await f.create(); await f.connect();
    const other = { ...principal, id: OTHER }; const link = await f.api.createPairing(other, BOT);
    const fromOther = { from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' } };
    f.update(2, { ...fromOther, text: `/start ${new URL(link.url).searchParams.get('start')}` }); await f.api.tick(); await f.api.confirmPairing(other, BOT, { pairingId: link.pairingId });
    let entered = false; let aborted = false; const pending = deferred();
    f.state.downloadWait = (signal) => { entered = true; return Promise.race([pending.promise, new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }))]); };
    f.update(3, { document: { file_id: 'file_1' } }); const first = f.api.tick();
    try {
      await waitFor(() => entered);
      f.update(4, { ...fromOther, text: '/cancel' }); await f.api.tick(); expect(aborted).toBe(false);
      f.update(5, { ...fromOther, text: 'Other member text' }); await f.api.tick();
      expect(f.state.enqueued).toHaveLength(1); expect(f.state.enqueued[0]).toMatchObject({ principal: { id: OTHER }, channelId: OTHER_CHANNEL });
      f.update(6, { text: '/cancel' }); await f.api.tick(); await waitFor(() => aborted);
      expect(f.state.enqueued).toHaveLength(1); expect(f.state.upload).toHaveLength(0);
    } finally { pending.resolve(new Response('late media')); await first; await f.api.stop(); }
  });
  test('responsiveness: cancelling synthesis preserves verified text and never repeats it', async () => {
    const pending = deferred(); let entered = false; let aborted = false;
    const f = fixture({ speech: { async transcribe() { return { text: 'Voice prompt' }; }, async synthesize({ signal }) {
      entered = true;
      return Promise.race([pending.promise, new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('speech cancelled')); }, { once: true }))]);
    } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } }); await f.api.tick(); f.complete(); const first = f.api.tick();
    try {
      await waitFor(() => entered); expect(f.state.sent[0].body.text).toBe('Verified answer');
      f.update(3, { text: '/cancel' }); await f.api.tick(); await waitFor(() => aborted);
      expect(f.tables.outbox.find((row) => row.kind === 'voice')).toMatchObject({ state: 'cancelled', part_index: 1 });
      expect(f.state.sent.filter((entry) => entry.body.text === 'Verified answer')).toHaveLength(1);
      expect(f.state.enqueued).toHaveLength(1);
    } finally { pending.resolve({ bytes: Buffer.from('audio'), contentType: 'audio/ogg' }); await first; await f.api.stop(); }
  });
  for (const responseLost of [false, true]) test(`cancelled uncertain admission reconciles only to cancellation (response lost: ${responseLost})`, async () => {
    const f = fixture(); await f.create(); await f.connect(); const pending = deferred();
    f.dispatcher.enqueueMessage = async (input) => {
      f.state.enqueued.push(clone(input)); await pending.promise;
      f.state.messageRows.push({ id: input.message.messageId, channel_id: input.channelId, role: 'user', run_id: RUN });
      f.state.runRows.push({ id: RUN, channel_id: CHANNEL, bot_id: BOT, state: 'running' });
      if (responseLost) throw new Error('Lost admission response');
      return { run: { id: RUN } };
    };
    f.dispatcher.cancelRun = async (input) => { f.state.cancelled.push(input); f.state.runRows.find((run) => run.id === input.runId).state = 'cancelled'; };
    f.update(2, { text: 'Admit at most once' }); const first = f.api.tick();
    try {
      await waitFor(() => f.state.enqueued.length === 1); f.update(3, { text: '/cancel' }); await f.api.tick();
      expect(f.tables.inbox.find((row) => row.update_id === 2)).toMatchObject({ state: 'admission_uncertain', error_code: 'telegram_cancel_requested' });
      pending.resolve(); await first; f.advance(6000); await f.api.tick();
      expect(f.state.enqueued).toHaveLength(1); expect(f.state.cancelled).toHaveLength(1);
      expect(f.state.cancelled[0]).toMatchObject({ runId: RUN, principal: { id: USER } });
    } finally { pending.resolve(); await first; await f.api.stop(); }
  });
  test('disabled by default, secrets stay in host vault and public responses are metadata only', async () => {
    const f = fixture(); await f.create();
    expect(await f.api.status(principal, BOT)).toMatchObject({ enabled: false, configured: false, state: 'disabled' });
    await f.connect();
    expect(f.credentialRows.size).toBe(1);
    expect(JSON.stringify(f.tables)).not.toContain(token);
    expect(JSON.stringify(await f.api.status(principal, BOT))).not.toContain(token);
    expect((await f.api.status(principal, BOT)).pairing).toMatchObject({ state: 'confirmed', telegramUserId: '123' });
  });
  test('manager-only configuration and member-bound pairing confirmation', async () => {
    const f = fixture(); await f.create(); await f.api.configure(principal, BOT, { enabled: true, token });
    f.state.manager = false;
    await expect(f.api.configure(principal, BOT, { enabled: false })).rejects.toMatchObject({ statusCode: 403 });
    const link = await f.api.createPairing(principal, BOT); f.update(1, { text: `/start ${new URL(link.url).searchParams.get('start')}` }); await f.api.tick();
    await expect(f.api.confirmPairing({ ...principal, id: OTHER }, BOT, { pairingId: link.pairingId })).rejects.toMatchObject({ code: 'telegram_pairing_expired' });
    await f.api.confirmPairing(principal, BOT, { pairingId: link.pairingId });
    await expect(f.api.confirmPairing(principal, BOT, { pairingId: link.pairingId })).rejects.toMatchObject({ code: 'telegram_pairing_expired' });
  });
  test('global managers without membership can configure metadata but cannot pair, read deliveries or execute requests', async () => {
    const f = fixture(); await f.create(); await f.connect();
    f.update(2, { text: 'Must not execute after membership ends' });
    f.state.membership = false;
    f.tables.outbox.push({ id: RESULT, bot_id: BOT, user_id: OTHER, state: 'uncertain', kind: 'result' });
    expect(await f.api.status(principal, BOT)).toMatchObject({ configured: true, canPair: false, pairing: null, deliveries: [] });
    await expect(f.api.createPairing(principal, BOT)).rejects.toMatchObject({ code: 'bot_membership_required' });
    await expect(f.api.deliveries(principal, BOT)).rejects.toMatchObject({ code: 'bot_membership_required' });
    await expect(f.api.retryDelivery(principal, BOT, { deliveryId: RESULT })).rejects.toMatchObject({ code: 'bot_membership_required' });
    await expect(f.api.setPreferences(principal, BOT, { routineDelivery: true, voiceReplies: true })).rejects.toMatchObject({ code: 'bot_membership_required' });
    await f.api.tick();
    expect(f.state.enqueued).toHaveLength(0);
    expect(await f.api.configure(principal, BOT, { enabled: false })).toMatchObject({ enabled: false, canPair: false });
    expect(await f.api.disconnect(principal, BOT)).toMatchObject({ configured: false, canPair: false });
    f.state.manager = false;
    await expect(f.api.status(principal, BOT)).rejects.toMatchObject({ statusCode: 403 });
  });
  test('disconnect revalidates manager authority after waiting for the saved connection', async () => {
    const f = fixture(); await f.create(); await f.connect();
    const get = f.repository.get;
    f.repository.get = async (name, keys) => {
      const row = await get(name, keys);
      if (name === 'connections') f.state.manager = false;
      return row;
    };
    await expect(f.api.disconnect(principal, BOT)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.tables.connections[0].enabled).toBe(true);
    expect([...f.credentialRows.values()].every((row) => !row.revoked)).toBe(true);
  });
  test('membership revocation during the durable admission transition cannot submit a prompt', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'Stop before admission' });
    const patch = f.repository.patch;
    f.repository.patch = async (name, keys, body) => {
      const row = await patch(name, keys, body);
      if (name === 'inbox' && body.state === 'admitting') f.state.membership = false;
      return row;
    };
    await f.api.tick();
    expect(f.state.enqueued).toHaveLength(0);
    expect(f.tables.inbox.find((row) => row.update_id === 2).state).toBe('rejected');
  });
  for (const change of ['pairing', 'generation']) test(`${change} revocation during the durable delivery transition cannot send old output`, async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'Prepare output' }); await f.api.tick(); f.complete();
    const patch = f.repository.patch;
    f.repository.patch = async (name, keys, body) => {
      const row = await patch(name, keys, body);
      if (name === 'outbox' && body.state === 'sending') {
        if (change === 'pairing') f.tables.pairings[0].state = 'revoked';
        else f.tables.connections[0].generation = OTHER;
      }
      return row;
    };
    await f.api.tick();
    expect(f.state.sent).toHaveLength(0);
    expect(f.state.enqueued).toHaveLength(1);
    const row = f.tables.outbox.find((entry) => entry.kind === 'result');
    expect(row.state).toBe('cancelled');
    await expect(f.api.retryDelivery(principal, BOT, { deliveryId: row.id })).rejects.toMatchObject({ code: 'telegram_delivery_not_retryable' });
  });
  test('a former owner cannot resend a part another owner advanced during its slow preparation', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'Prepare two parts' }); await f.api.tick(); f.complete({ text: `${'a'.repeat(4000)}Second part` });
    const patch = f.repository.patch; let advanced = false;
    f.repository.patch = async (name, keys, body) => {
      if (name === 'outbox' && body.state === 'sending' && !advanced) {
        advanced = true;
        f.tables.outbox.find((row) => row.id === keys.id).part_index = 1;
      }
      return patch(name, keys, body);
    };
    await f.api.tick(); expect(f.state.sent).toHaveLength(0);
    await f.api.tick(); expect(f.state.sent).toHaveLength(1);
    expect(f.state.sent[0].body.text).toBe('Second part');
    expect(f.state.enqueued).toHaveLength(1);
  });
  test('losing the database lease during a durable send transition defers delivery without replaying execution', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'Prepare output' }); await f.api.tick(); f.complete();
    const patch = f.repository.patch; let leaseAvailable = true; let interrupted = false;
    f.repository.lease = async () => leaseAvailable;
    f.repository.patch = async (name, keys, body) => {
      const row = await patch(name, keys, body);
      if (name === 'outbox' && body.state === 'sending' && !interrupted) { interrupted = true; leaseAvailable = false; }
      return row;
    };
    await f.api.tick(); expect(f.state.sent).toHaveLength(0);
    expect(f.tables.outbox.find((row) => row.kind === 'result')).toMatchObject({ state: 'pending', error_code: 'telegram_owner_unavailable' });
    leaseAvailable = true; f.advance(31_000); await f.api.tick();
    expect(f.state.sent).toHaveLength(1); expect(f.state.enqueued).toHaveLength(1);
  });
  test('pairing replay cannot replace the first numeric candidate', async () => {
    const f = fixture(); await f.create(); await f.api.configure(principal, BOT, { enabled: true, token }); const link = await f.api.createPairing(principal, BOT);
    const text = `/start ${new URL(link.url).searchParams.get('start')}`;
    f.update(1, { text }); f.update(2, { text, from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' } }); await f.api.tick();
    expect(f.tables.pairings[0].telegram_user_id).toBe('123'); expect(f.tables.pairings[0].nonce_hash).toBeNull();
  });
  test('only linked private numeric identities can admit messages; groups and strangers are rejected', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'group', chat: { id: -123, type: 'group' } }); f.update(3, { text: 'stranger', from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' } });
    await f.api.tick(); expect(f.state.enqueued).toHaveLength(0); expect(f.tables.inbox.slice(1).every((row) => row.state === 'rejected')).toBe(true);
  });
  test('failed durable ingress never advances the acknowledgment offset', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'Hello' }); f.state.failIngest = true;
    await f.api.tick(); expect(f.tables.connections[0].update_offset).toBe(2); expect(f.state.enqueued).toHaveLength(0);
    f.state.failIngest = false; f.advance(5000); await f.api.tick(); expect(f.tables.connections[0].update_offset).toBe(3); expect(f.state.enqueued).toHaveLength(1);
  });
  test('duplicate updates and lost admission responses reconcile the canonical message without rerunning', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.state.admissionFailure = true; f.update(2, { text: 'Do this once' });
    await f.api.tick(); f.advance(5000); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(1); expect(f.tables.inbox.find((row) => row.update_id === 2)).toMatchObject({ state: 'admitted', run_id: RUN });
    expect(f.state.enqueued[0]).toMatchObject({ channelId: CHANNEL, message: { text: 'Do this once' } });
  });
  test('old unadmitted updates expire without performing the action', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'old request' }); f.advance(16 * 60_000); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(0); expect(f.tables.inbox.find((row) => row.update_id === 2).error_code).toBe('telegram_request_expired'); expect(f.state.sent[0].body.text).toContain('expired');
  });
  for (const stage of ['transcription', 'admitting']) test(`an unadmitted request expires after slow ${stage} crosses its original deadline`, async () => {
    let transcriptions = 0;
    const f = fixture({ speech: { async transcribe() { transcriptions += 1; f.advance(2000); return { text: 'Actual but now expired transcript' }; } } });
    await f.create(); await f.connect();
    f.update(2, stage === 'transcription' ? { voice: { file_id: 'file_1', duration: 5 } } : { text: 'Do not admit after the deadline' });
    f.advance(14 * 60_000 + 59_000);
    if (stage === 'admitting') {
      const patch = f.repository.patch;
      f.repository.patch = async (name, keys, body) => {
        const row = await patch(name, keys, body);
        if (name === 'inbox' && body.state === 'admitting') f.advance(2000);
        return row;
      };
    }
    await f.api.tick(); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(0);
    expect(transcriptions).toBe(stage === 'transcription' ? 1 : 0);
    expect(f.tables.inbox.find((row) => row.update_id === 2)).toMatchObject({ state: 'rejected', error_code: 'telegram_request_expired' });
    expect(f.state.sent).toHaveLength(1);
    expect(f.state.sent[0].body.text).toContain('Please resend');
  });
  test('a durably admitted request remains reconcilable after the unadmitted expiry deadline', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.state.admissionFailure = true; f.update(2, { text: 'Already admitted exactly once' });
    await f.api.tick(); f.advance(16 * 60_000); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(1);
    expect(f.tables.inbox.find((row) => row.update_id === 2)).toMatchObject({ state: 'admitted', run_id: RUN });
    expect(f.state.sent).toHaveLength(0);
  });
  test('delivers only the persisted finalized result and attaches generated files', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'hello' }); await f.api.tick(); expect(f.state.sent).toHaveLength(0);
    f.complete({ attachmentIds: [OBJECT] }); await f.api.tick(); expect(f.state.sent[0].body.text).toBe('Verified answer'); f.advance(); await f.api.tick(); expect(f.state.sent.map((row) => row.method)).toEqual(['sendMessage', 'sendDocument']);
    expect(f.tables.outbox[0].state).toBe('delivered');
    expect(JSON.stringify(f.tables)).not.toContain('Verified answer');
  });
  test('a crash after Telegram accepts a part surfaces uncertainty and never automatically repeats it', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'hello' }); await f.api.tick(); f.complete(); f.state.crashAfterSend = true; await f.api.tick();
    expect(f.state.sent).toHaveLength(1); expect(f.tables.outbox[0].state).toBe('uncertain'); f.advance(); await f.api.tick(); expect(f.state.sent).toHaveLength(1);
    const reply = await f.api.retryDelivery(principal, BOT, { deliveryId: f.tables.outbox[0].id }); expect(reply.mayDuplicateLastPart).toBe(true); await f.api.tick(); expect(f.state.enqueued).toHaveLength(1); expect(f.state.sent).toHaveLength(2);
  });
  test('membership revocation and link replacement prevent pending egress', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'hello' }); await f.api.tick(); f.complete(); f.state.transportFailure = true; await f.api.tick(); expect(f.tables.outbox[0].state).toBe('uncertain');
    await f.api.revokePairing(principal, BOT); await expect(f.api.retryDelivery(principal, BOT, { deliveryId: f.tables.outbox[0].id })).rejects.toMatchObject({ code: 'telegram_pairing_revoked' });
    f.state.active = false; await expect(f.api.status(principal, BOT)).rejects.toMatchObject({ statusCode: 403 });
  });
  test('token rotation fences old work and stored metadata cannot expose plaintext', async () => {
    const f = fixture(); await f.create(); await f.connect(); const generation = f.tables.connections[0].generation;
    await f.api.configure(principal, BOT, { enabled: true, token: `123456:${'b'.repeat(35)}` });
    expect(f.tables.connections[0].generation).not.toBe(generation); expect((await f.api.status(principal, BOT)).pairing).toBeNull(); expect([...f.credentialRows.values()][0].revoked).toBe(true);
  });
  test('waiting-control and approval prompts direct the user to authenticated DevRyan', async () => {
    for (const runState of ['waiting_approval', 'waiting_control', 'needs_reconciliation']) {
      const f = fixture(); await f.create(); await f.connect(); f.update(2, { text: 'hello' }); await f.api.tick(); f.complete({ state: runState }); await f.api.tick(); expect(f.state.sent[0].body.text).toContain('authenticated DevRyan');
    }
  });
  test('photos and documents enter the same private attachment admission path', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.update(2, { caption: 'inspect', document: { file_id: 'file_1', mime_type: 'text/plain', file_name: '../input.txt', file_size: 5 } }); await f.api.tick();
    expect(f.state.upload[0]).toMatchObject({ botId: BOT, channelId: CHANNEL, contentType: 'text/plain', provenance: { source: 'telegram', filename: '.._input.txt' } }); expect(f.state.enqueued[0].message.attachmentIds).toEqual([OBJECT]);
  });
  test('voice is transcribed once and text is delivered before its optional audio', async () => {
    const operations = []; const f = fixture({ speech: { async transcribe(input) { operations.push(['transcribe', input]); return { text: 'Actual transcript' }; }, async synthesize(input) { operations.push(['synthesize', input]); expect(f.state.sent[0].body.text).toBe('Verified answer'); return { bytes: Buffer.from('audio'), contentType: 'audio/ogg' }; } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5, mime_type: 'audio/ogg' } }); await f.api.tick(); f.complete(); await f.api.tick(); f.advance(); await f.api.tick();
    expect(f.state.enqueued[0].message.text).toBe('Actual transcript'); expect(operations.map((row) => row[0])).toEqual(['transcribe', 'synthesize']); expect(f.state.sent.map((row) => row.method)).toEqual(['sendMessage', 'sendVoice']);
  });
  test('empty or failed voice transcription never invents a prompt', async () => {
    const f = fixture({ speech: { async transcribe() { return { text: ' ' }; } } }); await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } }); await f.api.tick(); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(0); expect(f.tables.inbox.find((row) => row.update_id === 2).error_code).toBe('telegram_transcription_empty');
  });
  test('routine completion requires explicit subscription and never mirrors ordinary desktop runs', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.complete({ routine: { id: 'routine' } }); const run = f.state.runRows[0]; await f.api.notifyRoutineCompleted({ run }); expect(f.tables.outbox).toHaveLength(0);
    await f.api.setPreferences(principal, BOT, { routineDelivery: true, voiceReplies: true }); await f.api.notifyRoutineCompleted({ run }); expect(f.tables.outbox).toHaveLength(1);
    await f.api.notifyRoutineCompleted({ run: { ...run, id: 'not-a-routine', context_snapshot: {} } }); expect(f.tables.outbox).toHaveLength(1);
  });
  test('purge deletes transport state and its separate host credentials', async () => {
    const f = fixture(); await f.create(); await f.connect(); await f.api.purgeBot({ botId: BOT }); expect(f.tables.connections).toHaveLength(0); expect(f.tables.pairings).toHaveLength(0); expect(f.credentialRows.size).toBe(0);
  });
  test('expired pairing links cannot be confirmed or acquire a candidate', async () => {
    const f = fixture(); await f.create(); await f.api.configure(principal, BOT, { enabled: true, token }); const link = await f.api.createPairing(principal, BOT);
    f.advance(11 * 60_000); f.update(1, { text: `/start ${new URL(link.url).searchParams.get('start')}` }); await f.api.tick();
    expect(f.tables.pairings[0].state).toBe('pending'); await expect(f.api.confirmPairing(principal, BOT, { pairingId: link.pairingId })).rejects.toMatchObject({ code: 'telegram_pairing_expired' });
  });
  test('an uncertain previous transcription is not sent to speech again after restart', async () => {
    let calls = 0; const f = fixture({ speech: { async transcribe() { calls += 1; return { text: 'Should never run' }; } } }); await f.create(); await f.connect();
    f.update(2, { voice: { file_id: 'file_1', duration: 5 } });
    // Commit the durable state that survives a crash while external transcription is in progress.
    const connection = f.tables.connections[0]; const pairing = f.tables.pairings[0];
    await f.repository.insert('inbox', { id: RESULT, bot_id: BOT, generation: connection.generation, update_id: 2, pairing_id: pairing.id, user_id: USER, channel_id: CHANNEL, message_id: OBJECT, state: 'transcribing', payload_envelope: {} });
    f.state.updates = [];
    await f.api.tick(); expect(calls).toBe(0); expect(f.state.enqueued).toHaveLength(0); expect(f.tables.inbox.find((row) => row.id === RESULT).error_code).toBe('telegram_transcription_uncertain');
  });
  test('voice length and empty/unsupported media fail before admitting a request', async () => {
    let calls = 0; const f = fixture({ speech: { async transcribe() { calls += 1; return { text: 'no' }; } } }); await f.create(); await f.connect();
    f.update(2, { voice: { file_id: 'file_1', duration: 301 } }); await f.api.tick(); expect(calls).toBe(0); expect(f.state.enqueued).toHaveLength(0); expect(f.tables.inbox.find((row) => row.update_id === 2).error_code).toBe('telegram_voice_duration_limit');
  });
  test('speech failure leaves successful text delivered and retries no Bot execution', async () => {
    let syntheses = 0; const f = fixture({ speech: { async transcribe() { return { text: 'voice prompt' }; }, async synthesize() { syntheses += 1; throw Object.assign(new Error('speech down'), { code: 'bot_voice_provider_failed' }); } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } }); await f.api.tick(); f.complete(); await f.api.tick();
    expect(f.state.sent).toHaveLength(1); expect(f.tables.outbox[0]).toMatchObject({ state: 'uncertain', part_index: 1, error_code: 'bot_voice_provider_failed' });
    f.advance(); await f.api.tick(); expect(syntheses).toBe(1); expect(f.state.enqueued).toHaveLength(1); expect(f.state.sent).toHaveLength(1);
  });
  test('full long text remains intact and audio-limit notice does not call synthesis', async () => {
    let syntheses = 0; const f = fixture({ speech: { async transcribe() { return { text: 'voice prompt' }; }, async synthesize() { syntheses += 1; return { bytes: Buffer.from('audio'), contentType: 'audio/ogg' }; } } });
    await f.create(); await f.connect(); f.update(2, { voice: { file_id: 'file_1', duration: 5 } }); await f.api.tick(); f.complete({ text: 'x'.repeat(4100) });
    await f.api.tick(); f.advance(); await f.api.tick(); f.advance(); await f.api.tick();
    expect(f.state.sent[0].body.text + f.state.sent[1].body.text).toBe('x'.repeat(4100)); expect(f.state.sent[2].body.text).toContain('4,000'); expect(syntheses).toBe(0);
  });
  test('fenced owner loss blocks ingress and egress without affecting member configuration reads', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.state.owner = false; f.update(2, { text: 'do not admit' }); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(0); expect(f.state.sent).toHaveLength(0); expect((await f.api.status(principal, BOT)).enabled).toBe(true);
  });
  test('purge tolerates the optional missing migration but propagates real storage failures', async () => {
    const f = fixture(); await f.create(); await f.connect();
    f.repository.get = async () => { throw { code: '42P01' }; };
    await f.api.purgeBot({ botId: BOT }); expect(f.credentialRows.size).toBe(0);
    const offline = fixture(); await offline.create(); await offline.connect();
    offline.repository.get = async () => { throw new Error('database offline'); };
    await expect(offline.api.purgeBot({ botId: BOT })).rejects.toThrow('database offline'); expect(offline.credentialRows.size).toBeGreaterThan(0);
  });
  test('optional migration absence is reported only in Telegram metadata', async () => {
    const f = fixture(); await f.create(); f.repository.get = async () => { throw { code: 'PGRST205' }; };
    expect(await f.api.status(principal, BOT)).toMatchObject({ enabled: false, state: 'migration_required', requiredMigration: 'bot_telegram_transport' });
  });
  test('stopped service does no work and can start again under its owner', async () => {
    const f = fixture(); await f.create(); await f.connect(); await f.api.stop(); const calls = f.state.calls.length;
    f.update(2, { text: 'after restart' }); await f.api.tick(); expect(f.state.calls.length).toBe(calls);
    f.api.start(); await new Promise((resolve) => setTimeout(resolve, 25)); await f.api.stop();
    expect(f.state.calls.length).toBeGreaterThan(calls);
  });
  test('startup without a dispatcher defers unadmitted requests and recovers without duplicate work', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.state.dispatcherReady = false; f.update(2, { text: 'please wait for startup' }); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(0); expect(f.tables.inbox.find((row) => row.update_id === 2)).toMatchObject({ state: 'ready', error_code: 'telegram_runtime_unavailable' });
    expect((await f.api.status(principal, BOT)).executionReady).toBe(false);
    f.state.dispatcherReady = true; f.advance(5001); await f.api.tick(); expect(f.state.enqueued).toHaveLength(1); expect(f.tables.inbox.find((row) => row.update_id === 2).state).toBe('admitted');
  });
  test('startup retries retain the original fifteen-minute expiration', async () => {
    const f = fixture(); await f.create(); await f.connect(); f.state.dispatcherReady = false; f.update(2, { text: 'expire safely' }); await f.api.tick(); f.advance(16 * 60_000); await f.api.tick();
    expect(f.state.enqueued).toHaveLength(0); expect(f.tables.inbox.find((row) => row.update_id === 2)).toMatchObject({ state: 'rejected', error_code: 'telegram_request_expired' });
  });
});
