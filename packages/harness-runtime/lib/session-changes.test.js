import { afterEach, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionChangeRuntime } from './session-changes.js';

// Real Git integration can share the host with builds; keep a bounded budget
// that does not tear down a live fixture at Bun's five-second default.
const test = (name, run) => bunTest(name, run, 60_000);

describe('session changes', () => {
  let base, directory, runtime, n;
  const command = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  const write = (file, text) => fs.writeFile(path.join(directory, file), text);
  const input = (sessionID = 'a') => ({ directory, sessionID, messageID: 'msg_1', userMessageID: 'user_1', callID: `call_${++n}` });
  const summary = (rootSessionID = 'a', sessions = []) => runtime.summarize({ directory, rootSessionID, sessions });
  const change = async (fn, sessionID = 'a') => { const op = input(sessionID); await runtime.begin(op); await fn(); await runtime.finish(op); };
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-session-changes-'));
    directory = path.join(base, 'repo'); await fs.mkdir(directory);
    command('init', '-q'); command('config', 'user.name', 'Test'); command('config', 'user.email', 'test@example.invalid');
    await write('a.txt', 'base\n'); command('add', '.'); command('commit', '-qm', 'base');
    runtime = createSessionChangeRuntime({ directory: path.join(base, 'storage') }); n = 0;
  }, 30_000);
  afterEach(async () => { await runtime.drain(); await fs.rm(base, { recursive: true, force: true }); }, 30_000);
  test('captures shell changes with a dirty staged baseline, preserving index and HEAD', async () => {
    await write('a.txt', 'base\nuser\n'); command('add', 'a.txt');
    const index = command('diff', '--cached'); const head = command('rev-parse', 'HEAD');
    await change(() => write('a.txt', 'base\nuser\nagent\n'));
    const result = await summary();
    expect(result.files).toEqual([{ path: 'a.txt', oldPath: null, status: 'modified', additions: 1, deletions: 0, sessions: ['a'] }]);
    expect(command('diff', '--cached')).toBe(index); expect(command('rev-parse', 'HEAD')).toBe(head);
  });
  test('net edits cancel and add/delete disappears', async () => {
    await change(() => write('new.txt', 'one\n'));
    await change(() => write('new.txt', 'two\n'));
    expect((await summary()).files[0]).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    await change(() => fs.rm(path.join(directory, 'new.txt')));
    expect((await summary()).files).toEqual([]);
  });
  test('independent sessions remain separate and historical diffs stay stable', async () => {
    await change(() => write('a.txt', 'base\na\n'));
    const before = await summary();
    await change(() => write('b.txt', 'b\n'), 'b');
    expect((await summary()).revision).toBe(before.revision);
    expect((await summary('b')).files.map((file) => file.path)).toEqual(['b.txt']);
    expect((await runtime.diff({ directory, rootSessionID: 'a', revision: before.revision, file: 'a.txt' })).patch).toContain('+a');
  });
  test('overlapping operations are unassigned, including after a restart', async () => {
    const a = input('a'); const b = input('b');
    await runtime.begin(a); await runtime.begin(b);
    await write('a.txt', 'concurrent\n'); await runtime.finish(a); await runtime.finish(b);
    runtime = createSessionChangeRuntime({ directory: path.join(base, 'storage') });
    for (const id of ['a', 'b']) {
      const result = await summary(id); expect(result.files).toEqual([]); expect(result.reasons).toContain('overlapping_operations');
    }
  });
  test('read-only shell does not create a warning or files', async () => {
    await change(async () => command('status', '--short'));
    expect(await summary()).toMatchObject({ files: [], coverage: 'complete', reasons: [] });
  });
  test('includes failed tools when the terminal event settles partial writes', async () => {
    const op = input(); await runtime.begin(op); await write('partial.txt', 'written before error\n');
    await runtime.observe({ properties: { part: { type: 'tool', sessionID: 'a', callID: op.callID, state: { status: 'error' } } } });
    expect((await summary()).files[0].path).toBe('partial.txt');
  });
  test('counts a verified child once and detects renamed and binary files', async () => {
    await runtime.registerSession({ directory, sessionID: 'a' });
    const op = { ...input('child'), parentID: 'a' }; await runtime.begin(op);
    await fs.rename(path.join(directory, 'a.txt'), path.join(directory, 'renamed.txt'));
    await write('image.bin', Buffer.from([0, 1, 2])); await runtime.finish(op);
    const result = await summary();
    expect(result.files.find((file) => file.path === 'renamed.txt')).toMatchObject({ status: 'renamed', oldPath: 'a.txt' });
    expect(result.files.find((file) => file.path === 'image.bin')).toMatchObject({ additions: null, deletions: null });
    expect(result.sessionCount).toBe(2);
  });
  test('Undo/Redo use verified changes and preserve independent work', async () => {
    await change(() => write('a.txt', 'base\na\n'));
    await change(() => write('b.txt', 'b\n'), 'b');
    const result = await summary();
    await runtime.restore({ directory, rootSessionID: 'a', revision: result.revision });
    expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(directory, 'b.txt'), 'utf8')).toBe('b\n');
    expect((await summary()).undone).toBe(true);
    await runtime.restore({ directory, rootSessionID: 'a', revision: (await summary()).revision, redo: true });
    expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('base\na\n');
  });
  test('Undo rejects later edits and missing capture remains explicit', async () => {
    await change(() => write('a.txt', 'agent\n')); const result = await summary();
    await write('a.txt', 'other\n');
    await expect(runtime.restore({ directory, rootSessionID: 'a', revision: result.revision })).rejects.toMatchObject({ code: 'working_tree_changed' });
    expect((await summary('old-session')).reasons).toContain('historical_capture_unavailable');
  });
  test('storage limits retain an explicit incomplete result', async () => {
    runtime = createSessionChangeRuntime({ directory: path.join(base, 'storage'), maxOperations: 1 });
    await change(() => write('a.txt', 'first\n')); await change(() => write('a.txt', 'second\n'));
    expect((await summary()).reasons).toContain('storage_limit');
  });

  test('interrupted captures cannot masquerade as completed edits after restarting', async () => {
    await runtime.begin(input()); await write('a.txt', 'interrupted\n');
    await runtime.drain();
    runtime = createSessionChangeRuntime({ directory: path.join(base, 'storage') });
    const result = await summary();
    expect(result.files).toEqual([]); expect(result.reasons).toContain('capture_interrupted');
  });

  test('another writer between same-session edits leaves that file unassigned', async () => {
    await change(() => write('a.txt', 'first\n'));
    await change(() => write('a.txt', 'other\n'), 'b');
    await change(() => write('a.txt', 'last\n'));
    const result = await summary();
    expect(result.files).toEqual([]); expect(result.reasons).toContain('interleaved_file_changes');
  });

  test('retains completed child contributions on child deletion and clears them with the parent', async () => {
    await runtime.registerSession({ directory, sessionID: 'a' });
    const op = { ...input('child'), parentID: 'a' };
    await runtime.begin(op); await write('a.txt', 'child\n'); await runtime.finish(op);
    const before = await summary();
    await runtime.deleteSession('child');
    expect((await summary()).files).toEqual(before.files);
    await runtime.deleteSession('a');
    expect((await summary()).files).toEqual([]);
  });

  test('honors Git ignores and byte limits without touching ignored files', async () => {
    await write('.gitignore', 'ignored.bin\n'); command('add', '.gitignore'); command('commit', '-qm', 'ignore');
    await change(() => write('ignored.bin', 'ignored'));
    expect((await summary()).files).toEqual([]);
    runtime = createSessionChangeRuntime({ directory: path.join(base, 'small-storage'), maxCaptureBytes: 2 });
    await change(() => write('a.txt', 'larger than limit'));
    expect((await summary()).reasons).toContain('capture_limit');
  });
  test('raw snapshots preserve CRLF and do not execute configured clean filters', async () => {
    await write('.gitattributes', '*.txt text eol=lf filter=unsafe\n');
    command('config', 'filter.unsafe.clean', 'touch filter-ran; cat');
    command('config', 'filter.unsafe.required', 'true');
    await write('a.txt', 'base\r\n');
    await change(() => write('a.txt', 'agent\r\n'));
    const result = await summary();
    await runtime.restore({ directory, rootSessionID: 'a', revision: result.revision });
    expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('base\r\n');
    expect(await fs.stat(path.join(directory, 'filter-ran')).catch(() => null)).toBeNull();
  });

  test('captures and restores dangling symlinks without following their targets', async () => {
    await change(() => fs.symlink('/nonexistent-devryan-target', path.join(directory, 'link')));
    const result = await summary();
    expect(result.files[0].path).toBe('link');
    await runtime.restore({ directory, rootSessionID: 'a', revision: result.revision });
    expect(await fs.lstat(path.join(directory, 'link')).catch(() => null)).toBeNull();
    await runtime.restore({ directory, rootSessionID: 'a', revision: (await summary()).revision, redo: true });
    expect(await fs.readlink(path.join(directory, 'link'))).toBe('/nonexistent-devryan-target');
  });

  test('new child work after Undo replaces the undone projection', async () => {
    await change(() => write('a.txt', 'first\n'));
    await runtime.restore({ directory, rootSessionID: 'a', revision: (await summary()).revision });
    const op = { ...input('child'), parentID: 'a' };
    await runtime.begin(op); await write('b.txt', 'child\n'); await runtime.finish(op);
    const result = await summary();
    expect(result.undone).not.toBe(true); expect(result.files.map((file) => file.path)).toEqual(['b.txt']);
  });

  test('keeps selected revisions across later edits and explicitly expires bounded old detail', async () => {
    runtime = createSessionChangeRuntime({ directory: path.join(base, 'storage'), maxRevisions: 1 });
    await change(() => write('a.txt', 'first\n')); const first = await summary();
    await change(() => write('a.txt', 'second\n')); const second = await summary();
    expect((await runtime.diff({ directory, rootSessionID: 'a', revision: first.revision, file: 'a.txt' })).patch).toContain('+first');
    await change(() => write('a.txt', 'third\n')); await summary();
    await expect(runtime.diff({ directory, rootSessionID: 'a', revision: first.revision, file: 'a.txt' })).rejects.toMatchObject({ code: 'summary_detail_expired' });
    expect((await runtime.diff({ directory, rootSessionID: 'a', revision: second.revision, file: 'a.txt' })).patch).toContain('+second');
  });

  test('explicit native file targets disambiguate concurrent different-file edits', async () => {
    const a = { ...input('a'), paths: ['a.txt'] }; const b = { ...input('b'), paths: ['b.txt'] };
    await runtime.begin(a); await runtime.begin(b);
    await write('a.txt', 'a\n'); await write('b.txt', 'b\n');
    await runtime.finish(a); await runtime.finish(b);
    expect((await summary('a')).files.map((file) => file.path)).toEqual(['a.txt']);
    expect((await summary('b')).files.map((file) => file.path)).toEqual(['b.txt']);
    expect((await summary('a')).coverage).toBe('complete');
  });

  test('explicit same-file edits still remain unassigned when windows overlap', async () => {
    const a = { ...input('a'), paths: ['a.txt'] }; const b = { ...input('b'), paths: ['a.txt'] };
    await runtime.begin(a); await runtime.begin(b); await write('a.txt', 'overlap\n');
    await runtime.finish(a); await runtime.finish(b);
    expect((await summary('a')).files).toEqual([]); expect((await summary('b')).files).toEqual([]);
  });

  test('expired before-capture deadlines never attribute writes made after the hook gives up', async () => {
    const op = { ...input(), captureDeadline: Date.now() - 1 };
    await runtime.begin(op); await write('a.txt', 'late\n'); await runtime.finish(op);
    const result = await summary();
    expect(result.files).toEqual([]); expect(result.reasons).toContain('capture_timeout');
  });

  test('stat caching detects same-size writes even when the tool restores modification time', async () => {
    await change(() => write('a.txt', 'one\n'));
    const previous = await fs.stat(path.join(directory, 'a.txt'));
    await change(async () => {
      await write('a.txt', 'two\n');
      await fs.utimes(path.join(directory, 'a.txt'), previous.atime, previous.mtime);
    });
    const result = await summary();
    expect((await runtime.diff({ directory, rootSessionID: 'a', revision: result.revision, file: 'a.txt' })).patch).toContain('+two');
    await runtime.restore({ directory, rootSessionID: 'a', revision: result.revision });
    expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('base\n');
  });

  test('read-only shell calls preserve Undo/Redo before and after restoring files', async () => {
    await change(() => write('a.txt', 'edited\n')); const original = await summary();
    await change(async () => command('status', '--short'));
    expect((await summary()).revision).toBe(original.revision);
    await runtime.restore({ directory, rootSessionID: 'a', revision: original.revision });
    await change(async () => command('status', '--short'));
    const undone = await summary(); expect(undone.undone).toBe(true);
    await runtime.restore({ directory, rootSessionID: 'a', revision: undone.revision, redo: true });
    expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('edited\n');
  });

  test('deduplicates exact receipts but rejects a reused call identity in another message', async () => {
    const op = input(); await runtime.begin(op); await runtime.begin(op);
    await write('a.txt', 'first\n'); await runtime.finish(op); await runtime.finish(op);
    expect((await summary()).coverage).toBe('complete');
    expect((await summary()).files).toHaveLength(1);
    await runtime.begin({ ...op, messageID: 'another-message' });
    await write('a.txt', 'unobserved-reused-call\n');
    expect((await summary()).reasons).toContain('capture_identity_reused');
  });

});
