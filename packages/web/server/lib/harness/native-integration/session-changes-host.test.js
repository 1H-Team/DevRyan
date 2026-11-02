import { afterEach, beforeEach, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionChangeHost } from '../../../../../harness-runtime/lib/session-changes-host.js';
import { withCrossProcessFileLock } from '../../../../../harness-runtime/lib/atomic-file.js';
import { createSessionMutationRuntime } from '../../../../../harness-runtime/lib/session-mutations.js';
import { changeKey, openChangeStore } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { createNativeConsumerFixture } from '../../opencode/test-native-consumer-client.js';

const createFixtureHost = options => createSessionChangeHost({ ...options, openCodeClient: options.openCodeClient ?? createNativeConsumerFixture({ readFixture: options.fetchImpl }) });

// These are real Git/metadata integration tests, with the same outer budget
// as session-changes.test.js; protocol deadlines remain independently tested.
const test = (name, run) => bunTest(name, run, 60_000);

let base, directory, host, messages, statuses, events;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-change-host-'));
  directory = path.join(base, 'repo'); await fs.mkdir(directory);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  messages = [{ info: { id: 'user_1', role: 'user', time: { created: 1 } }, parts: [] }]; statuses = {}; events = [];
  host = createFixtureHost({ dataDirectory: base, buildOpenCodeUrl: (pathname) => `http://fixture${pathname}`,
    publishEvent: (event) => events.push(event),
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      let payload;
      if (url.pathname === '/session/status') payload = statuses;
      else if (url.pathname.endsWith('/message')) payload = messages;
      else if (url.pathname.endsWith('/children')) payload = [];
      else payload = { id: 'ses_a', directory };
      return new Response(JSON.stringify(payload));
    },
  });
});
afterEach(async () => { await host.drain(); await fs.rm(base, { recursive: true, force: true }); }, 30_000);
const endpoint = (action = '') => `/api/devryan/session/ses_a/changes${action}?directory=${encodeURIComponent(directory)}`;
const tool = (callID) => ({ info: { id: `msg_${callID}`, parentID: 'user_1', role: 'assistant', time: { created: 2 } },
  parts: [{ id: `part_${callID}`, type: 'tool', callID, tool: 'bash', state: { status: 'completed' } }] });

test('private hook receipts feed summary and diff; mutation requires native ownership', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  const record = tool('call_a'); record.parts[0].tool = 'write'; record.parts[0].state.input = { filePath: 'shell.txt' };
  messages.push(record);
  const input = { sessionID: 'ses_a', directory, callID: 'call_a' };
  await host.plugin({ ...input, action: 'before' });
  await fs.writeFile(path.join(directory, 'shell.txt'), 'from shell\n');
  record.parts[0].state.metadata = { filediff: { file: 'shell.txt', before: null, after: 'from shell\n' } };
  await host.plugin({ ...input, action: 'after' });
  const result = await host.handleRequest('GET', endpoint());
  expect(result.status).toBe(200); expect(result.body.coverage).toBe('complete');
  expect(events[0].type).toBe('session.changes.updated');
  const revision = result.body.revision;
  const diff = await host.handleRequest('GET', `${endpoint('/diff')}&revision=${revision}&file=shell.txt`);
  expect(diff.body.patch).toContain('+from shell');
  expect(await host.handleRequest('POST', endpoint('/undo'), { revision })).toMatchObject({ status: 409, body: { code: 'mutation_runtime_unsupported' } });
  expect(await fs.readFile(path.join(directory, 'shell.txt'), 'utf8')).toBe('from shell\n');
  expect((await host.handleRequest('POST', endpoint('/redo'), { revision })).status).toBe(409);
});

test('missing hooks cannot report complete coverage after a successful prompt registration', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  messages.push(tool('missing'));
  const result = await host.handleRequest('GET', endpoint());
  expect(result.body.coverage).toBe('partial'); expect(result.body.reasons).toContain('missing_capture');
  expect(result.body.files).toEqual([]);
});

test('plan reads require a durable call-bound reviewed effect', async () => {
  const mutations = createSessionMutationRuntime({ directory: path.join(base, 'mutations') });
  const record = tool('plan_one'); record.parts[0].tool = 'devryan_plan_read'; messages.push(record);
  const owned = hostWithOutcomes(input => mutations.executionOutcomes(input));
  expect((await owned.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'] });
  const scope = { directory, sessionID: 'ses_a', userMessageID: 'user_1', messageID: 'msg_plan_one', callID: 'plan_one' };
  const origin = { kind: 'plugin', id: 'devryan.managed-task', manifestDigest: 'a'.repeat(64), capabilities: ['managed-task'] };
  const lease = await mutations.begin({ ...scope, kind: 'control' });
  await mutations.claimLease({ directory, token: lease.token, kind: 'control' });
  await mutations.finish({ directory, token: lease.token, effect: { tool: 'devryan_plan_read', origin, reviewedOrigin: origin } });
  expect((await owned.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'complete', reasons: [], fileCount: 0 });
  const storage = path.join(base, 'harness', 'session-changes');
  const db = await openChangeStore(storage, path.join(storage, changeKey(await fs.realpath(directory)), 'git'));
  expect(await db.get(`operations/${changeKey('ses_a\0plan_one')}.json`)).toBeNull();
  const unknown = tool('unknown'); unknown.parts[0].tool = 'unknown_plan_read'; messages.push(unknown);
  expect((await owned.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'] });
  await owned.drain();
});

test('Cursor aliases require the exact confined outer receipt, not a metadata-only claim', async () => {
  const record = tool('outer'); record.info.providerID = 'cursor-acp'; record.parts[0].tool = 'cursor_sdk';
  record.parts.push({ id: 'part_reader', type: 'tool', callID: 'reader', tool: 'read', state: { status: 'completed' } });
  messages.push(record);
  await host.recordReceipt({ directory, sessionID: 'ses_a', userMessageID: 'user_1', messageID: record.info.id,
    callID: 'outer', source: 'opencode', tool: 'cursor_sdk', files: [{ path: 'x', before: null, after: 'claimed' }] });
  const owned = hostWithOutcomes(async ({ sessionID, calls }) => calls.map(call => ({ ...call, sessionID,
    outcome: 'uncertain', ...(call.callID === 'reader' ? { coveredBy: 'outer' } : {}) })));
  try {
    expect((await owned.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'] });
  } finally { await owned.drain(); }
});

test('a still-running background command is reported as running, not as a missing record', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  messages.push(tool('dev_server'));
  let running = ['dev_server'];
  const owned = createFixtureHost({ dataDirectory: base, activeExecutionCalls: ({ sessionID }) => sessionID === 'ses_a' ? running : [],
    fetchImpl: async raw => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/children')) return Response.json([]);
      if (url.pathname.endsWith('/message')) return Response.json(messages);
      return Response.json({ id: 'ses_a', directory });
    } });
  const live = (await owned.handleRequest('GET', endpoint())).body;
  expect(live).toMatchObject({ coverage: 'partial', reasons: ['background_running'] });
  expect(live.coverageBySession).toContainEqual({ sessionID: 'ses_a', reasons: ['background_running'] });
  // Once it ends without its receipt, the record is missing; another missing call is never hidden.
  running = [];
  expect((await owned.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'] });
  running = ['dev_server']; messages.push(tool('missing'));
  expect((await owned.handleRequest('GET', endpoint())).body.reasons).toEqual(['background_running', 'missing_capture']);
  await owned.drain();
});

const hostWithOutcomes = executionOutcomes => createFixtureHost({ dataDirectory: base, executionOutcomes,
  fetchImpl: async raw => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/children')) return Response.json([]);
    if (url.pathname.endsWith('/message')) return Response.json(messages);
    return Response.json({ id: 'ses_a', directory });
  },
});

test('exact durable no-start outcomes repair denied writer coverage and survive reopening', async () => {
  const storage = path.join(base, 'mutations');
  let mutations = createSessionMutationRuntime({ directory: storage });
  const denied = tool('denied'); denied.parts[0].tool = 'write'; denied.parts[0].state.status = 'error';
  messages.push(denied);
  await mutations.cancelUnstartedCall({ directory, sessionID: 'ses_a', messageID: denied.info.id, callID: 'denied', requireAbsent: true });
  mutations = createSessionMutationRuntime({ directory: storage });
  const owned = hostWithOutcomes(input => mutations.executionOutcomes(input));
  const first = await owned.handleRequest('GET', endpoint());
  expect(first.body).toMatchObject({ coverage: 'complete', reasons: [], fileCount: 0 });
  const second = await owned.handleRequest('GET', endpoint());
  expect(second.body.revision).toBe(first.body.revision);
  await owned.drain();
});

test('error text, absent outcomes, mismatched durable identity and nonterminal calls cannot repair coverage', async () => {
  const mutations = createSessionMutationRuntime({ directory: path.join(base, 'mutations') });
  for (const [callID, status] of [['unknown', 'error'], ['mismatch', 'error'], ['unfinished', 'running'], ['successful', 'completed']]) {
    const record = tool(callID); record.parts[0].tool = 'write'; record.parts[0].state.status = status;
    record.parts[0].state.error = 'native_plan_write_denied'; messages.push(record);
  }
  await mutations.cancelUnstartedCall({ directory, sessionID: 'ses_a', messageID: 'different_message', callID: 'mismatch', requireAbsent: true });
  for (const callID of ['unfinished', 'successful']) await mutations.cancelUnstartedCall({ directory, sessionID: 'ses_a', messageID: `msg_${callID}`, callID, requireAbsent: true });
  const owned = hostWithOutcomes(input => mutations.executionOutcomes(input));
  expect((await owned.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'] });
  expect((await host.handleRequest('GET', endpoint())).body.coverage).toBe('partial');
  await owned.drain();
});

test('rejects a constructor outcome batch with different canonical call identity', async () => {
  const denied = tool('denied'); denied.parts[0].tool = 'write'; denied.parts[0].state.status = 'error'; messages.push(denied);
  const owned = hostWithOutcomes(async () => [{ sessionID: 'ses_a', messageID: denied.info.id, callID: 'other', outcome: 'never_started' }]);
  const response = await owned.handleRequest('GET', endpoint());
  expect(response).toMatchObject({ status: 503, body: { code: 'capture_identity_mismatch' } });
  await owned.drain();
});

test('a finished execution without its edit receipt remains incomplete', async () => {
  const failed = tool('finished'); failed.parts[0].tool = 'write'; failed.parts[0].state.status = 'error'; messages.push(failed);
  const owned = hostWithOutcomes(async ({ sessionID, calls }) => calls.map(call => ({ ...call, sessionID, outcome: 'finished' })));
  expect((await owned.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'] });
  await owned.drain();
});

test('rejects mismatched session identity and directory before filesystem capture', async () => {
  await expect(host.plugin({ action: 'before', sessionID: 'ses_wrong', directory, callID: 'call_a' })).rejects.toMatchObject({ code: 'session_directory_mismatch' });
  const response = await host.handleRequest('GET', endpoint().replace(encodeURIComponent(directory), encodeURIComponent(base)));
  expect(response.status).toBe(403);
});

test('reconstructs historical native file receipts without adopting broad turn diffs', async () => {
  messages[0].info.summary = { diffs: [{ file: 'unrelated.txt', additions: 200, deletions: 0 }] };
  const record = tool('historical');
  record.parts[0].tool = 'edit';
  record.parts[0].state.metadata = { filediff: { file: 'a.txt', before: 'old\n', after: 'new\n' } };
  messages.push(record);
  const result = await host.handleRequest('GET', endpoint());
  expect(result.status).toBe(200);
  expect(result.body.files.map((file) => file.path)).toEqual(['a.txt']);
  expect(result.body.coverage).toBe('complete');
  expect(result.body.restoreReasons).toContain('restore_evidence_unavailable');
  expect((await host.handleRequest('POST', endpoint('/undo'), { revision: result.body.revision })).status).toBe(409);
});

test('reads history beyond 1000 messages using the supplied cursor', async () => {
  let pages = 0;
  const paged = createFixtureHost({ dataDirectory: base,
    buildOpenCodeUrl: (pathname) => `http://fixture${pathname}`,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/children')) return Response.json([]);
      if (!url.pathname.endsWith('/message')) return Response.json({ id: 'ses_a', directory });
      const page = Number(url.searchParams.get('before') ?? 0); pages++;
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ info: { id: `user_${1200 - page * 100 - i}`, role: 'user', time: { created: 1200 - page * 100 - i } }, parts: [] }))),
        { headers: page < 11 ? { 'x-next-cursor': String(page + 1) } : {} });
    },
  });
  const response = await paged.handleRequest('GET', endpoint());
  expect(pages).toBe(12); expect(response.body.firstUserMessageID).toBe('user_1');
  await paged.drain();
});


test('restore refuses a missing native owner regardless of live status', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  const record = tool('call_a'); record.parts[0].tool = 'write'; record.parts[0].state.input = { filePath: 'shell.txt' };
  messages.push(record);
  const input = { sessionID: 'ses_a', directory, callID: 'call_a' };
  await host.plugin({ ...input, action: 'before' });
  await fs.writeFile(path.join(directory, 'shell.txt'), 'keep\n');
  record.parts[0].state.metadata = { filediff: { file: 'shell.txt', before: null, after: 'keep\n' } };
  await host.plugin({ ...input, action: 'after' });
  const { body } = await host.handleRequest('GET', endpoint());
  statuses = { other: { type: 'busy' } };
  expect((await host.handleRequest('POST', endpoint('/undo'), { revision: body.revision })).body.code).toBe('mutation_runtime_unsupported');
  statuses = [];
  expect((await host.handleRequest('POST', endpoint('/undo'), { revision: body.revision })).body.code).toBe('mutation_runtime_unsupported');
  expect(await fs.readFile(path.join(directory, 'shell.txt'), 'utf8')).toBe('keep\n');
});

test('cached history refreshes only the head page and captures newly settled receipts', async () => {
  let pages = 0;
  const historical = tool('historical'), newest = tool('newest');
  historical.parts[0].tool = 'edit';
  historical.parts[0].state.metadata = { filediff: { file: 'a.txt', before: 'base\n', after: 'first\n' } };
  const paged = createFixtureHost({ dataDirectory: base, buildOpenCodeUrl: (pathname) => `http://fixture${pathname}`,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/children')) return Response.json([]);
      if (!url.pathname.endsWith('/message')) return Response.json({ id: 'ses_a', directory });
      pages++;
      if (url.searchParams.has('before')) return Response.json(messages);
      return new Response(JSON.stringify([historical, newest]), { headers: { 'x-next-cursor': 'older' } });
    },
  });
  const first = await paged.handleRequest('GET', endpoint());
  expect(first.status).toBe(200); expect(pages).toBe(2);
  newest.parts[0].tool = 'edit';
  newest.parts[0].state.metadata = { filediff: { file: 'a.txt', before: 'first\n', after: 'second\n' } };
  newest.parts[0].state.time = { start: 3 };
  const second = await paged.handleRequest('GET', endpoint());
  expect(second.status).toBe(200); expect(pages).toBe(3);
  const diff = await paged.handleRequest('GET', `${endpoint('/diff')}&revision=${second.body.revision}&file=a.txt`);
  expect(diff.body.patch).toContain('+second');
  await paged.drain();
});

test('unattested read aliases remain incomplete while exact file receipts stay reviewable', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  for (const name of ['ls', 'oc_stat', 'skill', 'ctx_search']) {
    const read = tool(name); read.parts[0].tool = name; messages.push(read);
    await host.plugin({ action: 'before', sessionID: 'ses_a', directory, callID: name, tool: name });
  }
  const native = tool('native'); native.parts[0].tool = 'oc_edit';
  native.parts[0].state.input = { path: 'native.txt' };
  native.parts[0].state.metadata = { diff: '--- a/native.txt\n+++ b/native.txt\n@@ -1 +1 @@\n-old\n+new\n' };
  messages.push(native);
  const multi = tool('multi'); multi.parts[0].tool = 'apply_patch';
  multi.parts[0].state.metadata = { files: [
    { filePath: 'one.txt', before: '', after: 'one\n', type: 'added' },
    { filePath: 'two.txt', before: '', after: 'two\n', type: 'added' },
  ] };
  messages.push(multi);
  const synthetic = tool('synthetic'); synthetic.parts[0].tool = 'apply_patch';
  synthetic.parts[0].state.metadata = { syntheticWorkspacePatch: true, files: [{ file: 'foreign.txt', before: '', after: 'foreign' }] };
  messages.push(synthetic);
  const result = await host.handleRequest('GET', endpoint());
  expect(result.body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'], fileCount: 3, restoreAvailable: false });
  expect(result.body.files.map((file) => file.path)).toEqual(['native.txt', 'one.txt', 'two.txt']);
});

test('canonical terminal events persist exact failed-tool edits without claiming unknown effects', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  const record = tool('failed'); record.parts[0].tool = 'edit';
  messages.push(record);
  await host.plugin({ action: 'before', sessionID: 'ses_a', directory, callID: 'failed' });
  await fs.writeFile(path.join(directory, 'partial.txt'), 'written\n');
  Object.assign(record.parts[0], { sessionID: 'ses_a', messageID: record.info.id });
  record.parts[0].state = { status: 'error', metadata: { filediff: { file: 'partial.txt', before: null, after: 'written\n' } } };
  await host.observe({ type: 'message.part.updated', properties: { part: record.parts[0] } }, directory);
  const result = await host.handleRequest('GET', endpoint());
  expect(result.body.files[0].path).toBe('partial.txt');
  expect(result.body.reasons).toEqual(['tool_changes_incomplete']);
  expect(result.body.restoreAvailable).toBe(false);
});


test('bounded native Cursor task previews cannot certify child edits', async () => {
  const record = tool('native_task');
  record.info.providerID = 'cursor-acp';
  record.parts[0].tool = 'task';
  record.parts[0].state.metadata = { cursorNativeTask: { source: 'cursor-native' } };
  messages.push(record);
  const result = await host.handleRequest('GET', endpoint());
  expect(result.body.coverage).toBe('partial');
  expect(result.body.reasons).toContain('missing_capture');
  expect(result.body.files).toEqual([]);
});


test('invalid historical paths leave verified files reviewable and repair only their own call', async () => {
  const known = tool('known'), invalid = tool('invalid');
  for (const record of [known, invalid]) record.parts[0].tool = 'edit';
  known.parts[0].state.metadata = { filediff: { file: 'known.txt', before: null, after: 'known\n' } };
  invalid.parts[0].state.metadata = { filediff: { file: '../outside.txt', before: null, after: 'outside\n' } };
  messages.push(known, invalid);
  const first = await host.handleRequest('GET', endpoint());
  expect(first.status).toBe(200);
  expect(first.body.files.map(file => file.path)).toEqual(['known.txt']);
  expect(first.body.reasons).toContain('invalid_change_receipt');
  const emitted = events.length;
  for (let read = 0; read < 3; read++) {
    const unchanged = await host.handleRequest('GET', endpoint());
    expect(unchanged.body.reasons).toContain('invalid_change_receipt');
    expect(unchanged.body.revision).toBe(first.body.revision);
  }
  expect(events).toHaveLength(emitted);
  invalid.parts[0].state.metadata.filediff.file = 'repaired.txt';
  const repaired = await host.handleRequest('GET', endpoint());
  expect(repaired.body.coverage).toBe('complete');
  expect(repaired.body.files.map(file => file.path)).toEqual(['known.txt', 'repaired.txt']);
  expect(events.length).toBeGreaterThan(emitted);
});


test('concurrent summary subscribers share history and only the final disconnect cancels it', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let messageReads = 0, readSignal;
  const shared = createFixtureHost({ dataDirectory: base, buildOpenCodeUrl: pathname => `http://fixture${pathname}`,
    fetchImpl: async (raw, init) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/message')) {
        messageReads++; readSignal = init.signal; started(); await gate;
        return Response.json(messages);
      }
      if (url.pathname.endsWith('/children')) return Response.json([]);
      return Response.json({ id: 'ses_a', directory });
    } });
  const abandoned = new AbortController();
  try {
    const alias = path.join(base, 'alias'); await fs.symlink(directory, alias);
    const aliasEndpoint = endpoint().replace(encodeURIComponent(directory), encodeURIComponent(alias));
    const reads = [shared.handleRequest('GET', endpoint(), {}, { signal: abandoned.signal }),
      shared.handleRequest('GET', aliasEndpoint),
      ...Array.from({ length: 8 }, () => shared.handleRequest('GET', endpoint()))];
    await entered;
    // Allow all realpath resolutions to join the same scope.
    while (shared.getReadDiagnostics().scopes !== 1) await new Promise(resolve => setTimeout(resolve, 1));
    abandoned.abort();
    expect((await reads[0]).status).toBe(503);
    expect(readSignal.aborted).toBe(false);
    release();
    const results = await Promise.all(reads.slice(1));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(results[0].body.directory).toBe(alias);
    expect(results[1].body.directory).toBe(directory);
    expect(results[0].body.revision).toBe(results[1].body.revision);
    expect(messageReads).toBe(1);
    expect(shared.getReadDiagnostics()).toMatchObject({ active: 0, queued: 0, scopes: 0, responseBytes: 0 });
  } finally { release(); await shared.drain(); }
});

test('a disconnected sole summary client aborts upstream history and releases its scope', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let observedAbort = false;
  const shared = createFixtureHost({ dataDirectory: base, buildOpenCodeUrl: pathname => `http://fixture${pathname}`,
    fetchImpl: async (raw, init) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/message')) {
        started();
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => {
          observedAbort = true; reject(init.signal.reason);
        }, { once: true }));
      }
      if (url.pathname.endsWith('/children')) return Response.json([]);
      return Response.json({ id: 'ses_a', directory });
    } });
  const abort = new AbortController();
  try {
    const result = shared.handleRequest('GET', endpoint(), {}, { signal: abort.signal });
    await entered; abort.abort(); await result; await shared.drain();
    expect(observedAbort).toBe(true);
    expect(shared.getReadDiagnostics()).toMatchObject({ active: 0, queued: 0, scopes: 0, responseBytes: 0 });
  } finally { await shared.drain(); }
});

test('a cancelled confined call with an empty receipt leaves the change record complete', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  const record = tool('stopped'); record.parts[0].state = { status: 'error', input: { command: 'npm run verify' }, error: 'Tool execution aborted' };
  messages.push(record);
  const input = { sessionID: 'ses_a', directory, callID: 'stopped' };
  // The call was observed before it ran and stopped before its after hook.
  await host.plugin({ ...input, action: 'before' });
  await host.recordReceipt({ ...input, messageID: 'msg_stopped', userMessageID: 'user_1', source: 'confined-execution', complete: true, files: [], tool: 'bash' });
  const result = await host.handleRequest('GET', endpoint());
  expect(result.body).toMatchObject({ coverage: 'complete', reasons: [], fileCount: 0 });
});


test('session-change observation requires explicit native identity without a raw fallback', async () => {
  for (const openCodeClient of [undefined, {}, { generation: () => 1 }, { generation: () => 3 }]) {
    let calls = 0;
    const current = createSessionChangeHost({ dataDirectory: base, openCodeClient, fetchImpl: () => { calls++; throw Error('raw runtime forbidden'); } });
    try {
      expect(await current.handleRequest('GET', endpoint())).toMatchObject({ status: 503, body: { code: 'opencode_generation_invalid' } });
      expect(calls).toBe(0);
    } finally { await current.drain(); }
  }
});

test('reindex preserves unattested legacy read calls as incomplete after restart', async () => {
  for (const [index, name] of ['read', 'oc_grep', 'glob'].entries()) {
    const record = tool(`read_${index}`); record.parts[0].tool = name; messages.push(record);
    await host.finish({ directory, sessionID: 'ses_a', messageID: record.info.id, callID: record.parts[0].callID });
  }
  // A transcript name alone cannot clear older observations.
  await host.historyState({ directory, sessionID: 'ses_a', state: { complete: true, newestID: 'msg_read_2', repairVersion: 1 },
    messages: messages.slice(1).map(record => ({ id: record.info.id, createdAt: 2, calls: [record.parts[0].callID] })) });
  const result = await host.handleRequest('GET', endpoint());
  expect(result.body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'], fileCount: 0, hasUnattributedMutations: true });
  const reopened = hostWithOutcomes(undefined);
  try {
    const repeat = await reopened.handleRequest('GET', endpoint());
    expect(repeat.body.revision).toBe(result.body.revision);
    messages.push(tool('unknown_writer'));
    expect((await reopened.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'partial', reasons: ['missing_capture'], hasUnattributedMutations: true });
  } finally { await reopened.drain(); }
});

test('read-only history cannot erase conflicting exact mutation evidence or enable Undo', async () => {
  const record = tool('contradiction'); record.parts[0].tool = 'read'; messages.push(record);
  await host.recordReceipt({ directory, sessionID: 'ses_a', messageID: record.info.id, callID: 'contradiction', userMessageID: 'user_1',
    source: 'confined-execution', files: [{ path: 'contradiction.txt', before: null, after: { bytes: Buffer.from('owned\n'), mode: '100644' } }] });
  const result = await host.handleRequest('GET', endpoint());
  expect(result.body).toMatchObject({ coverage: 'partial', reasons: ['capture_identity_reused'], fileCount: 1, restoreAvailable: false });
});

test('cached display summaries stay responsive for one and three clients while reconciliation is blocked', async () => {
  const children = Array.from({ length: 7 }, (_, i) => ({ id: `ses_child_${i}`, parentID: 'ses_a', directory }));
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let reconciliations = 0, historyReads = 0, proofs = 0, outcomeCalls = 0, observerThrows = 0;
  const lockTimings = [];
  const mutationStorage = path.join(base, 'display-mutations');
  const mutations = createSessionMutationRuntime({ directory: mutationStorage, onLockTiming: timing => lockTimings.push(timing) });
  await mutations.activeLeases({ directory });
  const historicalReads = sessionID => Array.from({ length: 32 }, (_, i) => {
    const record = tool(`read_${sessionID}_${i}`); record.parts[0].tool = 'read'; return record;
  });
  messages.push(...historicalReads('ses_a'));
  const record = tool('display_write'); record.parts[0].tool = 'write'; messages.push(record);
  const cached = createFixtureHost({ dataDirectory: base,
    publishEvent: () => {
      if (historyReads && cached.getReadDiagnostics().active === 0) { observerThrows++; throw Error('display observer failed'); }
    },
    reconcileExecutionReceipts: async ({ sessionID }) => {
      reconciliations++; await blocked; await mutations.executionOutcomes({ directory, sessionID, calls: [] });
    },
    executionOutcomes: async ({ sessionID, calls }) => {
      outcomeCalls += calls.length;
      return calls.map(call => ({ ...call, sessionID, outcome: 'finished', effect: 'read-only' }));
    },
    previewOwned: async () => { proofs++; return { version: 1, digest: 'a'.repeat(64) }; }, restoreOwned: async () => {},
    fetchImpl: async raw => {
      const url = new URL(raw), id = url.pathname.split('/')[2];
      if (url.pathname.endsWith('/children')) return Response.json(id === 'ses_a' ? children : []);
      if (url.pathname.endsWith('/message')) { historyReads++; return Response.json(id === 'ses_a' ? messages : [messages[0], ...historicalReads(id)]); }
      return Response.json(id === 'ses_a' ? { id, directory } : children.find(child => child.id === id));
    } });
  try {
    await cached.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
    const files = Array.from({ length: 104 }, (_, i) => ({ path: `file-${i}.txt`, before: null, after: `value ${i}\n` }));
    await Promise.all(files.map(file => fs.writeFile(path.join(directory, file.path), file.after)));
    await cached.recordReceipt({ directory, sessionID: 'ses_a', messageID: record.info.id, callID: 'display_write',
      userMessageID: 'user_1', source: 'confined-execution', complete: true, files, tool: 'write' });
    const cold = await cached.handleRequest('GET', `${endpoint()}&summary=1`);
    expect(cold.body).toMatchObject({ projectionState: 'missing', restoreEligibility: { state: 'unknown' } });
    expect(proofs).toBe(0);
    const changed = tool('during_refresh'); changed.parts[0].tool = 'write'; messages.push(changed);
    await cached.recordReceipt({ directory, sessionID: 'ses_a', messageID: changed.info.id, callID: 'during_refresh',
      userMessageID: 'user_1', source: 'confined-execution', complete: true, files: [], tool: 'write' });
    const waiting = await Promise.all(Array.from({ length: 3 }, () => cached.handleRequest('GET', `${endpoint()}&summary=1`)));
    expect(waiting.every(result => result.body.projectionState === 'missing')).toBe(true);
    expect(reconciliations).toBe(1);
    release();
    let ready;
    for (let i = 0; i < 1000; i++) {
      ready = await cached.handleRequest('GET', `${endpoint()}&summary=1`);
      if (ready.body.projectionState === 'ready') break;
      await Bun.sleep(5);
    }
    expect(ready.body).toMatchObject({ projectionState: 'ready', fileCount: 104, sessionCount: 8,
      restoreEligibility: { state: 'candidate', action: 'undo' } });
    expect(ready.body.restoreProof).toBeUndefined(); expect(ready.body.current).toBeUndefined();
    expect(ready.body.files.every(file => file.verification === undefined)).toBe(true);
    expect(observerThrows).toBeGreaterThan(0);
    expect(reconciliations).toBe(16); // One initial refresh and one trailing refresh for all eight sessions.
    expect(outcomeCalls).toBe(512); // 32 historical reads per session, across both refreshes.
    const initial = { reconciliations, historyReads, outcomeCalls, ownerLocks: lockTimings.length };
    let unlock, entered;
    const held = new Promise(resolve => { entered = resolve; });
    const releaseLock = new Promise(resolve => { unlock = resolve; });
    const ownerLock = withCrossProcessFileLock(path.join(mutationStorage, changeKey(await fs.realpath(directory)), 'owner.lock'),
      async () => { entered(); await releaseLock; });
    await held;
    try { for (const clients of [1, 3]) {
      const elapsed = [];
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        const responses = await Promise.all(Array.from({ length: clients }, () => cached.handleRequest('GET', `${endpoint()}&summary=1`)));
        expect(responses.every(result => result.body.projectionState === 'ready')).toBe(true);
        elapsed.push(performance.now() - started);
      }
      const p95 = elapsed.sort((a, b) => a - b)[Math.ceil(elapsed.length * .95) - 1];
      expect(p95).toBeLessThan(1000);
      console.info(`session-summary warm clients=${clients} p95=${p95.toFixed(1)}ms sessions=8 files=104 historicalReadCalls=256 heldOwnerLock=true`);
    }
    expect({ reconciliations, historyReads, outcomeCalls, ownerLocks: lockTimings.length }).toEqual(initial);
    expect(proofs).toBe(0);
    } finally { unlock(); await ownerLock; }
    expect(await cached.handleRequest('POST', endpoint('/preview'), { revision: 'b'.repeat(64), action: 'undo' }))
      .toMatchObject({ status: 409, body: { code: 'summary_revision_changed' } });
    expect(proofs).toBe(0);
    const preview = await cached.handleRequest('POST', endpoint('/preview'), { revision: ready.body.revision, action: 'undo' });
    expect(preview).toMatchObject({ status: 200, body: { revision: ready.body.revision, action: 'undo', restoreProof: { version: 1, digest: 'a'.repeat(64) } } });
    expect(proofs).toBe(1);
    expect(await cached.handleRequest('POST', endpoint('/preview'), { revision: ready.body.revision, action: 'redo' }))
      .toMatchObject({ status: 409 });
  } finally { release(); await cached.drain(); await mutations.drain(); }
});

test('a failed display refresh retains rows with unknown eligibility and never invokes restore preview', async () => {
  let fail = false, proofs = 0, reconciliations = 0;
  const cached = createFixtureHost({ dataDirectory: base,
    reconcileExecutionReceipts: async () => { reconciliations++; if (fail) throw Error('owner unavailable'); },
    previewOwned: async () => { proofs++; return { version: 1, digest: 'a'.repeat(64) }; }, restoreOwned: async () => {},
    fetchImpl: async raw => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/children')) return Response.json([]);
      if (url.pathname.endsWith('/message')) return Response.json(messages);
      return Response.json({ id: 'ses_a', directory });
    } });
  try {
    await cached.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
    const record = tool('saved_row'); record.parts[0].tool = 'write'; messages.push(record);
    await fs.writeFile(path.join(directory, 'saved.txt'), 'saved\n');
    await cached.recordReceipt({ directory, sessionID: 'ses_a', messageID: record.info.id, callID: 'saved_row',
      userMessageID: 'user_1', source: 'confined-execution', complete: true,
      files: [{ path: 'saved.txt', before: null, after: 'saved\n' }], tool: 'write' });
    let ready;
    for (let i = 0; i < 100; i++) {
      ready = await cached.handleRequest('GET', `${endpoint()}&summary=1`);
      if (ready.body.projectionState === 'ready') break;
      await Bun.sleep(5);
    }
    expect(ready.body.restoreEligibility).toEqual({ state: 'candidate', action: 'undo' });
    fail = true;
    const next = tool('new_receipt'); next.parts[0].tool = 'write'; messages.push(next);
    const before = reconciliations;
    await cached.recordReceipt({ directory, sessionID: 'ses_a', messageID: next.info.id, callID: 'new_receipt',
      userMessageID: 'user_1', source: 'confined-execution', complete: true, files: [], tool: 'write' });
    for (let i = 0; i < 100 && (reconciliations === before || cached.getReadDiagnostics().active); i++) await Bun.sleep(5);
    const failed = await cached.handleRequest('GET', `${endpoint()}&summary=1`);
    expect(failed.body).toMatchObject({ projectionState: 'refreshing', revision: ready.body.revision,
      fileCount: 1, restoreEligibility: { state: 'unknown' } });
    expect(failed.body.restoreProof).toBeUndefined(); expect(proofs).toBe(0);
    expect(await cached.handleRequest('POST', endpoint('/preview'), { revision: ready.body.revision, action: 'delete' }))
      .toMatchObject({ status: 400, body: { code: 'invalid_restore_preview' } });
  } finally { await cached.drain(); }
});
