import { afterEach, expect, test as bunTest } from 'bun:test';
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
});

test('moving the revert boundary accumulates the exact operation set for redo', async () => {
  const f = await fixture(); await f.write('x', '0');
  const a = await f.begin('a', 'p1', 'c1'); await fs.writeFile(path.join(a.viewDirectory, 'x'), '1'); await f.finish(a);
  const b = await f.begin('a', 'p2', 'c2'); await fs.writeFile(path.join(b.viewDirectory, 'x'), '2'); await f.finish(b);
  await f.revert('a', 'p2'); expect(await f.read('x')).toBe('1');
  await f.revert('a', 'p1'); expect(await f.read('x')).toBe('0');
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
