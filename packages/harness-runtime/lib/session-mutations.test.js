import { afterEach, expect, spyOn, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';

const roots = [];
const test = (name, body) => bunTest(name, body, 60_000);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-mutations-')); roots.push(root);
  const directory = path.join(root, 'project'), storage = path.join(root, 'private');
  await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
  const runtime = createSessionMutationRuntime({ directory: storage, ...options });
  const begin = (sessionID, userMessageID, callID, extra = {}) => runtime.begin({ directory, sessionID, userMessageID,
    messageID: `${userMessageID}-assistant`, callID, ...extra });
  const finish = (lease) => runtime.finish({ directory, token: lease.token });
  const revert = async (sessionID, messageID) => {
    const tx = await runtime.prepareRevert({ directory, sessionID, messageID });
    return runtime.settleRevert({ directory, transactionID: tx.id, commit: true });
  };
  return { runtime, root, directory, storage, begin, finish, revert,
    read: (name) => fs.readFile(path.join(directory, name), 'utf8'),
    write: (name, text) => fs.writeFile(path.join(directory, name), text) };
}

test('private executions publish only owned changes, then selectively revert and redo after restart', async () => {
  const f = await fixture();
  await f.write('x', 'a=1 b=2\n');
  const a = await f.begin('a', 'prompt-a', 'call-a'), b = await f.begin('b', 'prompt-b', 'call-b');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=3 b=2\n');
  await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=1 b=4\n');
  expect(await f.read('x')).toBe('a=1 b=2\n');
  await f.finish(a); await f.finish(b);
  expect(await f.read('x')).toBe('a=3 b=4\n');
  await f.revert('a', 'prompt-a');
  expect(await f.read('x')).toBe('a=1 b=4\n');
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  const redo = await restarted.prepareRedo({ directory: f.directory, sessionID: 'a' });
  await restarted.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true });
  expect(await f.read('x')).toBe('a=3 b=4\n');
});

test('late unrelated execution keeps its changes without resurrecting reverted bytes', async () => {
  const f = await fixture(); await f.write('x', 'a=1 b=2');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=3 b=2'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=3 b=4');
  await f.revert('a', 'pa'); await f.finish(b);
  expect(await f.read('x')).toBe('a=1 b=4');
});

test('sessions in separate subdirectories share one publication history and preserve their cwd', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.directory, 'nested'));
  await f.write('nested/x', 'a=1; b=2');
  const a = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(a.viewDirectory, 'nested/x'), 'a=3; b=2'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb', { directory: path.join(f.directory, 'nested') });
  expect(b.projectDirectory).toBe(await fs.realpath(f.directory));
  expect(b.workingDirectory).toBe(path.join(b.viewDirectory, 'nested'));
  expect(await fs.readFile(path.join(b.workingDirectory, 'x'), 'utf8')).toBe('a=3; b=2');
  await fs.writeFile(path.join(b.workingDirectory, 'x'), 'a=3; b=4');
  await f.revert('a', 'pa');
  await f.runtime.finish({ directory: b.directory, token: b.token });
  expect(await f.read('nested/x')).toBe('a=1; b=4');
  await expect(f.runtime.registerPrompt({ directory: f.directory, sessionID: 'b', userMessageID: 'other' }))
    .rejects.toMatchObject({ code: 'session_directory_mismatch' });
});

test('durable descendant chronology includes work after the boundary and fences late children', async () => {
  const f = await fixture(); await f.write('x', 'x=0 y=0 z=0');
  const root = await f.begin('root', 'p0', 'root0'); await f.finish(root);
  const child0 = await f.begin('child', 'pc0', 'child0', { parentID: 'root' });
  await fs.writeFile(path.join(child0.viewDirectory, 'x'), 'x=1 y=0 z=0'); await f.finish(child0);
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'root', userMessageID: 'p1' });
  const child1 = await f.begin('child', 'pc1', 'child1', { parentID: 'root' });
  await fs.writeFile(path.join(child1.viewDirectory, 'x'), 'x=1 y=2 z=0'); await f.finish(child1);
  const grandchild = await f.begin('grandchild', 'pg', 'g', { parentID: 'child' });
  await fs.writeFile(path.join(grandchild.viewDirectory, 'x'), 'x=1 y=2 z=3');
  await f.revert('root', 'p1');
  expect(await f.read('x')).toBe('x=1 y=0 z=0');
  await expect(f.finish(grandchild)).rejects.toMatchObject({ code: 'execution_reverted' });
  expect(await f.read('x')).toBe('x=1 y=0 z=0');
});

test('rename preserves file identity and another session contribution survives the creator undo', async () => {
  const f = await fixture();
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'new'), 'A\n'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.appendFile(path.join(b.viewDirectory, 'new'), 'B\n'); await f.finish(b);
  await f.revert('a', 'pa'); expect(await f.read('new')).toBe('B\n');
  const c = await f.begin('c', 'pc', 'cc'); await fs.rename(path.join(c.viewDirectory, 'new'), path.join(c.viewDirectory, 'renamed')); await f.finish(c);
  const d = await f.begin('d', 'pd', 'cd'); await fs.appendFile(path.join(d.viewDirectory, 'renamed'), 'D\n'); await f.finish(d);
  await f.revert('c', 'pc');
  expect(await f.read('new')).toBe('B\nD\n');
});

test('unrelated creation of the same path is preserved when the earlier creation is reverted', async () => {
  const f = await fixture();
  const a = await f.begin('a', 'pa', 'ca'), b = await f.begin('b', 'pb', 'cb');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'A'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'B');
  await f.finish(a); await f.finish(b); await f.revert('a', 'pa');
  expect(await f.read('x')).toBe('B');
});

test('explicit rename ancestry survives a replacement inode and later foreign edits', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=2');
  const a = await f.begin('a', 'pa', 'ca');
  await fs.rename(path.join(a.viewDirectory, 'x'), path.join(a.viewDirectory, 'moved'));
  await fs.writeFile(path.join(a.viewDirectory, 'replacement'), 'a=3; b=2');
  await fs.rename(path.join(a.viewDirectory, 'replacement'), path.join(a.viewDirectory, 'moved'));
  await f.runtime.finish({ directory: f.directory, token: a.token, renames: [{ from: 'x', to: 'moved' }] });
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'moved'), 'a=3; b=4'); await f.finish(b);
  await f.revert('a', 'pa'); expect(await f.read('x')).toBe('a=1; b=4');
  await expect(f.read('moved')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('successive replacements preserve the later replacement when its ancestor is reverted', async () => {
  const f = await fixture(); await f.write('x', 'x=1; x=1');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'x=2; x=1'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'x=3; x=1'); await f.finish(b);
  await f.revert('a', 'pa'); expect(await f.read('x')).toBe('x=3; x=1');
});

test('accepted materialization recovers idempotently after a host crash', async () => {
  let crash = true;
  const f = await fixture({ onMaterialize: () => { if (crash) throw new Error('fixture crash'); } });
  await f.write('x', 'old'); const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'new');
  await expect(f.finish(a)).rejects.toThrow('fixture crash'); crash = false;
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  await restarted.registerPrompt({ directory: f.directory, sessionID: 'b', userMessageID: 'pb' });
  expect(await f.read('x')).toBe('new');
  await restarted.finish({ directory: f.directory, token: a.token });
  expect(await f.read('x')).toBe('new');
  expect((await restarted.finish({ directory: f.directory, token: a.token })).files).toEqual([{ path: 'x', status: 'modified' }]);
});

test('a crash during revert retains its decision, receipt and redo ownership', async () => {
  let crash = false;
  const f = await fixture({ onMaterialize: () => { if (crash) throw new Error('fixture crash'); } });
  await f.write('x', '0'); const a = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), '1'); await f.finish(a);
  const tx = await f.runtime.prepareRevert({ directory: f.directory, sessionID: 'a', messageID: 'pa' });
  crash = true;
  await expect(f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true })).rejects.toThrow('fixture crash');
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  const result = await restarted.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(result.files).toEqual([{ path: 'x', status: 'modified' }]); expect(await f.read('x')).toBe('0');
  const redo = await restarted.prepareRedo({ directory: f.directory, sessionID: 'a' });
  await restarted.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true });
  expect(await f.read('x')).toBe('1');
});

test('recovery refuses to overwrite a newer foreign edit', async () => {
  const f = await fixture({ onMaterialize: () => { throw new Error('fixture crash'); } });
  await f.write('x', '0'); const a = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), '1'); await expect(f.finish(a)).rejects.toThrow('fixture crash');
  await f.write('x', 'foreign');
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  await expect(restarted.finish({ directory: f.directory, token: a.token })).rejects.toMatchObject({ code: 'mutation_recovery_required' });
  expect(await f.read('x')).toBe('foreign');
});

test('duplicate execution identities must match the original immutable scope', async () => {
  const f = await fixture(); const a = await f.begin('a', 'pa', 'ca');
  expect((await f.begin('a', 'pa', 'ca')).token).toBe(a.token);
  await expect(f.begin('a', 'other', 'ca')).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
});

test('moving the revert boundary accumulates the exact operation set for redo', async () => {
  const f = await fixture(); await f.write('x', '0');
  const a = await f.begin('a', 'p1', 'c1'); await fs.writeFile(path.join(a.viewDirectory, 'x'), '1'); await f.finish(a);
  const b = await f.begin('a', 'p2', 'c2'); await fs.writeFile(path.join(b.viewDirectory, 'x'), '2'); await f.finish(b);
  await f.revert('a', 'p2'); expect(await f.read('x')).toBe('1');
  const earlier = await f.revert('a', 'p1'); expect(await f.read('x')).toBe('0');
  expect(await f.revert('a', 'p2')).toEqual(earlier);
  expect(await f.read('x')).toBe('0');
  await expect(f.begin('a', 'p2', 'stale')).rejects.toMatchObject({ code: 'execution_reverted' });
  const redo = await f.runtime.prepareRedo({ directory: f.directory, sessionID: 'a' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true });
  expect(await f.read('x')).toBe('2');
});

test('a prepared revert fences new descendants and includes children without file changes', async () => {
  const f = await fixture();
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'a', userMessageID: 'pa' });
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'b', userMessageID: 'pb', parentID: 'a' });
  const tx = await f.runtime.prepareRevert({ directory: f.directory, sessionID: 'a', messageID: 'pa' });
  expect(tx.targets).toContainEqual({ id: 'b', targetMessageID: 'pb' });
  await expect(f.begin('late', 'pl', 'cl', { parentID: 'b' })).rejects.toMatchObject({ code: 'session_reverting' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  await expect(f.begin('late', 'pl', 'cl', { parentID: 'b', parentGeneration: 0 })).rejects.toMatchObject({ code: 'execution_reverted' });
});

test('file Undo and conversation Revert retain independent decisions over the same owned operations', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=2');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=3; b=2'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=3; b=4');
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review-1', calls: [{ sessionID: 'a', callID: 'ca' }] };
  const undo = await f.runtime.prepareFileRestore(selection);
  await f.runtime.settleRevert({ directory: f.directory, transactionID: undo.id, commit: true });
  await f.finish(b); expect(await f.read('x')).toBe('a=1; b=4');
  expect((await f.runtime.prepareFileRestore(selection)).id).toBe(undo.id);
  await f.revert('a', 'pa');
  const redo = await f.runtime.prepareRedo({ directory: f.directory, sessionID: 'a' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true });
  expect(await f.read('x')).toBe('a=1; b=4');
  const fileRedo = await f.runtime.prepareFileRestore({ ...selection, revision: 'review-2', redo: true });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: fileRedo.id, commit: true });
  expect(await f.read('x')).toBe('a=3; b=4');
});

test('an already reverted session boundary can expand to its descendants without losing Redo', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=2');
  const root = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(root.viewDirectory, 'x'), 'a=3; b=2'); await f.finish(root);
  const child = await f.begin('child', 'pc', 'cc', { parentID: 'a' });
  await fs.writeFile(path.join(child.viewDirectory, 'x'), 'a=3; b=4'); await f.finish(child);
  const sessionOnly = await f.runtime.prepareRevert({ directory: f.directory, sessionID: 'a', messageID: 'pa', scope: 'session' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: sessionOnly.id, commit: true });
  expect(await f.read('x')).toBe('a=1; b=4');
  const tree = await f.runtime.prepareRevert({ directory: f.directory, sessionID: 'a', messageID: 'pa', scope: 'tree' });
  expect(tree.id).not.toBe(sessionOnly.id);
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tree.id, commit: true });
  expect(await f.read('x')).toBe('a=1; b=2');
  const redo = await f.runtime.prepareRedo({ directory: f.directory, sessionID: 'a' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true });
  expect(await f.read('x')).toBe('a=3; b=4');
});

test('a foreign deletion keeps shadowed same-path creations absent', async () => {
  const f = await fixture();
  const a = await f.begin('a', 'pa', 'ca'), b = await f.begin('b', 'pb', 'cb');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'A'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'B');
  await f.finish(a); await f.finish(b);
  const c = await f.begin('c', 'pc', 'cc'); await fs.rm(path.join(c.viewDirectory, 'x')); await f.finish(c);
  await expect(f.read('x')).rejects.toMatchObject({ code: 'ENOENT' });
  await f.revert('b', 'pb'); await expect(f.read('x')).rejects.toMatchObject({ code: 'ENOENT' });
  await f.revert('c', 'pc'); expect(await f.read('x')).toBe('A');
});

test('mode ownership is independent from a later binary replacement', async () => {
  const f = await fixture(); await f.write('x', '\0initial');
  const a = await f.begin('a', 'pa', 'ca'); await fs.chmod(path.join(a.viewDirectory, 'x'), 0o755); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), '\0replacement'); await f.finish(b);
  await f.revert('a', 'pa');
  expect(await f.read('x')).toBe('\0replacement');
  expect((await fs.stat(path.join(f.directory, 'x'))).mode & 0o111).toBe(0);
});

test('a later chmod does not take ownership of earlier binary contents', async () => {
  const f = await fixture(); await f.write('x', '\0initial');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), '\0replacement'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.chmod(path.join(b.viewDirectory, 'x'), 0o755); await f.finish(b);
  await f.revert('a', 'pa');
  expect(await f.read('x')).toBe('\0initial');
  expect((await fs.stat(path.join(f.directory, 'x'))).mode & 0o111).toBe(0o111);
});

test('a new prompt invalidates redo when its provider history will be discarded', async () => {
  const f = await fixture();
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'a', userMessageID: 'pa' });
  await f.revert('a', 'pa');
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'a', userMessageID: 'next' });
  await expect(f.runtime.prepareRedo({ directory: f.directory, sessionID: 'a' })).rejects.toMatchObject({ code: 'redo_unavailable' });
});

test('descendants of an earlier dispatch retain their edits after a later parent boundary', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=2');
  const earlier = await f.begin('root', 'p0', 'dispatch');
  await f.runtime.registerChild({ directory: f.directory, sessionID: 'child', parentID: 'root', parentCallID: 'dispatch' });
  await f.finish(earlier);
  const later = await f.begin('root', 'p1', 'later');
  await fs.writeFile(path.join(later.viewDirectory, 'x'), 'a=3; b=2'); await f.finish(later);
  const child = await f.begin('child', 'pc', 'cc', { parentID: 'root' });
  await fs.writeFile(path.join(child.viewDirectory, 'x'), 'a=3; b=4'); await f.finish(child);
  await f.revert('root', 'p1'); expect(await f.read('x')).toBe('a=1; b=4');
  await f.revert('root', 'p0'); expect(await f.read('x')).toBe('a=1; b=2');
});

test('file Undo fences hidden descendants and call aliases select one publication', async () => {
  const f = await fixture(); await f.write('x', 'before');
  const root = await f.begin('a', 'pa', 'turn'); await fs.writeFile(path.join(root.viewDirectory, 'x'), 'after'); await f.finish(root);
  await f.runtime.aliasCalls({ directory: f.directory, token: root.token, calls: ['tool-1', 'tool-2'] });
  await f.runtime.registerChild({ directory: f.directory, sessionID: 'hidden', parentID: 'a', parentCallID: 'turn' });
  const child = await f.begin('hidden', 'pc', 'cc', { parentID: 'a' });
  const tx = await f.runtime.prepareFileRestore({ directory: f.directory, sessionID: 'a', revision: 'review',
    calls: ['tool-1', 'tool-2'].map((callID) => ({ sessionID: 'a', callID })) });
  expect(tx.members).toContain('hidden');
  await expect(f.runtime.assertAdmission({ directory: f.directory, sessionID: 'hidden' })).rejects.toMatchObject({ code: 'session_reverting' });
  await expect(f.finish(child)).rejects.toMatchObject({ code: 'execution_reverted' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(await f.read('x')).toBe('before');
});

test('a lost reservation response cannot launch later or reuse the cancelled call', async () => {
  const f = await fixture();
  const a = await f.begin('a', 'pa', 'ca');
  await f.runtime.claimLease({ directory: f.directory, token: a.token, kind: 'process' });
  await f.runtime.cancelUnstartedCall({ directory: f.directory, sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' });
  await expect(f.begin('a', 'pa', 'ca')).rejects.toMatchObject({ code: 'execution_cancelled' });
  await f.runtime.cancelUnstartedCall({ directory: f.directory, sessionID: 'b', messageID: 'pb-assistant', callID: 'cb' });
  await expect(f.begin('b', 'pb', 'cb')).rejects.toMatchObject({ code: 'execution_cancelled' });
});


test('private Git views retain HEAD and index while original metadata stays untouched', async () => {
  const f = await fixture(); await f.write('x', 'committed');
  for (const input of ['node_modules', 'packages/lib/node_modules', '.venv']) {
    await fs.mkdir(path.join(f.directory, input), { recursive: true });
    await fs.writeFile(path.join(f.directory, input, 'dependency'), input);
  }
  await git(f.directory, ['add', 'x']);
  await git(f.directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']);
  const head = (await git(f.directory, ['rev-parse', 'HEAD'])).toString();
  await f.write('x', 'pending');
  const lease = await f.begin('a', 'pa', 'ca');
  for (const input of ['node_modules', 'packages/lib/node_modules', '.venv']) {
    expect((await fs.lstat(path.join(lease.viewDirectory, input))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(lease.viewDirectory, input, 'dependency'), 'utf8')).toBe(input);
  }
  expect((await git(lease.viewDirectory, ['rev-parse', 'HEAD'])).toString()).toBe(head);
  expect((await git(lease.viewDirectory, ['show', 'HEAD:x'])).toString()).toBe('committed');
  expect((await git(lease.viewDirectory, ['diff', '--', 'x'])).toString()).toContain('+pending');
  await git(lease.viewDirectory, ['add', 'x']);
  expect((await git(f.directory, ['show', ':x'])).toString()).toBe('committed');
  await f.finish(lease);
});

test('non-Git projects retain durable ownership and recovery directory identity', async () => {
  const f = await fixture(); await fs.rm(path.join(f.directory, '.git'), { recursive: true });
  await f.write('x', 'a=1; b=2');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=3; b=2'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=3; b=4');
  await f.revert('a', 'pa'); await f.finish(b);
  expect(await f.read('x')).toBe('a=1; b=4');
  expect(await f.runtime.projectDirectories()).toEqual([await fs.realpath(f.directory)]);
});


test('ignore rules cannot hide owned project changes or change their execution base', async () => {
  const f = await fixture(); await f.write('.gitignore', '*.local\n'); await f.write('config.local', 'a=1; b=2');
  const a = await f.begin('a', 'pa', 'ca');
  expect(await fs.readFile(path.join(a.viewDirectory, 'config.local'), 'utf8')).toBe('a=1; b=2');
  await fs.writeFile(path.join(a.viewDirectory, 'config.local'), 'a=3; b=2');
  await fs.writeFile(path.join(a.viewDirectory, 'new.local'), 'owned'); await f.finish(a);
  await f.write('config.local', 'a=3; b=4'); await f.revert('a', 'pa');
  expect(await f.read('config.local')).toBe('a=1; b=4');
  await expect(f.read('new.local')).rejects.toMatchObject({ code: 'ENOENT' });
});


test('successive Unicode replacements preserve the entire surviving code point', async () => {
  const f = await fixture(); await f.write('x', 'é; b=2; 😀');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'Ā; b=2; 🀄'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'Ă; b=4; 🃏'); await f.finish(b);
  await f.revert('a', 'pa'); expect(await f.read('x')).toBe('Ă; b=4; 🃏');
});

test('publication preserves private permissions and later permission changes retain ownership', async () => {
  const f = await fixture(); await f.write('x', 'before'); await fs.chmod(path.join(f.directory, 'x'), 0o600);
  const a = await f.begin('a', 'pa', 'ca');
  expect((await fs.stat(path.join(a.viewDirectory, 'x'))).mode & 0o777).toBe(0o600);
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'after'); await f.finish(a);
  expect((await fs.stat(path.join(f.directory, 'x'))).mode & 0o777).toBe(0o600);
  const b = await f.begin('b', 'pb', 'cb'); await fs.chmod(path.join(b.viewDirectory, 'x'), 0o640); await f.finish(b);
  await f.revert('a', 'pa'); expect(await f.read('x')).toBe('before');
  expect((await fs.stat(path.join(f.directory, 'x'))).mode & 0o777).toBe(0o640);
  await f.revert('b', 'pb');
  expect((await fs.stat(path.join(f.directory, 'x'))).mode & 0o777).toBe(0o600);
});

test('expired concurrent admissions never run after a held publication and a later prompt succeeds', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ onMaterialize: async () => { entered(); await held; } });
  await f.write('x', 'old');
  const owner = await f.begin('owner', 'p0', 'c0');
  await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
  const publication = f.finish(owner);
  await started;
  const diagnostics = [];
  const attempts = Array.from({ length: 4 }, (_, i) => {
    const input = { sessionID: `s${i}`, callID: `c${i}` };
    return withExecutionAdmission(input, () => f.begin(input.sessionID, `p${i}`, input.callID), {
      timeoutMs: 100, onDiagnostic: (record) => diagnostics.push(record),
    });
  });
  attempts.push(withExecutionAdmission({ sessionID: 'prompt' }, () => f.runtime.registerPrompt({
    directory: f.directory, sessionID: 'prompt', userMessageID: 'p-next',
  }), { timeoutMs: 100 }));
  const settledAttempts = Promise.allSettled(attempts);
  try {
    const other = await fixture();
    await expect(withExecutionAdmission({ sessionID: 'other' }, () => other.runtime.assertAdmission({
      directory: other.directory, sessionID: 'other',
    }))).resolves.toEqual({ admitted: true });
    const results = await settledAttempts;
    expect(results.every((result) => result.status === 'rejected' && result.reason.code === 'local_execution_timeout')).toBe(true);
    expect(diagnostics.filter((row) => row.phase === 'queue_wait' && row.state === 'failed')).toHaveLength(4);
    expect(diagnostics.some((row) => 'directory' in row || 'args' in row)).toBe(false);
  } finally { release(); await publication; }
  await f.runtime.drain();
  expect(await f.runtime.activeLeases({ directory: f.directory })).toHaveLength(0);
  await expect(f.runtime.registerPrompt({ directory: f.directory, sessionID: 'prompt', userMessageID: 'p-next' })).resolves.toHaveProperty('sequence');
  expect(await f.read('x')).toBe('new');
});

test('cancellation during reconciliation discards preparation and allows a subsequent tool', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  const f = await fixture(); await f.write('x', 'preserved');
  const controller = new AbortController();
  const cancelled = Object.assign(new Error('local_execution_timeout'), { code: 'local_execution_timeout' });
  const phases = [];
  await expect(withExecutionAdmission({ sessionID: 'cancelled', callID: 'c' }, () => f.begin('cancelled', 'p', 'c'), {
    signal: controller.signal,
    onDiagnostic: (record) => {
      phases.push(record);
      if (record.phase === 'reconciliation' && record.state === 'started') controller.abort(cancelled);
    },
  })).rejects.toBe(cancelled);
  expect(phases.some((row) => row.phase === 'reconciliation' && row.state === 'failed')).toBe(true);
  expect(await f.runtime.leaseForCall({ directory: f.directory, sessionID: 'cancelled', callID: 'c' })).toBeNull();
  const healthy = await f.begin('healthy', 'p2', 'c2');
  expect(await fs.readFile(path.join(healthy.viewDirectory, 'x'), 'utf8')).toBe('preserved');
});


test('slow reconciliation retains ownership until its file read settles, then expires all waiting work', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  const f = await fixture(); await f.write('slow.txt', 'preserve me');
  let release, enter;
  const held = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  const readFile = fs.readFile.bind(fs);
  const probe = spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
    if (String(file) === path.join(await fs.realpath(f.directory), 'slow.txt')) { enter(); await held; }
    return readFile(file, options);
  });
  const phases = [];
  let ownerSettled = false;
  const owner = withExecutionAdmission({ sessionID: 's0', callID: 'c0' }, () => f.begin('s0', 'p0', 'c0'), {
    timeoutMs: 1000, onDiagnostic: (row) => phases.push(row),
  }).then((result) => { ownerSettled = true; return result; }, (cause) => { ownerSettled = true; return cause; });
  let waiting = Promise.resolve([]);
  try {
    await Promise.race([entered, owner.then(() => { throw new Error('fixture failed before reconciliation'); })]);
    waiting = Promise.allSettled([
      ...Array.from({ length: 3 }, (_, index) => withExecutionAdmission({ sessionID: `s${index + 1}` },
        () => f.begin(`s${index + 1}`, `p${index + 1}`, `c${index + 1}`), { timeoutMs: 1000 })),
      withExecutionAdmission({ sessionID: 'prompt' }, () => f.runtime.registerPrompt({ directory: f.directory,
        sessionID: 'prompt', userMessageID: 'next' }), { timeoutMs: 1000 }),
    ]);
    const results = await waiting;
    expect(results.every((result) => result.status === 'rejected' && result.reason.code === 'local_execution_timeout')).toBe(true);
    expect(ownerSettled).toBe(false);
  } finally {
    release(); await owner; await waiting; probe.mockRestore();
  }
  expect((await owner).code).toBe('local_execution_timeout');
  expect(phases.some((row) => row.phase === 'reconciliation' && row.state === 'failed')).toBe(true);
  await f.runtime.drain();
  expect(await f.runtime.activeLeases({ directory: f.directory })).toHaveLength(0);
  const healthy = await f.begin('healthy', 'p-ok', 'c-ok');
  expect(await readFile(path.join(healthy.viewDirectory, 'slow.txt'), 'utf8')).toBe('preserve me');
});
