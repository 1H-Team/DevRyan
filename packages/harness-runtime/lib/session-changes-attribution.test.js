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
  expect(result).toMatchObject({ coverage: 'complete', totalsMode: 'recorded', restoreAvailable: false, current: { state: 'uncertain', uncertainFileCount: 1 } });
  expect(result.files[0]).toMatchObject({ additions: 2, deletions: 1, segmentCount: 1 });
  expect((await runtime.diff({ directory, rootSessionID: 'a', revision: result.revision, file: 'a.txt' })).patch).toBe(patch);
  expect(sessionChangeReceipt({ tool: 'apply_patch', state: { status: 'completed', metadata: { diff: patch, syntheticWorkspacePatch: true } } })).toBeNull();
  expect(sessionChangeReceipt({ tool: 'apply_patch', state: { status: 'completed', input: { patchText: patch } } })).toBeNull();
});

test('tool aliases and patch validation exclude reads, arbitrary MCP identities, and malformed receipts', async () => {
  for (const name of ['ls', 'oc_stat', 'skill', 'readToolCall', 'ctx_search', 'devryan_task', 'devryan_plan_read']) expect(classifySessionChangeTool(name)).toBe('read-only');
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


test('live reconciliation preserves captured history through shell restore and same-path foreign edits', async () => {
  await edit('base\n', 'own\n');
  const captured = await summary();
  expect(captured.current).toMatchObject({ state: 'verified', verifiedFileCount: 1 });
  await write('a.txt', 'own\nforeign\n');
  const overlap = await summary();
  expect(overlap.revision).toBe(captured.revision);
  expect(overlap.current).toMatchObject({ state: 'uncertain', uncertainFileCount: 1 });
  await write('a.txt', 'base\n');
  const restored = await summary();
  expect(restored.revision).toBe(captured.revision);
  expect(restored.fileCount).toBe(1);
  expect(restored.current).toMatchObject({ state: 'restored', restoredFileCount: 1 });
  expect((await runtime.diff({ directory, rootSessionID: 'a', revision: captured.revision, file: 'a.txt' })).patch).toContain('+own');
});


for (const ancestor of ['symlink', 'file']) {
  for (const operation of ['added', 'deleted']) {
    test(`live ${operation} evidence stays uncertain under a ${ancestor} ancestor`, async () => {
      const parent = path.join(directory, 'nested');
      await fs.mkdir(parent);
      const before = operation === 'deleted' ? 'original\n' : null;
      const after = operation === 'added' ? 'owned\n' : null;
      if (before !== null) await write('nested/owned.txt', before);
      const op = input();
      await runtime.begin(op);
      if (after !== null) await write('nested/owned.txt', after);
      else await fs.unlink(path.join(parent, 'owned.txt'));
      await runtime.finish(op);
      await runtime.recordReceipt({ ...op, files: [{ path: 'nested/owned.txt', before, after }] });
      const captured = await summary();
      expect(captured.current).toMatchObject({ state: 'verified', verifiedFileCount: 1 });
      await fs.rm(parent, { recursive: true });
      if (ancestor === 'file') await fs.writeFile(parent, 'foreign parent\n');
      else {
        const outside = path.join(base, 'outside');
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, 'owned.txt'), 'foreign content\n');
        await fs.symlink(outside, parent);
      }
      const observed = await summary();
      expect(observed.revision).toBe(captured.revision);
      expect(observed.current).toMatchObject({
        state: 'uncertain', verifiedFileCount: 0, restoredFileCount: 0,
        uncertainFileCount: 1, reasons: ['current_path_unavailable'],
      });
    });
  }
}

test('live refresh writes no snapshot refs and bounded reads remain uncertain', async () => {
  await edit('base\n', 'own\n');
  const captured = await summary();
  const gitDir = path.join(storage, captured.worktreeID, 'git');
  const refs = () => execFileSync('git', ['--git-dir', gitDir, 'show-ref'], { encoding: 'utf8' });
  const before = refs();
  await write('a.txt', 'foreign\n');
  const observed = await runtime.summaryPage({ directory, rootSessionID: 'a', revision: captured.revision });
  expect(observed.current.state).toBe('uncertain');
  expect(refs()).toBe(before);
  await write('a.txt', Buffer.alloc(8 * 1024 * 1024 + 1));
  const limited = await summary();
  expect(limited.current).toMatchObject({ state: 'uncertain', checkedFileCount: 0, uncertainFileCount: 1, reasons: ['current_read_limit'] });
  expect(limited.revision).toBe(captured.revision);
});

test('capture gaps retain descendant attribution and current missing files cannot masquerade as restored', async () => {
  await runtime.registerSession({ directory, sessionID: 'a', userMessageID: 'user' });
  await edit('base\n', 'child\n', 'child', { parentID: 'a' });
  const opaque = input('child'); await runtime.begin(opaque); await write('foreign.txt', 'external\n'); await runtime.finish(opaque);
  await fs.rm(path.join(directory, 'a.txt'));
  const result = await summary();
  expect(result.coverageBySession).toContainEqual({ sessionID: 'child', reasons: ['unverified_tool_changes'] });
  expect(result.files[0].sessions).toEqual(['child']);
  expect(result.current).toMatchObject({ state: 'uncertain', uncertainFileCount: 1 });
});


test('missing expected execution receipts expose the owning descendant coverage gap', async () => {
  await runtime.registerSession({ directory, sessionID: 'a', userMessageID: 'user' });
  const result = await runtime.summarize({ directory, rootSessionID: 'a', sessions: [{ id: 'child' }],
    expectedCalls: [{ sessionID: 'child', callID: 'missing' }] });
  expect(result.reasons).toEqual(['missing_capture']);
  expect(result.coverageBySession).toContainEqual({ sessionID: 'child', reasons: ['missing_capture'] });
  expect(result.coverageBySession).toContainEqual({ sessionID: 'a', reasons: [] });
});

test('live reconciliation tallies each row once and counts every foreign edit', async () => {
  await write('old.txt', 'moved content\n');
  const op = input(); await runtime.begin(op);
  for (const file of ['b.txt', 'c.txt', 'd.txt']) await write(file, `${file} own\n`);
  await fs.rename(path.join(directory, 'old.txt'), path.join(directory, 'new.txt'));
  await runtime.finish(op);
  await runtime.recordReceipt({ ...op, files: [
    ...['b.txt', 'c.txt', 'd.txt'].map((file) => ({ path: file, before: null, after: `${file} own\n` })),
    { path: 'old.txt', before: 'moved content\n', after: null }, { path: 'new.txt', before: null, after: 'moved content\n' },
  ] });
  const captured = await summary();
  expect(captured.fileCount).toBe(4);
  expect(captured.files.find((file) => file.path === 'new.txt')).toMatchObject({ status: 'renamed', oldPath: 'old.txt' });
  expect(captured.current).toMatchObject({ state: 'verified', verifiedFileCount: 4, uncertainFileCount: 0, foreignModifiedCount: 0 });
  for (const file of ['b.txt', 'c.txt', 'new.txt']) await write(file, 'foreign\n');
  const observed = await summary();
  expect(observed.current).toMatchObject({ state: 'uncertain', verifiedFileCount: 1, restoredFileCount: 0,
    uncertainFileCount: 3, foreignModifiedCount: 3, checkedFileCount: 4, reasons: ['current_content_diverged'] });
  expect(observed.files.filter(file => file.verification.state === 'uncertain').map(file => file.path))
    .toEqual(['b.txt', 'c.txt', 'new.txt']);
  expect(observed.files.find(file => file.path === 'b.txt').verification.reason).toBe('current_content_diverged');
});

test('live reconciliation counts rows past the read limit as uncertain', async () => {
  const files = Array.from({ length: 257 }, (_, index) => `f${String(index).padStart(3, '0')}.txt`);
  const op = input(); await runtime.begin(op);
  for (const file of files) await write(file, `${file}\n`);
  await runtime.finish(op);
  await runtime.recordReceipt({ ...op, files: files.map((file) => ({ path: file, before: null, after: `${file}\n` })) });
  const result = await summary();
  expect(result.fileCount).toBe(257);
  expect(result.current).toMatchObject({ state: 'uncertain', checkedFileCount: 256, verifiedFileCount: 256,
    uncertainFileCount: 1, foreignModifiedCount: 0, reasons: ['current_read_limit'] });
});

test('out-of-order historical bodies compose by content lineage rather than tool start time', async () => {
  const bodies = [['base\n', 'one\n'], ['one\n', 'two\n'], ['two\n', 'last\n']];
  const calls = bodies.map(([before, after], index) => ({ ...input('a', { createdAt: 30 - index * 10 }),
    source: 'confined-execution', files: [{ path: 'a.txt', before: { bytes: Buffer.from(before), mode: '100644' },
      after: { bytes: Buffer.from(after), mode: '100644' } }] }));
  for (const index of [2, 0, 1]) await runtime.recordReceipt(calls[index]);
  await write('a.txt', 'last\n');
  const result = await summary();
  expect(result).toMatchObject({ coverage: 'complete', totalsMode: 'net', restoreAvailable: true, hasUnattributedMutations: false });
  const patch = await runtime.diff({ directory, rootSessionID: 'a', revision: result.revision, file: 'a.txt' });
  expect(patch.patch).toContain('-base'); expect(patch.patch).toContain('+last'); expect(patch.patch).not.toContain('+one');
  runtime = createSessionChangeRuntime({ directory: storage });
  await runtime.recordReceipt(calls[0]);
  expect((await summary()).revision).toBe(result.revision);
  await runtime.restore({ directory, rootSessionID: 'a', revision: result.revision });
  expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('base\n');
});

test('publication order composes sibling contributions while each selected child stays scoped', async () => {
  await runtime.registerSession({ directory, sessionID: 'a', userMessageID: 'user' });
  const receipts = [['child', 'base\n', 'one\n', 1, 900], ['sibling', 'one\n', 'last\n', 2, 100]].map(
    ([sessionID, before, after, publicationSequence, createdAt]) => ({ ...input(sessionID, { parentID: 'a', createdAt }),
      publicationSequence, source: 'confined-execution', files: [{ path: 'a.txt', before: { bytes: Buffer.from(before), mode: '100644' },
        after: { bytes: Buffer.from(after), mode: '100644' } }] }));
  for (const receipt of receipts.toReversed()) await runtime.recordReceipt(receipt);
  await write('a.txt', 'last\n');
  const root = await summary();
  expect(root).toMatchObject({ coverage: 'complete', fileCount: 1, totalsMode: 'net', restoreAvailable: true, sessionCount: 3 });
  expect(root.files[0].sessions.sort()).toEqual(['child', 'sibling']);
  expect((await summary('child')).files[0].sessions).toEqual(['child']);
  expect((await summary('sibling')).files[0].sessions).toEqual(['sibling']);
  await runtime.recordReceipt(receipts[0]);
  runtime = createSessionChangeRuntime({ directory: storage });
  expect((await summary()).revision).toBe(root.revision);
});

test('publication order refuses to reorder a disconnected sibling branch into restorable lineage', async () => {
  for (const [index, before, after] of [[1, 'base\n', 'one\n'], [2, 'base\n', 'other\n'], [3, 'one\n', 'base\n']]) {
    await runtime.recordReceipt({ ...input(), source: 'confined-execution', publicationSequence: index,
      files: [{ path: 'a.txt', before: { bytes: Buffer.from(before), mode: '100644' }, after: { bytes: Buffer.from(after), mode: '100644' } }] });
  }
  const result = await summary();
  expect(result).toMatchObject({ totalsMode: 'recorded', restoreAvailable: false });
  await expect(runtime.restore({ directory, rootSessionID: 'a', revision: result.revision })).rejects.toMatchObject({ code: 'summary_incomplete' });
});

test('unattributed evidence stays explicit until the exact missing call is repaired', async () => {
  await runtime.registerSession({ directory, sessionID: 'a', userMessageID: 'user' });
  const expectedCalls = [{ sessionID: 'a', callID: 'late' }];
  expect(await runtime.summarize({ directory, rootSessionID: 'a', expectedCalls })).toMatchObject({ hasUnattributedMutations: true, restoreAvailable: false });
  await runtime.recordReceipt({ ...input('a', { callID: 'late' }), source: 'confined-execution', files: [] });
  expect(await runtime.summarize({ directory, rootSessionID: 'a', expectedCalls })).toMatchObject({ hasUnattributedMutations: false, coverage: 'complete' });
});

test('late receipt repair preserves renames, deletions and executable modes across restart and stale delivery', async () => {
  await write('old.sh', '#!/bin/sh\necho old\n'); await fs.chmod(path.join(directory, 'old.sh'), 0o755);
  await write('gone.txt', 'remove\n');
  const scope = input(); await runtime.finish(scope);
  const receipt = { ...scope, source: 'confined-execution', publicationSequence: 1, files: [
    { path: 'new.sh', oldPath: 'old.sh', before: { bytes: Buffer.from('#!/bin/sh\necho old\n'), mode: '100755' },
      after: { bytes: Buffer.from('#!/bin/sh\necho new\n'), mode: '100755' } },
    { path: 'gone.txt', before: { bytes: Buffer.from('remove\n'), mode: '100644' }, after: null },
  ] };
  runtime = createSessionChangeRuntime({ directory: storage });
  await runtime.recordReceipt(receipt);
  await fs.rename(path.join(directory, 'old.sh'), path.join(directory, 'new.sh'));
  await write('new.sh', '#!/bin/sh\necho new\n'); await fs.rm(path.join(directory, 'gone.txt'));
  const captured = await summary();
  expect(captured).toMatchObject({ coverage: 'complete', restoreAvailable: true });
  runtime = createSessionChangeRuntime({ directory: storage });
  await runtime.recordReceipt({ ...receipt, complete: false });
  expect((await summary()).revision).toBe(captured.revision);
  await runtime.restore({ directory, rootSessionID: 'a', revision: captured.revision });
  expect(await fs.readFile(path.join(directory, 'old.sh'), 'utf8')).toBe('#!/bin/sh\necho old\n');
  expect((await fs.stat(path.join(directory, 'old.sh'))).mode & 0o111).toBe(0o111);
  expect(await fs.readFile(path.join(directory, 'gone.txt'), 'utf8')).toBe('remove\n');
  expect(await fs.stat(path.join(directory, 'new.sh')).catch(error => error.code)).toBe('ENOENT');
});

test('an unsequenced historical bridge cannot reverse authoritative publication order', async () => {
  for (const [publicationSequence, before, after] of [[2, 'base\n', 'one\n'], [undefined, 'one\n', 'two\n'], [1, 'two\n', 'last\n']]) {
    await runtime.recordReceipt({ ...input(), source: 'confined-execution', publicationSequence,
      files: [{ path: 'a.txt', before: { bytes: Buffer.from(before), mode: '100644' }, after: { bytes: Buffer.from(after), mode: '100644' } }] });
  }
  expect(await summary()).toMatchObject({ totalsMode: 'recorded', restoreAvailable: false });
});
