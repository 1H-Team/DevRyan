import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionChangeHost } from './session-changes-host.js';

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
afterEach(async () => { await host.drain(); await fs.rm(base, { recursive: true, force: true }); });
const endpoint = (action = '') => `/api/openchamber/session/ses_a/changes${action}?directory=${encodeURIComponent(directory)}`;
const tool = (callID) => ({ info: { id: `msg_${callID}`, parentID: 'user_1', role: 'assistant', time: { created: 2 } },
  parts: [{ id: `part_${callID}`, type: 'tool', callID, tool: 'bash', state: { status: 'completed' } }] });

test('private hook receipts feed the same summary, diff, and restore HTTP contract', async () => {
  await host.plugin({ action: 'message', sessionID: 'ses_a', directory, userMessageID: 'user_1' });
  messages.push(tool('call_a'));
  const input = { sessionID: 'ses_a', directory, callID: 'call_a' };
  await host.plugin({ ...input, action: 'before' });
  await fs.writeFile(path.join(directory, 'shell.txt'), 'from shell\n');
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
  expect(result.body.reasons).toContain('historical_restore_unavailable');
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
  messages.push(tool('call_a'));
  const input = { sessionID: 'ses_a', directory, callID: 'call_a' };
  await host.plugin({ ...input, action: 'before' });
  await fs.writeFile(path.join(directory, 'shell.txt'), 'keep\n');
  await host.plugin({ ...input, action: 'after' });
  const { body } = await host.handleRequest('GET', endpoint());
  statuses = { other: { type: 'busy' } };
  expect((await host.handleRequest('POST', endpoint('/undo'), { revision: body.revision })).body.code).toBe('directory_busy');
  statuses = [];
  expect((await host.handleRequest('POST', endpoint('/undo'), { revision: body.revision })).body.code).toBe('session_status_unavailable');
  expect(await fs.readFile(path.join(directory, 'shell.txt'), 'utf8')).toBe('keep\n');
});
