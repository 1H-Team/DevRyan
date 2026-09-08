import { afterEach, beforeEach, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionChangeRuntime } from './session-changes.js';
import { finishFixtureMutation } from '../test/session-change-fixture.js';
import { openChangeStore, changeKey } from './session-changes-store.js';

const test = (name, run) => bunTest(name, run, 180_000);
let base, directory, storage, runtime, count;
const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
const input = (extra = {}) => ({ directory, sessionID: 'root', messageID: 'message', userMessageID: 'user', callID: `call_${++count}`, ...extra });
const finish = (op) => finishFixtureMutation(runtime, op, storage);
const summary = () => runtime.summarize({ directory, rootSessionID: 'root' });
const digest = async (file) => {
  const hash = crypto.createHash('sha256'), handle = await fs.open(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) { const { bytesRead } = await handle.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest('hex');
  } finally { await handle.close(); }
};

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-changes-scale-')));
  directory = path.join(base, 'repo'); storage = path.join(base, 'storage'); await fs.mkdir(directory);
  git('init', '-q'); await fs.writeFile(path.join(directory, 'a.txt'), 'base\n');
  runtime = createSessionChangeRuntime({ directory: storage }); count = 0;
});
afterEach(async () => { await runtime.drain(); await fs.rm(base, { recursive: true, force: true }); }, 30_000);

test('a scoped edit ignores unrelated checkout size and does not snapshot other files', async () => {
  const huge = await fs.open(path.join(directory, 'large.bin'), 'w'); await huge.truncate(128 * 1024 * 1024); await huge.close();
  // This explicit small policy would fail immediately if scope regressed.
  runtime = createSessionChangeRuntime({ directory: storage, maxCaptureBytes: 16 });
  const op = input({ paths: ['a.txt'] }); await runtime.begin(op);
  await fs.writeFile(path.join(directory, 'a.txt'), 'scoped\n'); await finish(op);
  const result = await summary();
  expect(result.coverage).toBe('complete'); expect(result.fileCount).toBe(1);
  const gitDir = path.join(storage, changeKey(directory), 'git');
  const objects = execFileSync('git', ['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)'], { encoding: 'utf8' });
  expect(objects.split('\n').some((line) => line === `blob ${128 * 1024 * 1024}`)).toBe(false);
});

test('captures and restores files above 64 MiB with bounded JavaScript buffers', async () => {
  const target = path.join(directory, 'large.bin');
  const handle = await fs.open(target, 'w'); await handle.truncate(70 * 1024 * 1024); await handle.close();
  const before = await digest(target);
  let peak = process.memoryUsage().arrayBuffers;
  const initial = peak, timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 5);
  try {
    const op = input(); await runtime.begin(op);
    const changing = await fs.open(target, 'r+'); await changing.write(Buffer.from('changed')); await changing.close();
    const after = await digest(target); await finish(op);
    const result = await summary(); expect(result.coverage).toBe('complete');
    expect(result.files[0]).toMatchObject({ path: 'large.bin', additions: null, deletions: null });
    await runtime.restore({ directory, rootSessionID: 'root', revision: result.revision });
    expect(await digest(target)).toBe(before);
    await runtime.restore({ directory, rootSessionID: 'root', revision: (await summary()).revision, redo: true });
    expect(await digest(target)).toBe(after);
    // Includes the test's own streaming hashes. A readFile/cat-file buffer of
    // the entire 70 MiB blob would exceed this by itself.
    expect(peak - initial).toBeLessThan(60 * 1024 * 1024);
  } finally { clearInterval(timer); }
});

test('checkout capture exceeds 50000 paths without truncating the result', async () => {
  const total = 50_010;
  for (let start = 0; start < total; start += 64) await Promise.all(Array.from({ length: Math.min(64, total - start) }, (_, i) => fs.writeFile(path.join(directory, `file-${start + i}`), '')));
  const op = input({ captureDeadline: Date.now() + 120_000 }); await runtime.begin(op);
  await fs.writeFile(path.join(directory, 'a.txt'), 'changed\n'); await finish({ ...op, captureDeadline: Date.now() + 120_000 });
  expect(await summary()).toMatchObject({ coverage: 'complete', fileCount: 1 });
});

test('summary pages and UTF-8 diff pages stay pinned to their stored revision', async () => {
  const op = input(); await runtime.begin(op);
  for (let start = 0; start < 270; start += 32) await Promise.all(Array.from({ length: Math.min(32, 270 - start) }, (_, i) => fs.writeFile(path.join(directory, `added-${String(start + i).padStart(4, '0')}`), 'added\n')));
  const content = 'é漢🙂'.repeat(25_000);
  await fs.writeFile(path.join(directory, 'a.txt'), content); await finish(op);
  const first = await summary(); expect(first.fileCount).toBe(271); expect(first.files).toHaveLength(128);
  const second = await runtime.summaryPage({ directory, rootSessionID: 'root', revision: first.revision, cursor: first.nextCursor });
  expect(second.files).toHaveLength(128); expect(second.pageIndex).toBe(1);
  await expect(runtime.summaryPage({ directory, rootSessionID: 'root', revision: first.revision, cursor: `${'a'.repeat(64)}:1` })).rejects.toMatchObject({ code: 'invalid_change_cursor' });
  const secondOp = input({ paths: ['a.txt'] }); await runtime.begin(secondOp); await fs.writeFile(path.join(directory, 'a.txt'), 'later'); await finish(secondOp); await summary();
  let cursor = null, patch = '', previous;
  do {
    const result = await runtime.diff({ directory, rootSessionID: 'root', revision: first.revision, file: 'a.txt', cursor });
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(65540);
    if (previous) {
      const back = await runtime.diff({ directory, rootSessionID: 'root', revision: first.revision, file: 'a.txt', cursor: result.previousCursor });
      expect(back.patch).toBe(previous.patch);
    }
    patch += result.patch; cursor = result.nextCursor; previous = result;
  } while (cursor);
  expect(patch).toContain(`+${content}`); expect(patch).not.toContain('later'); expect(patch).not.toContain('\uFFFD');
});

test('repairs failed native receipts individually and retains unrecoverable shell gaps', async () => {
  runtime = createSessionChangeRuntime({ directory: storage, maxCaptureBytes: 1 });
  const edit = input(), shell = input(); await runtime.begin(edit); await runtime.begin(shell);
  runtime = createSessionChangeRuntime({ directory: storage });
  await runtime.importHistorical([{ ...edit, createdAt: 1, files: [{ path: 'a.txt', before: 'base\n', after: 'recovered\n' }] }]);
  const result = await summary();
  expect(result.fileCount).toBe(1); expect(result.reasons).toContain('capture_limit'); expect(result.restoreReasons).toContain('restore_evidence_unavailable');
  await runtime.importHistorical([{ ...shell, createdAt: 2, files: [{ path: 'other.txt', before: null, after: 'also recovered\n' }] }]);
  const recovered = await summary(); expect(recovered.reasons).not.toContain('capture_limit'); expect(recovered.fileCount).toBe(2);
  await expect(runtime.restore({ directory, rootSessionID: 'root', revision: recovered.revision })).rejects.toMatchObject({ code: 'summary_incomplete' });
});

test('migrates more than 2000 operations and registrations without losing V1 evidence', async () => {
  const key = changeKey(directory), gitDir = path.join(storage, key, 'git');
  await fs.mkdir(gitDir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', gitDir]);
  const tree = execFileSync('git', ['--git-dir', gitDir, 'mktree'], { input: '', encoding: 'utf8' }).trim();
  execFileSync('git', ['--git-dir', gitDir, 'update-ref', `refs/devryan/trees/${tree}`, tree]);
  const operations = Array.from({ length: 2010 }, (_, i) => ({ id: changeKey(`root\0old_${i}`), sessionID: 'root', messageID: `old_message_${i}`, callID: `old_${i}`, state: 'complete', createdAt: i, before: tree, after: tree, changes: [] }));
  const sessions = [{ id: 'root', firstUserMessageID: 'user' }, ...Array.from({ length: 2010 }, (_, i) => ({ id: `session_${i}`, firstUserMessageID: 'user' }))];
  const legacy = JSON.stringify({ version: 1, key, record: { version: 1, directory, sessions, operations, issues: [], summaries: {} } });
  await fs.mkdir(path.join(storage, 'records')); const legacyPath = path.join(storage, 'records', `${key}.json`); await fs.writeFile(legacyPath, legacy);
  const op = input({ paths: ['a.txt'], captureDeadline: Date.now() + 120_000 }); await runtime.begin(op); await fs.writeFile(path.join(directory, 'a.txt'), 'new\n'); await finish(op);
  expect(await summary()).toMatchObject({ coverage: 'complete', fileCount: 1 });
  expect(await fs.readFile(legacyPath, 'utf8')).toBe(legacy);
  await runtime.registerSession({ directory, sessionID: 'new_registration' });
  const db = await openChangeStore(storage, gitDir); let registered = 0;
  for await (const entry of db.entries('sessions')) { void entry; registered++; }
  expect(registered).toBe(2012);
});

test('metadata transactions survive an abandoned write and GC retains review and Undo data', async () => {
  runtime = createSessionChangeRuntime({ directory: storage, maintenanceEvery: 1 });
  const op = input({ paths: ['a.txt'] }); await runtime.begin(op); await fs.writeFile(path.join(directory, 'a.txt'), 'first\n'); await finish(op);
  const first = await summary(), gitDir = path.join(storage, changeKey(directory), 'git');
  const abandoned = await openChangeStore(storage, gitDir);
  abandoned.set('meta.json', { version: 999 });
  expect((await (await openChangeStore(storage, gitDir)).get('meta.json')).version).toBe(2);
  const second = input({ paths: ['a.txt'] }); await runtime.begin(second); await fs.writeFile(path.join(directory, 'a.txt'), 'second\n'); await finish(second);
  expect((await runtime.diff({ directory, rootSessionID: 'root', revision: first.revision, file: 'a.txt' })).patch).toContain('+first');
  await runtime.restore({ directory, rootSessionID: 'root', revision: (await summary()).revision });
  expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('base\n');
});

test('storage above 256 MiB still admits captures and unchanged blobs are reused', async () => {
  const target = await fs.open(path.join(directory, 'large.bin'), 'w');
  const block = Buffer.alloc(1024 * 1024), words = new Uint32Array(block.buffer, block.byteOffset, block.length / 4);
  let seed = 123456789;
  for (let i = 0; i < words.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; words[i] = seed; }
  for (let i = 0; i < 270; i++) await target.write(block);
  await target.close();
  const first = input({ captureDeadline: Date.now() + 120_000 }); await runtime.begin(first);
  await fs.writeFile(path.join(directory, 'a.txt'), 'first\n'); await finish(first);
  expect((await summary()).coverage).toBe('complete');
  const gitDir = path.join(storage, changeKey(directory), 'git');
  const stats = () => execFileSync('git', ['--git-dir', gitDir, 'count-objects', '-v'], { encoding: 'utf8' });
  expect(Number(stats().match(/^size: (\d+)$/m)[1]) * 1024).toBeGreaterThan(256 * 1024 * 1024);
  const blobs = () => execFileSync('git', ['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)'], { encoding: 'utf8' }).split('\n').filter((line) => line === `blob ${270 * 1024 * 1024}`).length;
  expect(blobs()).toBe(1);
  const next = input(); await runtime.begin(next); await fs.writeFile(path.join(directory, 'a.txt'), 'second\n'); await finish(next);
  expect((await summary()).coverage).toBe('complete'); expect(blobs()).toBe(1);
});

test('failed metadata persistence rolls Undo back without changing the recorded revision', async () => {
  const op = input({ paths: ['a.txt'] }); await runtime.begin(op); await fs.writeFile(path.join(directory, 'a.txt'), 'edited\n'); await finish(op);
  const result = await summary(), gitDir = path.join(storage, changeKey(directory), 'git');
  const lock = path.join(gitDir, 'refs', 'devryan', 'state.lock'); await fs.writeFile(lock, 'fixture-owned lock');
  try {
    await expect(runtime.restore({ directory, rootSessionID: 'root', revision: result.revision })).rejects.toMatchObject({ code: 'capture_git_failed' });
    expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('edited\n');
  } finally { await fs.rm(lock); }
  expect((await summary()).revision).toBe(result.revision);
});

test('a damaged optional stat cache causes rehashing rather than a capture gap', async () => {
  const first = input({ paths: ['a.txt'] }); await runtime.begin(first); await finish(first);
  const cache = path.join(storage, changeKey(directory), 'stat-cache', `${changeKey('a.txt').slice(0, 2)}.json`);
  await fs.writeFile(cache, 'null');
  const second = input({ paths: ['a.txt'] }); await runtime.begin(second); await fs.writeFile(path.join(directory, 'a.txt'), 'after cache loss\n'); await finish(second);
  expect(await summary()).toMatchObject({ coverage: 'complete', fileCount: 1 });
});

test('a failed migration publication keeps V1 authoritative and retries without losing records', async () => {
  const key = changeKey(directory), gitDir = path.join(storage, key, 'git');
  await fs.mkdir(gitDir, { recursive: true }); execFileSync('git', ['init', '--bare', '-q', gitDir]);
  const legacyPath = path.join(storage, 'records', `${key}.json`);
  await fs.mkdir(path.dirname(legacyPath));
  const legacy = JSON.stringify({ version: 1, key, record: { version: 1, directory,
    sessions: [{ id: 'root', parentID: null, firstUserMessageID: 'user' }], operations: [], issues: [], summaries: {} } });
  await fs.writeFile(legacyPath, legacy);
  const lock = path.join(gitDir, 'refs', 'devryan', 'state.lock');
  await fs.mkdir(path.dirname(lock), { recursive: true }); await fs.writeFile(lock, 'fixture-owned lock');
  await expect(runtime.registerSession({ directory, sessionID: 'new-session' })).rejects.toMatchObject({ code: 'capture_git_failed' });
  expect((await openChangeStore(storage, gitDir)).exists).toBe(false);
  expect(await fs.readFile(legacyPath, 'utf8')).toBe(legacy);
  await fs.rm(lock);
  runtime = createSessionChangeRuntime({ directory: storage });
  await runtime.registerSession({ directory, sessionID: 'new-session' });
  const db = await openChangeStore(storage, gitDir);
  expect(await db.get(`sessions/${changeKey('root')}.json`)).toMatchObject({ id: 'root', firstUserMessageID: 'user' });
  expect(await db.get(`sessions/${changeKey('new-session')}.json`)).toMatchObject({ id: 'new-session' });
  expect(await fs.readFile(legacyPath, 'utf8')).toBe(legacy);
});

test('scoped captures preserve Git ignore policy and literal filenames', async () => {
  await fs.writeFile(path.join(directory, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(directory, 'literal[1].txt'), 'before\n');
  const ignored = input({ paths: ['ignored.txt'] }); await runtime.begin(ignored); await fs.writeFile(path.join(directory, 'ignored.txt'), 'ignored\n'); await finish(ignored);
  expect(await summary()).toMatchObject({ coverage: 'complete', fileCount: 0 });
  const literal = input({ paths: ['literal[1].txt'] }); await runtime.begin(literal); await fs.writeFile(path.join(directory, 'literal[1].txt'), 'after\n'); await finish(literal);
  const result = await summary(); expect(result.fileCount).toBe(1); expect(result.files[0].path).toBe('literal[1].txt');
});

test('segmented UTF-8 patches stay cursor-pinned through collection and restart', async () => {
  runtime = createSessionChangeRuntime({ directory: storage, maintenanceEvery: 1 });
  const content = 'é漢🙂\n'.repeat(15_000);
  const patch = `--- a/patch.txt\n+++ b/patch.txt\n@@ -1 +1,15000 @@\n-old\n${content.split('\n').filter(Boolean).map(line => `+${line}\n`).join('')}`;
  const first = input();
  await runtime.recordReceipt({ ...first, files: [{ path: 'patch.txt', patch }] });
  await runtime.recordReceipt({ ...input(), files: [{ path: 'patch.txt', patch: '--- a/patch.txt\n+++ b/patch.txt\n@@ -1 +1 @@\n-other\n+second\n' }] });
  const recorded = await summary();
  expect(recorded.files[0]).toMatchObject({ reviewMode: 'segments', segmentCount: 2 });
  const initial = await runtime.diff({ directory, rootSessionID: 'root', revision: recorded.revision, file: 'patch.txt' });
  expect(initial.nextCursor).not.toBeNull();
  await expect(runtime.diff({ directory, rootSessionID: 'root', revision: recorded.revision, file: 'patch.txt', segment: 1, cursor: initial.nextCursor })).rejects.toMatchObject({ code: 'invalid_change_cursor' });
  // Settling an unrelated observation forces private GC without a new receipt.
  const unrelated = input({ sessionID: 'other', paths: ['a.txt'] });
  await runtime.begin(unrelated); await runtime.finish(unrelated);
  runtime = createSessionChangeRuntime({ directory: storage });
  let cursor = null, reconstructed = '';
  do {
    const page = await runtime.diff({ directory, rootSessionID: 'root', revision: recorded.revision, file: 'patch.txt', cursor });
    expect(page.segmentIndex).toBe(0); expect(Buffer.byteLength(page.patch)).toBeLessThanOrEqual(65540);
    reconstructed += page.patch; cursor = page.nextCursor;
  } while (cursor);
  expect(reconstructed).toBe(patch);
  expect(reconstructed).not.toContain('\uFFFD');
  expect((await runtime.diff({ directory, rootSessionID: 'root', revision: recorded.revision, file: 'patch.txt', segment: 1 })).patch).toContain('+second');
});
