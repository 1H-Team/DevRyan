import { afterEach, describe, expect, spyOn, test as bunTest } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { createSessionChangeRuntime } from './session-changes.js';
import { openChangeStore, changeKey } from './session-changes-store.js';

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

test('execution outcomes survive restart and never infer non-execution from missing or dirty leases', async () => {
  const f = await fixture();
  const input = { directory: f.directory, sessionID: 'a', userMessageID: 'pa', messageID: 'pa-assistant', callID: 'ca', kind: 'control' };
  const query = { directory: f.directory, sessionID: 'a', calls: [{ messageID: input.messageID, callID: input.callID }] };
  expect((await f.runtime.executionOutcomes(query))[0].outcome).toBe('uncertain');
  const lease = await f.runtime.begin(input);
  await f.runtime.cancelUnstartedCall(input);
  expect((await f.runtime.executionOutcomes(query))[0].outcome).toBe('uncertain');
  await f.runtime.cleanupLease(lease);
  const reopened = createSessionMutationRuntime({ directory: f.storage });
  expect((await reopened.executionOutcomes(query))[0].outcome).toBe('never_started');
  expect((await reopened.executionOutcomes({ ...query, calls: [{ messageID: 'wrong', callID: 'ca' }] }))[0].outcome).toBe('uncertain');
  const done = await f.begin('a', 'pb', 'cb', { kind: 'control' });
  await f.runtime.claimLease({ directory: f.directory, token: done.token, kind: 'control' });
  await f.finish(done);
  expect((await reopened.executionOutcomes({ ...query, calls: [{ messageID: 'pb-assistant', callID: 'cb' }] }))[0].outcome).toBe('finished');
});

test('read-only lease and outcome lookups do not stage Git metadata, while mutations remain durable', async () => {
  const f = await fixture();
  const lease = await f.begin('a', 'pa', 'ca', { kind: 'control' });
  const writeFile = fs.writeFile.bind(fs);
  const writes = spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
    if (String(file).includes('.metadata-index.blobs')) throw new Error('unexpected metadata write');
    return writeFile(file, ...args);
  });
  try {
    const reopened = createSessionMutationRuntime({ directory: f.storage });
    expect((await reopened.leaseForCall({ directory: f.directory, sessionID: 'a', callID: 'ca' })).token).toBe(lease.token);
    expect((await reopened.executionOutcomes({ directory: f.directory, sessionID: 'a',
      calls: [{ messageID: 'pa-assistant', callID: 'ca' }] }))[0].outcome).toBe('uncertain');
    await expect(reopened.claimLease({ directory: f.directory, token: lease.token, kind: 'control' }))
      .rejects.toThrow('unexpected metadata write');
  } finally { writes.mockRestore(); }
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'control' });
  const reopened = createSessionMutationRuntime({ directory: f.storage });
  await expect(reopened.claimLease({ directory: f.directory, token: lease.token, kind: 'control' }))
    .rejects.toMatchObject({ code: 'execution_already_started' });
});

test('control admission and finish never inspect or copy project files, and preserve one-time claim and receipts', async () => {
  const f = await fixture();
  await f.write('input', 'keep');
  const reads = spyOn(fs, 'readdir').mockImplementation(async () => { throw new Error('must not inspect project'); });
  let lease;
  try {
    lease = await f.begin('a', 'pa', 'ca', { kind: 'control' });
    expect(lease.preparation).toBe('none');
    await expect(f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' }))
      .rejects.toMatchObject({ code: 'capture_identity_mismatch' });
    await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'control' });
    await expect(f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'control' }))
      .rejects.toMatchObject({ code: 'execution_already_started' });
    const result = await f.finish(lease);
    expect(result.operationID).toBeString();
    expect(result.files).toEqual([]);
    expect(await f.finish(lease)).toEqual(result);
    expect((await f.runtime.executionReceipt({ directory: f.directory, token: lease.token })).files).toEqual([]);
    await expect(f.begin('a', 'pa', 'ca')).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  } finally { reads.mockRestore(); }
  expect(await fs.readdir(lease.viewDirectory)).toEqual([]);
  expect(await f.read('input')).toBe('keep');
});

test('whole-content conflicts publish other paths, retain foreign bytes, and remain explicit through Revert', async () => {
  const f = await fixture(); await f.write('binary', Buffer.from([0, 1])); await f.write('text', 'base');
  const a = await f.begin('a', 'pa', 'ca'), b = await f.begin('b', 'pb', 'cb');
  await fs.writeFile(path.join(a.viewDirectory, 'binary'), Buffer.from([0, 2]));
  await fs.writeFile(path.join(b.viewDirectory, 'binary'), Buffer.from([0, 3]));
  await fs.writeFile(path.join(b.viewDirectory, 'text'), 'changed');
  await f.finish(a);
  const result = await f.finish(b);
  expect(result.outcome).toBe('partial');
  expect(result.conflicts).toEqual([{ path: 'binary' }]);
  expect(await fs.readFile(path.join(f.directory, 'binary'))).toEqual(Buffer.from([0, 2]));
  expect(await f.read('text')).toBe('changed');
  const undone = await f.revert('b', 'pb');
  expect(undone.outcome).toBe('partial');
  expect(await f.read('text')).toBe('base');
  expect(await fs.readFile(path.join(f.directory, 'binary'))).toEqual(Buffer.from([0, 2]));
});

test('large text and threshold crossings retain whole revisions and independent permission ownership', async () => {
  const f = await fixture(); const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 97);
  await f.write('large', bytes);
  const a = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(a.viewDirectory, 'large'), 'small'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb');
  await fs.chmod(path.join(b.viewDirectory, 'large'), 0o600); await f.finish(b);
  await f.revert('a', 'pa');
  expect(await fs.readFile(path.join(f.directory, 'large'))).toEqual(bytes);
  expect((await fs.stat(path.join(f.directory, 'large'))).mode & 0o777).toBe(0o600);
});

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
  expect((await f.runtime.leaseForCall({ directory: f.directory, sessionID: 'cancelled', callID: 'c' })).state).toBe('cancelled');
  await expect(f.begin('cancelled', 'p', 'c')).rejects.toMatchObject({ code: 'execution_cancelled' });
  const healthy = await f.begin('healthy', 'p2', 'c2');
  expect(await fs.readFile(path.join(healthy.viewDirectory, 'x'), 'utf8')).toBe('preserved');
});


test('slow reconciliation retains I/O ownership while unrelated control admission remains available', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  const f = await fixture(); await f.write('slow.txt', 'preserve me');
  let release, enter;
  const held = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  const readFile = fs.readFile.bind(fs);
  const open = fs.open.bind(fs);
  const probe = spyOn(fs, 'open').mockImplementation(async (file, ...options) => {
    if (String(file) === path.join(await fs.realpath(f.directory), 'slow.txt')) { enter(); await held; }
    return open(file, ...options);
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
        sessionID: 'prompt', userMessageID: 'next' }), { timeoutMs: 5000 }),
    ]);
    const results = await waiting;
    expect(results.slice(0, 3).every((result) => result.status === 'rejected' && result.reason.code === 'local_execution_timeout')).toBe(true);
    expect(results[3].status).toBe('fulfilled');
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

test('32 warm reservations meet the admission budget before any materialization', async () => {
  const f = await fixture(); await f.write('file', 'base');
  const warm = await f.begin('warm', 'warm-prompt', 'warm-call'); await f.finish(warm);
  const started = performance.now();
  const leases = await Promise.all(Array.from({ length: 32 }, (_, i) => f.runtime.reserve({ directory: f.directory,
    sessionID: `parallel-${i}`, userMessageID: `prompt-${i}`, messageID: `assistant-${i}`, callID: `call-${i}` })));
  expect(performance.now() - started).toBeLessThan(25_000);
  expect(leases.every(lease => lease.state === 'preparing')).toBe(true);
  expect(new Set(leases.map(lease => lease.token)).size).toBe(32);
});

test('large execution receipts are lazy streams with bounded chunks', async () => {
  const f = await fixture(); await f.write('large', Buffer.alloc(9 * 1024 * 1024, 97));
  const lease = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(lease.viewDirectory, 'large'), Buffer.alloc(9 * 1024 * 1024, 98)); await f.finish(lease);
  const receipt = await f.runtime.executionReceipt({ directory: f.directory, token: lease.token });
  const after = receipt.files[0].after;
  expect(after.bytes).toBeUndefined(); expect(after.sha256).toHaveLength(64);
  let size = 0;
  for await (const chunk of after.byteStream) { expect(chunk.length).toBeLessThanOrEqual(128 * 1024); size += chunk.length; }
  expect(size).toBe(9 * 1024 * 1024);
  const changes = createSessionChangeRuntime({ directory: path.join(f.root, 'changes') });
  try {
    // Read fresh iterables: the size check above deliberately consumed one.
    const input = await f.runtime.executionReceipt({ directory: f.directory, token: lease.token });
    await changes.recordReceipt(input);
    expect(await changes.summarize({ directory: f.directory, rootSessionID: 'a' }))
      .toMatchObject({ fileCount: 1, coverage: 'complete' });
  } finally { await changes.drain(); }
});

test('exhausted storage cancels preparation without publication and permits recovery', async () => {
  const f = await fixture(); await f.write('preserved', 'user content');
  const lease = await f.runtime.reserve({ directory: f.directory, sessionID: 'a', userMessageID: 'pa', messageID: 'ma', callID: 'ca' });
  const space = spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0n, bsize: 4096n });
  try {
    await expect(f.runtime.prepare(lease)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' })).rejects.toBeDefined();
    expect(await f.read('preserved')).toBe('user content');
    expect(await f.runtime.activeLeases({ directory: f.directory })).toHaveLength(0);
  } finally { space.mockRestore(); }
  const recovered = await f.begin('b', 'pb', 'cb');
  expect(await fs.readFile(path.join(recovered.viewDirectory, 'preserved'), 'utf8')).toBe('user content');
});

test('live execution bases survive pruning and cleanup only releases terminal leases', async () => {
  const f = await fixture(); await f.write('preserved', 'base');
  const lease = await f.begin('a', 'pa', 'ca');
  const gitDirectory = path.join(f.storage, changeKey(lease.projectDirectory), 'git');
  const command = (args) => git(f.directory, ['--git-dir', gitDirectory, ...args]);
  const pinned = (await command(['rev-parse', lease.snapshotRef])).toString().trim();
  expect(await f.runtime.cleanupLease({ directory: f.directory, token: lease.token })).toBe(false);
  await command(['gc', '--prune=now']);
  expect((await command(['rev-parse', lease.snapshotRef])).toString().trim()).toBe(pinned);
  const evidence = path.join(path.dirname(lease.viewDirectory), 'termination.json');
  await fs.writeFile(evidence, 'retained fixture evidence');
  await f.runtime.cancelLease({ directory: f.directory, token: lease.token });
  expect(await f.runtime.cleanupLease({ directory: f.directory, token: lease.token })).toBe(true);
  expect(await fs.readFile(evidence, 'utf8')).toBe('retained fixture evidence');
  await expect(command(['rev-parse', '--verify', lease.snapshotRef])).rejects.toBeDefined();
});


test('changing file stamps stop preparation with a retryable error and no stale base', async () => {
  const f = await fixture(); await f.write('hot', 'original');
  const target = await fs.realpath(path.join(f.directory, 'hot'));
  const original = fs.lstat.bind(fs); let reads = 0;
  const changing = spyOn(fs, 'lstat').mockImplementation(async (file, options) => {
    if (file === target) { reads++; await f.write('hot', `write-${reads}`); }
    return original(file, options);
  });
  try { await expect(f.begin('s', 'u', 'c')).rejects.toMatchObject({ code: 'workspace_changing', status: 503 }); }
  finally { changing.mockRestore(); }
  expect(reads).toBeLessThan(20);
  const lease = await f.runtime.leaseForCall({ directory: f.directory, sessionID: 's', callID: 'c' });
  expect(lease.state).toBe('cancelled'); expect(lease.cleaned).toBe(true);
  const retry = await f.begin('s', 'u', 'retry');
  expect(await fs.readFile(path.join(retry.viewDirectory, 'hot'), 'utf8')).toBe(await f.read('hot'));
});

test('concurrent ledger changes are bounded independently of stable file stamps', async () => {
  const f = await fixture(); await f.write('hot', 'original');
  await f.begin('baseline', 'u0', 'c0');
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory))), gitDir = path.join(root, 'git');
  const churn = async () => {
    const db = await openChangeStore(root, gitDir);
    for await (const { key, value } of db.entries('files')) {
      delete value.published.observation;
      value.published.sequence = (value.published.sequence ?? 0) + 1;
      db.set(key, value);
    }
    await db.commit();
  };
  await churn();
  // Churn once per inspection, at the object-store probe every inspection makes.
  const original = fs.lstat.bind(fs); let changes = 0;
  const changing = spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (/^[a-f0-9]{64}$/.test(path.basename(String(args[0]))) && path.dirname(String(args[0])) === path.join(root, 'objects')) { changes++; await churn(); }
    return original(...args);
  });
  try { await expect(f.begin('s', 'u', 'c')).rejects.toMatchObject({ code: 'workspace_changing' }); }
  finally { changing.mockRestore(); }
  expect(changes).toBe(4); expect(await f.read('hot')).toBe('original');
});

test('terminal cleanup survives restart and removes read-only private directories without following symlinks', async () => {
  const f = await fixture(); await f.write('x', 'base');
  const lease = await f.begin('s', 'u', 'c');
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  const ro = path.join(lease.viewDirectory, 'readonly'); await fs.mkdir(ro);
  await fs.writeFile(path.join(ro, 'result'), 'accepted'); await fs.chmod(ro, 0o555);
  const external = path.join(f.root, 'external'); await fs.mkdir(external, { mode: 0o555 });
  await fs.symlink(external, path.join(lease.viewDirectory, 'external'));
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }));
  await f.finish(lease);
  await fs.chmod(path.join(f.directory, 'readonly'), 0o755);
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  expect((await restarted.pendingCleanup({ directory: f.directory })).map((row) => row.token)).toContain(lease.token);
  await expect(restarted.cleanupLease(lease)).resolves.toBe(true);
  expect((await fs.stat(external)).mode & 0o777).toBe(0o555);
  expect(await f.read('readonly/result')).toBe('accepted');
  expect(await restarted.pendingCleanup({ directory: f.directory })).toEqual([]);
  expect((await restarted.leaseForCall({ directory: f.directory, sessionID: 's', callID: 'c' })).cleaned).toBe(true);
});

test('cleanup recovers a legacy orphan pin and retains uncertain process receipts', async () => {
  const f = await fixture(); await f.write('x', 'base'); const lease = await f.begin('s', 'u', 'c');
  const root = path.join(f.storage, changeKey(lease.projectDirectory)), gitDir = path.join(root, 'git');
  const db = await openChangeStore(root, gitDir), leaseKey = `leases/${changeKey(lease.token)}.json`;
  const durable = await db.get(leaseKey); delete durable.snapshotRef; db.set(leaseKey, durable); await db.commit();
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  await f.runtime.cancelLease(lease);
  await expect(f.runtime.cleanupLease(lease)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.runtime.pendingCleanup({ directory: f.directory }))).toHaveLength(1);
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    JSON.stringify({ terminated: true, confined: true, cancelled: true, exitCode: 1 }));
  await f.runtime.cleanupLease(lease);
  expect((await git(root, ['--git-dir', gitDir, 'for-each-ref', 'refs/devryan/leases/'])).toString()).toBe('');
});


test('slow unchanged workspace enumeration keeps concurrent preparation making progress', async () => {
  const { withExecutionPreparation } = await import('./execution-admission.js');
  const f = await fixture();
  for (let i = 0; i < 24; i++) {
    await fs.mkdir(path.join(f.directory, `d${i}`));
    await f.write(`d${i}/file`, 'unchanged');
  }
  const warm = await f.begin('warm', 'p0', 'c0'); await f.finish(warm);
  const readdir = fs.readdir.bind(fs);
  const reads = spyOn(fs, 'readdir').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(f.directory)) await new Promise(resolve => setTimeout(resolve, 35));
    return readdir(...args);
  });
  try {
    const leases = await Promise.all(['a', 'b'].map(id => withExecutionPreparation({ sessionID: id },
      () => f.begin(id, `p-${id}`, `c-${id}`), { stallMs: 700 })));
    for (const lease of leases) {
      expect(await fs.readFile(path.join(lease.viewDirectory, 'd0/file'), 'utf8')).toBe('unchanged');
      await f.finish(lease);
    }
  } finally { reads.mockRestore(); await f.runtime.drain(); }
});

test('execution outcome queries never create a ledger for an unmanaged project', async () => {
  const f = await fixture();
  const outcomes = await f.runtime.executionOutcomes({ directory: f.directory, sessionID: 'ses_unmanaged',
    calls: [{ messageID: 'msg_assistant', callID: 'call_one' }] });
  expect(outcomes).toEqual([{ sessionID: 'ses_unmanaged', messageID: 'msg_assistant', callID: 'call_one', outcome: 'uncertain' }]);
  await expect(fs.readdir(f.storage)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.runtime.executionOutcomes({ directory: f.directory, sessionID: 'ses_unmanaged',
    calls: [{ messageID: '', callID: 'call_one' }] })).rejects.toMatchObject({ code: 'invalid_capture_identity' });
});

test('registered prompts, admission and lease lookups answer while another process holds the ledger lock', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  const { withCrossProcessFileLock } = await import('./atomic-file.js');
  const f = await fixture();
  await f.write('x', 'old');
  const registered = await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'steady', userMessageID: 'p1' });
  const owner = await f.begin('owner', 'p0', 'c0');
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const lockPath = path.join(f.storage, changeKey(await fs.realpath(f.directory)), 'owner.lock');
  const holder = withCrossProcessFileLock(lockPath, async () => { entered(); await held; }, { timeoutMs: 5_000 });
  await started;
  try {
    const fast = { timeoutMs: 1_000 };
    await expect(withExecutionAdmission({ sessionID: 'steady' }, () => f.runtime.registerPrompt({
      directory: f.directory, sessionID: 'steady', userMessageID: 'p1' }), fast)).resolves.toEqual(registered);
    await expect(withExecutionAdmission({ sessionID: 'steady' }, () => f.runtime.assertAdmission({
      directory: f.directory, sessionID: 'steady' }), fast)).resolves.toEqual({ admitted: true });
    await expect(withExecutionAdmission({ sessionID: 'owner' }, () => f.runtime.leaseForCall({
      directory: f.directory, sessionID: 'owner', callID: 'c0' }), fast)).resolves.toMatchObject({ token: owner.token });
    // A new prompt needs a durable write and still waits for the lock.
    await expect(withExecutionAdmission({ sessionID: 'steady' }, () => f.runtime.registerPrompt({
      directory: f.directory, sessionID: 'steady', userMessageID: 'p2' }), { timeoutMs: 150 }))
      .rejects.toMatchObject({ code: 'local_execution_timeout' });
  } finally { release(); await holder; }
});

test('a lease lookup never reports absence while a reservation for the call is queued', async () => {
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ onMaterialize: async () => { entered(); await held; } });
  await f.write('x', 'old');
  const owner = await f.begin('owner', 'p0', 'c0');
  await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
  const publication = f.finish(owner);
  await started;
  const scope = { directory: f.directory, sessionID: 's', userMessageID: 'u', messageID: 'm', callID: 'c' };
  const reserving = f.runtime.reserve(scope);
  const lookup = f.runtime.leaseForCall(scope);
  release(); await publication;
  const lease = await reserving;
  expect(await lookup).toMatchObject({ token: lease.token });
});

test('lock-free reads fail closed when a materialization needs recovery', async () => {
  const f = await fixture({ onMaterialize: () => { throw new Error('fixture crash'); } });
  await f.write('x', '0'); const a = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), '1'); await expect(f.finish(a)).rejects.toThrow('fixture crash');
  await f.write('x', 'foreign');
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  await expect(restarted.assertAdmission({ directory: f.directory, sessionID: 'a' })).rejects.toMatchObject({ code: 'mutation_recovery_required' });
  await expect(restarted.executionOutcomes({ directory: f.directory, sessionID: 'a', calls: [{ messageID: 'pa-assistant', callID: 'ca' }] }))
    .rejects.toMatchObject({ code: 'mutation_recovery_required' });
});

test('a caller queued behind an un-admitted publication follows its progress', async () => {
  const { withExecutionAdmission, executionProgress } = await import('./execution-admission.js');
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ onMaterialize: async () => {
    entered();
    for (let n = 0; n < 12; n++) { await new Promise((resolve) => setTimeout(resolve, 50)); executionProgress(); }
  } });
  await f.write('x', 'old');
  const owner = await f.begin('owner', 'p0', 'c0');
  await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
  const publication = f.finish(owner); // production 'finish' runs without an admission context
  await started;
  await expect(withExecutionAdmission({ sessionID: 'queued' }, () => f.runtime.registerPrompt({
    directory: f.directory, sessionID: 'queued', userMessageID: 'q1' }), { timeoutMs: 5_000, idleMs: 200 }))
    .resolves.toMatchObject({ sequence: expect.any(Number) });
  await publication;
});

test('a caller queued behind a progressing lock holder is not expired by the idle deadline', async () => {
  const { withExecutionAdmission, executionProgress } = await import('./execution-admission.js');
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ onMaterialize: async () => {
    entered();
    for (let i = 0; i < 12; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); executionProgress(); }
  } });
  await f.write('x', 'old');
  const owner = await f.begin('owner', 'p0', 'c0');
  await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
  const publication = withExecutionAdmission({ sessionID: 'owner' }, () => f.finish(owner), { timeoutMs: 10_000 });
  await started;
  const queued = withExecutionAdmission({ sessionID: 'queued' }, () => f.runtime.registerPrompt({
    directory: f.directory, sessionID: 'queued', userMessageID: 'q1' }), { timeoutMs: 5_000, idleMs: 200 });
  await expect(queued).resolves.toMatchObject({ sequence: expect.any(Number) });
  await publication;
});

test('leaving the queue is progress: a long queue wait is never expired right after acquiring the lock', async () => {
  const { withExecutionAdmission, executionProgress } = await import('./execution-admission.js');
  for (let run = 0; run < 5; run++) {
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const f = await fixture({ onMaterialize: async () => {
      entered();
      // The holder works (with progress) for well over the queued caller's idle window.
      for (let n = 0; n < 120; n++) { await new Promise((resolve) => setTimeout(resolve, 5)); executionProgress(); }
    } });
    await f.write('x', 'old');
    const owner = await f.begin('owner', 'p0', 'c0');
    await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
    const publication = withExecutionAdmission({ sessionID: 'owner' }, () => f.finish(owner), { timeoutMs: 10_000 });
    await started;
    await expect(withExecutionAdmission({ sessionID: 'queued' }, () => f.runtime.registerPrompt({
      directory: f.directory, sessionID: 'queued', userMessageID: 'q1' }), { timeoutMs: 10_000, idleMs: 250 }))
      .resolves.toMatchObject({ sequence: expect.any(Number) });
    await publication;
  }
});

test('a tracked directory replaced by a file is observed as that file, not a blocked project', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.directory, 'd')); await f.write('d/x', 'inside');
  const first = await f.begin('s', 'p0', 'c0');
  await f.runtime.claimLease({ directory: f.directory, token: first.token, kind: 'process' });
  await f.finish(first);
  await fs.rm(path.join(f.directory, 'd'), { recursive: true }); await f.write('d', 'now a file');
  const next = await f.begin('s', 'p1', 'c1');
  expect(await fs.readFile(path.join(next.viewDirectory, 'd'), 'utf8')).toBe('now a file');
});

test('views clone verified objects and publication reuses only provably untouched files', async () => {
  const f = await fixture();
  await f.write('same.txt', 'aaaa'); await f.write('rewrite.txt', 'bbbb'); await f.write('mode.txt', 'cccc');
  const lease = await f.begin('a', 'pa', 'ca');
  const view = (name) => path.join(lease.viewDirectory, name);
  expect(await fs.readFile(view('same.txt'), 'utf8')).toBe('aaaa');
  // Same size, same second: only ctime/inode can reveal these edits.
  await fs.writeFile(view('rewrite.txt'), 'BBBB');
  await fs.chmod(view('mode.txt'), 0o755);
  const result = await f.finish(lease);
  expect(result.files.map((file) => file.path).sort()).toEqual(['mode.txt', 'rewrite.txt']);
  expect(await f.read('rewrite.txt')).toBe('BBBB');
  expect((await fs.stat(path.join(f.directory, 'mode.txt'))).mode & 0o111).not.toBe(0);
  expect(await f.read('same.txt')).toBe('aaaa');
});

test('a corrupted object store entry fails view preparation instead of being cloned', async () => {
  const f = await fixture();
  await f.write('x.txt', 'original');
  const first = await f.begin('a', 'pa', 'ca'); await f.finish(first);
  const objects = [];
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (path.basename(path.dirname(full)) === 'objects' && /^[a-f0-9]{64}$/.test(entry.name)) objects.push(full);
    }
  };
  await walk(f.storage);
  expect(objects.length).toBeGreaterThan(0);
  // A fresh process has no verification cache; corrupt every stored object.
  for (const object of objects) { await fs.chmod(object, 0o600); await fs.writeFile(object, 'corrupted'); }
  const reopened = createSessionMutationRuntime({ directory: f.storage });
  await expect(reopened.begin({ directory: f.directory, sessionID: 'b', userMessageID: 'pb', messageID: 'pb-assistant', callID: 'cb' }))
    .rejects.toMatchObject({ code: 'invalid_change_record' });
});

test('cached repository resolution notices a nested repository and a replaced .git', async () => {
  const f = await fixture();
  const sub = path.join(f.directory, 'pkg'); await fs.mkdir(sub);
  const real = await fs.realpath(f.directory);
  expect(await f.runtime.projectDirectory({ directory: sub })).toBe(real);
  expect(await f.runtime.projectDirectory({ directory: sub })).toBe(real);
  await git(sub, ['init', '--quiet']);
  expect(await f.runtime.projectDirectory({ directory: sub })).toBe(await fs.realpath(sub));
  await fs.rm(path.join(sub, '.git'), { recursive: true, force: true });
  expect(await f.runtime.projectDirectory({ directory: sub })).toBe(real);
});

// Logical ledger content by path: published identity, revision count and the
// stored text of its runs (including deleted runs). Document ids are random,
// so they are not compared.
async function ledgerState(f) {
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const db = await openChangeStore(root, path.join(root, 'git'));
  const state = {};
  for await (const { value } of db.entries('files')) {
    if (!value.published) continue;
    let revisions = 0; for await (const _ of db.list(`revisions/${value.id}`)) revisions += 1;
    const text = []; for await (const run of db.list(`runs/${value.id}`)) text.push(Buffer.from(run.bytes, 'base64').toString('latin1'));
    state[value.published.path] = { hash: value.published.hash, mode: value.published.mode, deleted: Boolean(value.published.deleted), revisions, text: text.join('') };
  }
  return state;
}
async function manyFiles(f, count) {
  for (let index = 0; index < count; index += 1) {
    const directory = path.join(f.directory, `d${index % 17}`, `e${index % 5}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `f${index}.txt`), `line ${index}\n`.repeat(1 + (index % 4)));
  }
  await fs.writeFile(path.join(f.directory, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(f.directory, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  await fs.symlink('d0/e0/f0.txt', path.join(f.directory, 'link'));
}
const withEnv = async (values, action) => {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try { return await action(); }
  finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
};

bunTest('fast first ingest records exactly the ledger the listing path records, across install batches', async () => {
  const fast = await fixture(), legacy = await fixture();
  await manyFiles(fast, 1300); await manyFiles(legacy, 1300);
  await fast.finish(await fast.begin('a', 'pa', 'ca'));
  await withEnv({ DEVRYAN_LEDGER_FAST_INGEST: '0' }, async () => legacy.finish(await legacy.begin('a', 'pa', 'ca')));
  const [fastState, legacyState] = await Promise.all([ledgerState(fast), ledgerState(legacy)]);
  expect(Object.keys(fastState).length).toBe(1303);
  expect(fastState).toEqual(legacyState);
  // Later edits build on the fast baseline exactly as on the legacy one.
  for (const f of [fast, legacy]) {
    await f.write('d1/e1/f1.txt', 'changed\n');
    const lease = await f.begin('a', 'pb', 'cb');
    await fs.writeFile(path.join(lease.viewDirectory, 'd2/e2/f2.txt'), 'edited by the call\n');
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }));
    await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' }).catch(() => {});
    const result = await f.finish(lease);
    expect(result.files).toEqual([{ path: 'd2/e2/f2.txt', status: 'modified' }]);
  }
  expect(await ledgerState(fast)).toEqual(await ledgerState(legacy));
}, 600_000);

bunTest('a writer committing between first-build batches is re-read, not overwritten by carried state', async () => {
  const f = await fixture(); await manyFiles(f, 1300);
  const open = fs.open.bind(fs);
  let triggered = null;
  const probe = spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
    // Well after the first 1024-row batch has committed, another writer lands.
    if (!triggered && String(file).endsWith(`${path.sep}f1250.txt`)) {
      triggered = f.runtime.registerPrompt({ directory: f.directory, sessionID: 'other', userMessageID: 'up' });
      await triggered;
    }
    return open(file, ...rest);
  });
  try { await f.finish(await f.begin('a', 'pa', 'ca')); }
  finally { probe.mockRestore(); }
  expect(triggered).not.toBeNull();
  const state = await ledgerState(f);
  expect(Object.keys(state).length).toBe(1303);
  expect(state['d0/e0/f0.txt'].text).toBe('line 0\n');
  expect(state[`d${1252 % 17}/e${1252 % 5}/f1252.txt`].text).toBe('line 1252\n');
  // The concurrent writer's record survived both install batches.
  expect((await f.runtime.capturedSessionState({ directory: f.directory, sessionID: 'other' })).captured).toBe(true);
}, 600_000);

test('warm builds a missing ledger once, skips non-repositories, and a real call reuses it', async () => {
  const f = await fixture(); await manyFiles(f, 40);
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plain-')); roots.push(plain);
  expect(await f.runtime.warm({ directory: plain })).toEqual({ skipped: 'not-git' });
  expect(await f.runtime.warm({ directory: f.directory, maxFiles: 1 })).toEqual({ skipped: 'too-large' });
  const built = await f.runtime.warm({ directory: f.directory });
  expect(built).toMatchObject({ built: true });
  expect(await f.runtime.warm({ directory: f.directory })).toEqual({ skipped: 'already-built' });
  await f.write('d0/e0/f0.txt', 'external edit after warm\n');
  const lease = await f.begin('a', 'pa', 'ca');
  expect(await fs.readFile(path.join(lease.viewDirectory, 'd0/e0/f0.txt'), 'utf8')).toBe('external edit after warm\n');
  await fs.writeFile(path.join(lease.viewDirectory, 'd1/e1/f1.txt'), 'by the call\n');
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }));
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  // The external edit made before the call is not attributed to it.
  expect((await f.finish(lease)).files).toEqual([{ path: 'd1/e1/f1.txt', status: 'modified' }]);
});

bunTest('a call that starts while a warm build runs joins it and sees a complete view', async () => {
  const f = await fixture(); await manyFiles(f, 600);
  const warming = f.runtime.warm({ directory: f.directory });
  const lease = await f.begin('a', 'pa', 'ca');
  expect(await fs.readFile(path.join(lease.viewDirectory, 'd4/e4/f599.txt'), 'utf8')).toBe('line 599\n'.repeat(4));
  expect(await warming).toMatchObject({ built: true });
  expect(Object.keys(await ledgerState(f)).length).toBe(603);
}, 600_000);

test('record caching is invisible: edits, reverts and outcomes match with the cache disabled', async () => {
  const run = async () => {
    const f = await fixture(); await manyFiles(f, 30);
    const outcomes = [];
    for (const [index, file] of ['d0/e0/f0.txt', 'd1/e1/f1.txt', 'd0/e0/f0.txt'].entries()) {
      const lease = await f.begin('s', `p${index}`, `c${index}`);
      await fs.writeFile(path.join(lease.viewDirectory, file), `edit ${index}\n`);
      await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }));
      await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
      outcomes.push((await f.finish(lease)).files);
      await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
    }
    await f.revert('s', 'p1');
    outcomes.push(await f.read('d0/e0/f0.txt'), await f.read('d1/e1/f1.txt'));
    return { outcomes, state: await ledgerState(f) };
  };
  const cached = await run();
  const uncached = await withEnv({ DEVRYAN_LEDGER_RECORD_CACHE: '0', DEVRYAN_LEDGER_SNAPSHOT_REUSE: '0' }, run);
  expect(cached).toEqual(uncached);
});

test('background packing keeps the ledger exact, including while a call runs concurrently', async () => {
  const f = await fixture({ maintenance: { looseObjects: 5, packs: 2, commits: 1_000, pruneExpiry: 'now' } });
  await manyFiles(f, 60);
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const objects = async () => Object.fromEntries((await git(root, ['--git-dir', path.join(root, 'git'), 'count-objects', '-v'])).toString()
    .trim().split('\n').map((line) => line.split(': ')).map(([name, value]) => [name, Number(value)]));
  const call = async (index, file) => {
    const lease = await f.begin('s', `p${index}`, `c${index}`);
    await fs.writeFile(path.join(lease.viewDirectory, file), `edit ${index}\n`);
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }));
    await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
    const result = await f.finish(lease);
    await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
    return result.files;
  };
  expect(await call(0, 'd0/e0/f0.txt')).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
  const before = await ledgerState(f);
  expect((await objects()).count).toBeGreaterThan(5);
  // First run packs loose objects; a concurrent call must be unaffected.
  const [, concurrent] = await Promise.all([f.runtime.maintainLedger({ directory: f.directory }), call(1, 'd1/e1/f1.txt')]);
  expect(concurrent).toEqual([{ path: 'd1/e1/f1.txt', status: 'modified' }]);
  await f.runtime.maintainLedger({ directory: f.directory });
  const packed = await objects();
  expect(packed.packs).toBeGreaterThanOrEqual(1);
  // Consolidation and prune leave every reachable record readable.
  expect(await call(2, 'd0/e0/f0.txt')).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
  const after = await ledgerState(f);
  expect(await f.read('d0/e0/f0.txt')).toBe('edit 2\n');
  expect(await f.read('d1/e1/f1.txt')).toBe('edit 1\n');
  expect(after['d0/e0/f0.txt'].revisions).toBe(before['d0/e0/f0.txt'].revisions + 1);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  await f.revert('s', 'p2');
  expect(await f.read('d0/e0/f0.txt')).toBe('edit 0\n');
}, 600_000);

test('packing can be switched off', async () => {
  const f = await fixture({ maintenance: { looseObjects: 1, packs: 1, commits: 1 } });
  await manyFiles(f, 10);
  await withEnv({ DEVRYAN_LEDGER_PACK: '0' }, async () => {
    await f.finish(await f.begin('s', 'p', 'c'));
    expect(await f.runtime.maintainLedger({ directory: f.directory })).toBeNull();
  });
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const stats = (await git(root, ['--git-dir', path.join(root, 'git'), 'count-objects', '-v'])).toString();
  expect(stats).toMatch(/^packs: 0$/m);
});

describe('direct receipts for native read-only tools', () => {
  const digest = 'a'.repeat(64);
  const scope = (f, call, user = 'pd') => ({ directory: f.directory, sessionID: 's', userMessageID: user, messageID: `${user}-assistant`, callID: call });
  const outcome = async (f, call, user = 'pd') => (await f.runtime.executionOutcomes({ directory: f.directory, sessionID: 's',
    calls: [{ messageID: `${user}-assistant`, callID: call }] }))[0].outcome;

  test('admission commits nothing; one finish records a finished, cleaned receipt; retries are idempotent', async () => {
    const f = await fixture(); await f.write('a.txt', 'a');
    const { generation } = await f.runtime.admitDirect(scope(f, 'c1'));
    expect(await outcome(f, 'c1')).toBe('uncertain');
    const token = randomUUID();
    const result = await f.runtime.finishDirect({ ...scope(f, 'c1'), token, generation, executionFingerprint: digest });
    expect(result.files).toEqual([]);
    expect(await f.runtime.finishDirect({ ...scope(f, 'c1'), token, generation, executionFingerprint: digest })).toEqual(result);
    await expect(f.runtime.finishDirect({ ...scope(f, 'c1'), token: randomUUID(), generation, executionFingerprint: digest }))
      .rejects.toMatchObject({ code: 'capture_identity_mismatch' });
    expect(await outcome(f, 'c1')).toBe('finished');
    await expect(f.runtime.admitDirect(scope(f, 'c1'))).rejects.toMatchObject({ code: 'execution_already_started' });
    expect(await f.runtime.pendingCleanup({ directory: f.directory })).toEqual([]);
    expect((await f.runtime.executionReceipt({ directory: f.directory, token })).files).toEqual([]);
  });

  test('a revert or cancellation between admission and finish fences the receipt; a crash leaves it uncertain', async () => {
    const f = await fixture(); await f.write('a.txt', 'before');
    const lease = await f.begin('s', 'p0', 'c0');
    await fs.writeFile(path.join(lease.viewDirectory, 'a.txt'), 'after');
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }));
    await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
    await f.finish(lease);
    const admitted = await f.runtime.admitDirect(scope(f, 'c1', 'p1'));
    await f.revert('s', 'p0');
    await expect(f.runtime.finishDirect({ ...scope(f, 'c1', 'p1'), token: randomUUID(), generation: admitted.generation, executionFingerprint: digest }))
      .rejects.toMatchObject({ code: 'execution_reverted' });
    expect(await outcome(f, 'c1', 'p1')).toBe('uncertain');

    const again = await f.runtime.admitDirect(scope(f, 'c2', 'p2'));
    await f.runtime.cancelUnstartedCall(scope(f, 'c2', 'p2'));
    await expect(f.runtime.finishDirect({ ...scope(f, 'c2', 'p2'), token: randomUUID(), generation: again.generation, executionFingerprint: digest }))
      .rejects.toMatchObject({ code: 'execution_cancelled' });

    // Admitted, then the process died before finishing: no record at all.
    await f.runtime.admitDirect(scope(f, 'c3', 'p3'));
    const restarted = createSessionMutationRuntime({ directory: f.storage });
    expect((await restarted.executionOutcomes({ directory: f.directory, sessionID: 's',
      calls: [{ messageID: 'p3-assistant', callID: 'c3' }] }))[0].outcome).toBe('uncertain');
  });
});
