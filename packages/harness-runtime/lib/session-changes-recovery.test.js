import { afterEach, beforeEach, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionChangeRuntime } from './session-changes.js';
import { createSessionChangeHost } from './session-changes-host.js';
import { openChangeStore, changeKey } from './session-changes-store.js';

const test = (name, run) => bunTest(name, run, 60_000);
let base, directory, storage, runtime, events;
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-change-recovery-')));
  directory = path.join(base, 'repo'); storage = path.join(base, 'capture');
  await fs.mkdir(directory); execFileSync('git', ['init', '-q'], { cwd: directory });
  events = [];
  runtime = createSessionChangeRuntime({ directory: storage, onChange: (event) => events.push(event) });
});
afterEach(async () => { await runtime.drain(); await fs.rm(base, { recursive: true, force: true }); }, 30_000);
const scope = (callID, sessionID = 'ses_root') => ({ directory, sessionID, userMessageID: 'user_1', messageID: `msg_${callID}`, callID });
const receipt = (callID, sessionID) => ({ ...scope(callID, sessionID), files: [{ path: `${callID}.txt`, before: null, after: `${callID}\n` }] });
const summary = (rootSessionID = 'ses_root') => runtime.summarize({ directory, rootSessionID });

test('late receipts repair only their missing hook, including after restart', async () => {
  await runtime.registerSession(scope('one'));
  await runtime.finish(scope('one')); await runtime.finish(scope('two'));
  await runtime.recordReceipt(receipt('one'));
  expect(await summary()).toMatchObject({ fileCount: 1, coverage: 'partial', reasons: ['missing_capture'], reconciliationState: 'settled' });
  runtime = createSessionChangeRuntime({ directory: storage });
  await runtime.recordReceipt(receipt('two'));
  expect(await summary()).toMatchObject({ fileCount: 2, coverage: 'complete', reasons: [], reconciliationState: 'settled' });
});

test('completion strengthens identical edits, stale repeats cannot downgrade, conflicting edits stay explicit', async () => {
  const input = receipt('one');
  await runtime.begin(input);
  await fs.writeFile(path.join(directory, 'one.txt'), 'one\n'); await runtime.finish(input);
  await runtime.recordReceipt({ ...input, complete: false });
  const partial = await summary();
  expect(partial.restoreAvailable).toBe(false);
  await runtime.recordReceipt({ ...input, complete: true });
  const complete = await summary();
  expect(complete).toMatchObject({ coverage: 'complete', restoreAvailable: true });
  await runtime.recordReceipt({ ...input, complete: false });
  expect((await summary()).revision).toBe(complete.revision);
  expect((await runtime.diff({ directory, rootSessionID: 'ses_root', revision: partial.revision, file: 'one.txt' })).patch).toContain('+one');
  await runtime.recordReceipt({ ...input, files: [{ path: 'one.txt', before: null, after: 'different\n' }] });
  expect(await summary()).toMatchObject({ coverage: 'partial', reasons: ['receipt_conflict'], restoreAvailable: false });
});

test('legacy missing flags require a complete history with every call accounted for', async () => {
  await runtime.recordReceipt(receipt('one'));
  const db = await openChangeStore(storage, path.join(storage, changeKey(directory), 'git'));
  const key = `sessions/${changeKey('ses_root')}.json`;
  db.set(key, { ...await db.get(key), issues: ['missing_capture'] }); await db.commit();
  expect((await summary()).reasons).toContain('missing_capture');
  await runtime.historyState({ directory, sessionID: 'ses_root', state: { complete: true, first: { id: 'user_1' } },
    messages: [{ id: 'msg_one', createdAt: 1, calls: ['one', 'two'] }] });
  expect((await summary()).reasons).toContain('missing_capture');
  await runtime.recordReceipt(receipt('two'));
  expect(await summary()).toMatchObject({ coverage: 'complete', reasons: [] });
});

test('trusted executable modes strengthen textual receipts and survive stale delivery', async () => {
  const input = { ...receipt('executable'), complete: false };
  await runtime.recordReceipt(input);
  const original = await summary();
  const gitDir = path.join(storage, changeKey(directory), 'git');
  const oid = execFileSync('git', ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], { input: 'executable\n', encoding: 'utf8' }).trim();
  const trusted = { ...input, files: [{ path: 'executable.txt', before: null, after: { oid, mode: '100755' } }] };
  await runtime.recordReceipt(trusted);
  await runtime.recordReceipt(input);
  await runtime.recordReceipt({ ...input, complete: true });
  const complete = await summary();
  expect(complete).toMatchObject({ coverage: 'complete', restoreAvailable: true });
  expect((await runtime.diff({ directory, rootSessionID: 'ses_root', revision: complete.revision, file: 'executable.txt' })).patch).toContain('100755');
  expect((await runtime.diff({ directory, rootSessionID: 'ses_root', revision: original.revision, file: 'executable.txt' })).patch).toContain('100644');
  await runtime.recordReceipt({ ...trusted, files: [{ ...trusted.files[0], after: { oid, mode: '100644' } }] });
  expect((await summary()).reasons).toContain('receipt_conflict');
});

test('child receipts notify ancestors absent from the UI and survive deletion of a read-only parent', async () => {
  await runtime.registerSession(scope('root'));
  await runtime.registerSession({ ...scope('child', 'ses_child'), parentID: 'ses_root' });
  await runtime.registerSession({ ...scope('grandchild', 'ses_grandchild'), parentID: 'ses_child' });
  events.length = 0;
  await runtime.recordReceipt(receipt('owned', 'ses_grandchild'));
  expect(events.map((event) => event.sessionID)).toEqual(['ses_grandchild', 'ses_child', 'ses_root']);
  await runtime.recordReceipt(receipt('foreign', 'ses_other'));
  await runtime.deleteSession('ses_child');
  expect((await summary()).files.map((file) => file.path)).toEqual(['owned.txt']);
  expect((await summary('ses_grandchild')).files.map((file) => file.path)).toEqual(['owned.txt']);
});

const makeHost = (fetchImpl) => createSessionChangeHost({ dataDirectory: base,
  buildOpenCodeUrl: (pathname) => `http://fixture${pathname}`, fetchImpl });
const endpoint = () => `/api/openchamber/session/ses_root/changes?directory=${encodeURIComponent(directory)}`;

test('hook resolution follows history pages and later uses canonical message identity', async () => {
  const record = { info: { id: 'msg_old', sessionID: 'ses_root', role: 'assistant', parentID: 'user_1', time: { created: 2 } },
    parts: [{ type: 'tool', callID: 'old', tool: 'write', state: { status: 'running', input: { filePath: 'old.txt' } } }] };
  const requests = [];
  const host = makeHost(async (raw) => {
    const url = new URL(raw); requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/message/msg_old')) return Response.json(record);
    if (url.pathname.endsWith('/message')) return url.searchParams.has('before') ? Response.json([record])
      : new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ info: { id: `user_${i + 2}`, role: 'user', time: { created: i + 3 } }, parts: [] }))), { headers: { 'x-next-cursor': 'older' } });
    return Response.json({ id: 'ses_root', directory });
  });
  try {
    await host.plugin({ ...scope('old'), action: 'before' });
    await fs.writeFile(path.join(directory, 'old.txt'), 'old\n');
    record.parts[0].state.status = 'completed';
    record.parts[0].state.metadata = { filediff: { file: 'old.txt', before: null, after: 'old\n' } };
    await host.plugin({ ...scope('old'), action: 'after' });
    expect(requests.some((value) => value.includes('before=older'))).toBe(true);
    expect(requests.some((value) => value.includes('/message/msg_old'))).toBe(true);
    expect(await host.summarize({ directory, rootSessionID: 'ses_root' })).toMatchObject({ fileCount: 1, coverage: 'complete' });
  } finally { await host.drain(); }
});

test('native task receipts remain complete beyond previews, scoped by parent call and real session', async () => {
  const tasks = ['task_one', 'task_two', 'task_read'];
  const host = makeHost(async (raw) => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/children')) return Response.json([]);
    if (url.pathname.endsWith('/message')) return Response.json([
      { info: { id: 'user_1', role: 'user', time: { created: 1 } }, parts: [] },
      { info: { id: 'msg_1', sessionID: 'ses_root', parentID: 'user_1', role: 'assistant', providerID: 'cursor-acp', time: { created: 2 } },
        parts: tasks.map((callID) => ({ type: 'tool', callID, tool: 'task', state: { status: 'completed' } })) },
    ]);
    return Response.json({ id: 'ses_root', directory });
  });
  const identity = { directory, sessionID: 'ses_root', messageID: 'msg_1', userMessageID: 'user_1' };
  try {
    for (const callID of tasks) {
      await host.acceptExecution({ ...identity, phase: 'tool', tool: 'task', callID, state: 'running' });
      if (callID === 'task_read') {
        await host.acceptExecution({ ...identity, phase: 'tool', parentCallID: callID, callID: 'same_child', tool: 'read', state: 'completed' });
      } else {
        const content = 'x'.repeat(5000);
        await host.acceptExecution({ ...identity, phase: 'tool', parentCallID: callID, callID: 'same_child', tool: 'edit', state: 'completed',
          metadata: { diff: `--- a/${callID}.txt\n+++ b/${callID}.txt\n@@ -1 +1 @@\n-old\n+${content}\n` } });
      }
      await host.acceptExecution({ ...identity, phase: 'tool', tool: 'task', callID, state: 'completed' });
    }
    expect((await host.handleRequest('GET', endpoint())).body.reconciliationState).toBe('pending');
    await host.acceptExecution({ ...identity, phase: 'run-settled' });
    const { body } = await host.handleRequest('GET', endpoint());
    expect(body).toMatchObject({ fileCount: 2, sessionCount: 1, coverage: 'complete', reconciliationState: 'settled', restoreAvailable: false });
    const diff = await host.diff({ directory, rootSessionID: 'ses_root', revision: body.revision, file: 'task_one.txt' });
    expect(diff.patch).toContain('x'.repeat(5000));
  } finally { await host.drain(); }
});

test('native interruption preserves exact edits while missing execution results remain explicit', async () => {
  const start = { ...scope('task'), phase: 'tool', tool: 'task', state: 'running' };
  await runtime.recordExecution(start);
  await runtime.recordExecution({ ...start, callID: 'nested', parentCallID: 'task', tool: 'write' });
  runtime = createSessionChangeRuntime({ directory: storage });
  await runtime.recordExecution({ directory, sessionID: 'ses_root', phase: 'interrupted' });
  expect(await summary()).toMatchObject({ coverage: 'partial', reconciliationState: 'settled', reasons: ['capture_interrupted'] });
});

test('a replayed final marker repairs an interrupted task but never hides unsupported nested execution', async () => {
  const identity = { ...scope('task'), phase: 'tool', tool: 'task' };
  await runtime.recordExecution({ ...identity, state: 'running' });
  await runtime.recordExecution({ ...identity, state: 'completed' });
  runtime = createSessionChangeRuntime({ directory: storage });
  await runtime.recordExecution({ directory, sessionID: 'ses_root', phase: 'interrupted' });
  expect((await summary()).reasons).toEqual(['capture_interrupted']);
  await runtime.recordExecution({ ...identity, phase: 'run-settled' });
  expect(await summary()).toMatchObject({ coverage: 'complete', fileCount: 0 });
  await runtime.recordExecution({ ...identity, phase: 'stream-gap' });
  await runtime.recordExecution({ ...identity, phase: 'run-settled' });
  expect(await summary()).toMatchObject({ coverage: 'partial', reasons: ['execution_receipt_unavailable'] });
});

test('cached history revisits an unresolved old message after its receipt arrives outside the head page', async () => {
  const old = { info: { id: 'msg_old', sessionID: 'ses_root', role: 'assistant', parentID: 'user_1', time: { created: 2 } },
    parts: [{ type: 'tool', callID: 'old', tool: 'edit', state: { status: 'completed' } }] };
  const head = { info: { id: 'msg_head', role: 'assistant', time: { created: 1000 } }, parts: [] };
  const host = makeHost(async (raw) => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/children')) return Response.json([]);
    if (url.pathname.endsWith('/message/msg_old')) return Response.json(old);
    if (url.pathname.endsWith('/message')) return url.searchParams.has('before')
      ? Response.json([old, { info: { id: 'user_1', role: 'user', time: { created: 1 } }, parts: [] }])
      : new Response(JSON.stringify([head]), { headers: { 'x-next-cursor': 'older' } });
    return Response.json({ id: 'ses_root', directory });
  });
  try {
    expect((await host.handleRequest('GET', endpoint())).body.coverage).toBe('partial');
    old.parts[0].state.metadata = { filediff: { file: 'recovered.txt', before: 'old\n', after: 'new\n' } };
    expect((await host.handleRequest('GET', endpoint())).body).toMatchObject({ coverage: 'complete', fileCount: 1 });
  } finally { await host.drain(); }
});

test('summary waits for asynchronous canonical receipt ingestion before finalizing coverage', async () => {
  let releaseObservation, markEntered, markHistory;
  const gate = new Promise((resolve) => { releaseObservation = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const historyRead = new Promise((resolve) => { markHistory = resolve; });
  let delayObservation = true;
  const host = makeHost(async (raw) => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/children')) return Response.json([]);
    if (url.pathname.includes('/message')) { markHistory(); return Response.json([
      { info: { id: 'user_1', role: 'user', time: { created: 1 } }, parts: [] },
      { info: { id: 'msg_one', role: 'assistant', time: { created: 2 } }, parts: [{ type: 'tool', tool: 'write', callID: 'one', state: { status: 'completed' } }] },
    ]); }
    if (delayObservation) { delayObservation = false; markEntered(); await gate; }
    return Response.json({ id: 'ses_root', directory });
  });
  try {
    const observing = host.observe({ type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'write',
      sessionID: 'ses_root', messageID: 'msg_one', callID: 'one', state: { status: 'completed',
        metadata: { filediff: { file: 'one.txt', before: null, after: 'one\n' } } } } } }, directory);
    await entered;
    let responded = false;
    const reading = host.handleRequest('GET', endpoint()).then((result) => { responded = true; return result; });
    await historyRead;
    expect(responded).toBe(false);
    releaseObservation(); await observing;
    expect((await reading).body).toMatchObject({ coverage: 'complete', reconciliationState: 'settled', fileCount: 1 });
  } finally { releaseObservation(); await host.drain(); }
});

test('restore reconciles late receipts and rejects the superseded revision before writing', async () => {
  const records = [
    { info: { id: 'user_1', role: 'user', time: { created: 1 } }, parts: [] },
    { info: { id: 'msg_one', role: 'assistant', time: { created: 2 } }, parts: [] },
  ];
  const host = makeHost(async (raw) => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/children')) return Response.json([]);
    if (url.pathname.includes('/message')) return Response.json(records);
    if (url.pathname.endsWith('/status')) return Response.json({ ses_root: { type: 'idle' } });
    return Response.json({ id: 'ses_root', directory });
  });
  try {
    await host.begin(scope('one'));
    await fs.writeFile(path.join(directory, 'one.txt'), 'one\n');
    await host.finish(scope('one')); await host.recordReceipt(receipt('one'));
    const initial = (await host.handleRequest('GET', endpoint())).body;
    expect(initial.restoreAvailable).toBe(true);
    records[1].parts.push({ type: 'tool', tool: 'write', callID: 'late', state: { status: 'completed',
      metadata: { filediff: { file: 'late.txt', before: null, after: 'late\n' } } } });
    const restored = await host.handleRequest('POST', endpoint().replace('/changes?', '/changes/undo?'), { revision: initial.revision });
    expect(restored).toMatchObject({ status: 409, body: { code: 'summary_revision_changed' } });
    expect(await fs.readFile(path.join(directory, 'one.txt'), 'utf8')).toBe('one\n');
  } finally { await host.drain(); }
});
