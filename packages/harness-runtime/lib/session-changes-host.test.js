import { afterEach, beforeEach, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionChangeHost } from './session-changes-host.js';

// These are real Git/metadata integration tests, with the same outer budget
// as session-changes.test.js; protocol deadlines remain independently tested.
const test = (name, run) => bunTest(name, run, 60_000);

let base, directory, host, messages, statuses, events;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-change-host-'));
  directory = path.join(base, 'repo'); await fs.mkdir(directory);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  messages = [{ info: { id: 'user_1', role: 'user', time: { created: 1 } }, parts: [] }]; statuses = {}; events = [];
  host = createSessionChangeHost({ dataDirectory: base, buildOpenCodeUrl: (pathname) => `http://fixture${pathname}`,
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
const endpoint = (action = '') => `/api/openchamber/session/ses_a/changes${action}?directory=${encodeURIComponent(directory)}`;
const tool = (callID) => ({ info: { id: `msg_${callID}`, parentID: 'user_1', role: 'assistant', time: { created: 2 } },
  parts: [{ id: `part_${callID}`, type: 'tool', callID, tool: 'bash', state: { status: 'completed' } }] });

test('private hook receipts feed the same summary, diff, and restore HTTP contract', async () => {
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
  expect((await host.handleRequest('POST', endpoint('/undo'), { revision })).status).toBe(200);
  expect((await host.handleRequest('GET', endpoint())).body.undone).toBe(true);
  expect((await host.handleRequest('POST', endpoint('/redo'), { revision })).status).toBe(409);
});

test('missing hooks cannot report complete coverage after a successful prompt registration', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  messages.push(tool('missing'));
  const result = await host.handleRequest('GET', endpoint());
  expect(result.body.coverage).toBe('partial'); expect(result.body.reasons).toContain('missing_capture');
  expect(result.body.files).toEqual([]);
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
  const paged = createSessionChangeHost({ dataDirectory: base,
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


test('restore fails closed when another session is busy or live status is malformed', async () => {
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
  expect((await host.handleRequest('POST', endpoint('/undo'), { revision: body.revision })).body.code).toBe('directory_busy');
  statuses = [];
  expect((await host.handleRequest('POST', endpoint('/undo'), { revision: body.revision })).body.code).toBe('session_status_unavailable');
  expect(await fs.readFile(path.join(directory, 'shell.txt'), 'utf8')).toBe('keep\n');
});

test('cached history refreshes only the head page and captures newly settled receipts', async () => {
  let pages = 0;
  const historical = tool('historical'), newest = tool('newest');
  historical.parts[0].tool = 'edit';
  historical.parts[0].state.metadata = { filediff: { file: 'a.txt', before: 'base\n', after: 'first\n' } };
  const paged = createSessionChangeHost({ dataDirectory: base, buildOpenCodeUrl: (pathname) => `http://fixture${pathname}`,
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

test('shared native aliases exclude reads and import patch, write, and multi-file execution receipts', async () => {
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
  expect(result.body).toMatchObject({ coverage: 'complete', reasons: [], fileCount: 3, restoreAvailable: false });
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
  invalid.parts[0].state.metadata.filediff.file = 'repaired.txt';
  const repaired = await host.handleRequest('GET', endpoint());
  expect(repaired.body.coverage).toBe('complete');
  expect(repaired.body.files.map(file => file.path)).toEqual(['known.txt', 'repaired.txt']);
});
