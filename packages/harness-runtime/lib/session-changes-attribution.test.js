import { afterEach, beforeEach, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionChangeRuntime } from './session-changes.js';
import { classifySessionChangeTool, sessionChangeReceipt, sessionChangePatchFiles } from './session-changes-tools.js';

const test = (name, fn) => bunTest(name, fn, 60_000);
let base, directory, storage, runtime, count;
const input = (sessionID = 'a', extra = {}) => ({ directory, sessionID, messageID: 'message', userMessageID: 'user', callID: `call_${++count}`, ...extra });
const summary = (rootSessionID = 'a') => runtime.summarize({ directory, rootSessionID });
const write = (file, value) => fs.writeFile(path.join(directory, file), value);
const edit = async (before, after, sessionID = 'a', extra = {}) => {
  const op = input(sessionID, extra); await runtime.begin(op); await write('a.txt', after); await runtime.finish(op);
  await runtime.recordReceipt({ ...op, files: [{ path: 'a.txt', before, after }] }); return op;
};
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-exact-changes-'));
  directory = path.join(base, 'repo'); storage = path.join(base, 'storage'); await fs.mkdir(directory);
  execFileSync('git', ['init', '-q'], { cwd: directory }); await write('a.txt', 'base\n');
  runtime = createSessionChangeRuntime({ directory: storage }); count = 0;
});
afterEach(async () => { await runtime.drain(); await fs.rm(base, { recursive: true, force: true }); }, 30_000);

test('exact receipts recover concurrent file edits without claiming an external writer', async () => {
  const a = input('a', { source: 'opencode', tool: 'edit' }), b = input('b', { source: 'cursor', tool: 'write' });
  await runtime.begin(a); await runtime.begin(b);
  await write('a.txt', 'session a\n'); await write('b.txt', 'session b\n');
  execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync("external.txt", "external only\\n")'], { cwd: directory });
  await runtime.finish(a); await runtime.finish(b);
  expect((await summary()).files).toEqual([]);
  await runtime.recordReceipt({ ...a, files: [{ path: 'a.txt', before: 'base\n', after: 'session a\n' }] });
  await runtime.recordReceipt({ ...b, files: [{ path: 'b.txt', before: null, after: 'session b\n' }] });
  for (const id of ['a', 'b']) {
    const result = await summary(id);
    expect(result).toMatchObject({ coverage: 'complete', reasons: [], fileCount: 1, restoreAvailable: true });
    expect(result.files[0].path).toBe(`${id}.txt`); expect(result.files[0].sessions).toEqual([id]);
  }
  const result = await summary();
  await runtime.restore({ directory, rootSessionID: 'a', revision: result.revision });
  expect(await fs.readFile(path.join(directory, 'b.txt'), 'utf8')).toBe('session b\n');
  expect(await fs.readFile(path.join(directory, 'external.txt'), 'utf8')).toBe('external only\n');
});

test('opaque snapshot observations never assign external edits, even with one managed session', async () => {
  await edit('base\n', 'own\n');
  const opaque = input(); await runtime.begin(opaque); await write('foreign.txt', 'not from this session\n'); await runtime.finish(opaque);
  const result = await summary();
  expect(result.files.map((file) => file.path)).toEqual(['a.txt']);
  expect(result).toMatchObject({ coverage: 'partial', reasons: ['unverified_tool_changes'], restoreAvailable: false });
});

test('interleaved known edits remain reviewable as immutable session-only segments', async () => {
  await edit('base\n', 'first\n');
  await edit('first\n', 'other session\n', 'b');
  await edit('other session\n', 'last\n');
  const result = await summary();
  expect(result).toMatchObject({ coverage: 'complete', reasons: [], fileCount: 1, totalsMode: 'recorded', restoreAvailable: false });
  expect(result.files[0]).toMatchObject({ path: 'a.txt', reviewMode: 'segments', segmentCount: 2, additions: 2, deletions: 2, sessions: ['a'] });
  const first = await runtime.diff({ directory, rootSessionID: 'a', revision: result.revision, file: 'a.txt' });
  const second = await runtime.diff({ directory, rootSessionID: 'a', revision: result.revision, file: 'a.txt', segment: 1 });
  expect(first.patch).toContain('+first'); expect(first.patch).not.toContain('other session');
  expect(second.patch).toContain('-other session'); expect(second.patch).toContain('+last');
  expect(second.segment.sessionID).toBe('a'); expect(second.segmentIndex).toBe(1);
  await expect(runtime.restore({ directory, rootSessionID: 'a', revision: result.revision })).rejects.toMatchObject({ code: 'summary_incomplete' });
  await expect(runtime.diff({ directory, rootSessionID: 'a', revision: result.revision, file: 'a.txt', segment: 2 })).rejects.toMatchObject({ code: 'invalid_change_segment' });
  await edit('last\n', 'later\n', 'b');
  runtime = createSessionChangeRuntime({ directory: storage });
  expect((await runtime.diff({ directory, rootSessionID: 'a', revision: result.revision, file: 'a.txt', segment: 1 })).patch).toBe(second.patch);
});

test('selected children include their descendants but not parents or siblings', async () => {
  await runtime.registerSession({ directory, sessionID: 'a', userMessageID: 'user' });
  await edit('base\n', 'child\n', 'child', { parentID: 'a' });
  await edit('child\n', 'grandchild\n', 'grandchild', { parentID: 'child' });
  const sibling = input('sibling', { parentID: 'a' });
  await runtime.recordReceipt({ ...sibling, files: [{ path: 'sibling.txt', before: null, after: 'sibling\n' }] });
  const child = await summary('child');
  expect(child.sessionCount).toBe(2); expect(child.files.map((file) => file.path)).toEqual(['a.txt']);
  expect(child.files[0].sessions).toEqual(['child', 'grandchild']);
  expect((await summary()).fileCount).toBe(2);
});

test('history repairs overlap and duplicate terminal receipt delivery does not change revisions', async () => {
  const a = input(), b = input('b'); await runtime.begin(a); await runtime.begin(b);
  await write('a.txt', 'recovered\n'); await runtime.finish(a); await runtime.finish(b);
  const receipt = { ...a, files: [{ path: 'a.txt', before: 'base\n', after: 'recovered\n' }], createdAt: 1 };
  await runtime.importHistorical([receipt]); const first = await summary();
  expect(first).toMatchObject({ coverage: 'complete', fileCount: 1, restoreAvailable: true });
  await runtime.recordReceipt(receipt); await runtime.importHistorical([receipt]);
  expect((await summary()).revision).toBe(first.revision);
  await runtime.recordReceipt({ ...receipt, messageID: 'wrong' });
  expect((await summary()).reasons).toContain('capture_identity_reused');
});

test('native patch result metadata is reviewable without fabricated full-file or restore evidence', async () => {
  const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n-base\n+one\n+two\n';
  const receipt = sessionChangeReceipt({ tool: 'oc_edit', state: { status: 'completed', input: { path: 'a.txt' }, metadata: { diff: patch } } });
  await runtime.recordReceipt({ ...input(), ...receipt });
  const result = await summary();
  expect(result).toMatchObject({ coverage: 'complete', totalsMode: 'recorded', restoreAvailable: false });
  expect(result.files[0]).toMatchObject({ additions: 2, deletions: 1, segmentCount: 1 });
  expect((await runtime.diff({ directory, rootSessionID: 'a', revision: result.revision, file: 'a.txt' })).patch).toBe(patch);
  expect(sessionChangeReceipt({ tool: 'apply_patch', state: { status: 'completed', metadata: { diff: patch, syntheticWorkspacePatch: true } } })).toBeNull();
  expect(sessionChangeReceipt({ tool: 'apply_patch', state: { status: 'completed', input: { patchText: patch } } })).toBeNull();
});

test('tool aliases and patch validation exclude reads, arbitrary MCP identities, and malformed receipts', async () => {
  for (const name of ['ls', 'oc_stat', 'skill', 'readToolCall', 'ctx_search', 'devryan_task']) expect(classifySessionChangeTool(name)).toBe('read-only');
  for (const name of ['edit', 'oc_write', 'applyPatchToolCall', 'multiedit', 'MultiEdit', 'write_file']) expect(classifySessionChangeTool(name)).toBe('file');
  expect(classifySessionChangeTool('mcp_custom.edit')).toBe('execution');
  expect(sessionChangePatchFiles('--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1 @@\n-only one\n+new\n')).toEqual([]);
  await expect(runtime.recordReceipt({ ...input(), files: [{ path: '../escape', before: null, after: 'bad' }] })).rejects.toMatchObject({ code: 'unsupported_path' });
});


test('MultiEdit execution results compose only contiguous full-file receipts', () => {
  const part = { tool: 'MultiEdit', state: { status: 'completed', metadata: { results: [
    { filediff: { file: 'a.txt', before: 'base', after: 'first' } },
    { filediff: { file: 'a.txt', before: 'first', after: 'last' } },
    { filediff: { file: 'b.txt', before: null, after: 'new' } },
  ] } } };
  expect(sessionChangeReceipt(part)?.files).toEqual([
    { path: 'a.txt', oldPath: null, before: 'base', after: 'last' },
    { path: 'b.txt', oldPath: null, before: null, after: 'new' },
  ]);
  part.state.metadata.results[1].filediff.before = 'external';
  expect(sessionChangeReceipt(part)).toBeNull();
});
