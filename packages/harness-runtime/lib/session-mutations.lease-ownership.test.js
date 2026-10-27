import { afterEach, describe, expect, spyOn } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { createSessionChangeRuntime } from './session-changes.js';
import { openChangeStore, changeKey } from './session-changes-store.js';
import { withExecutionAdmission } from './execution-admission.js';
import { cleanupRoots, fixture, ledgerState, manyFiles, roots, SMALL_BATCHES, test, withEnv } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);
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

test('constructor negative admission persists exact non-execution only while no execution pointer exists', async () => {
  const f = await fixture();
  const input = { directory: f.directory, sessionID: 'a', messageID: 'pa-assistant', callID: 'denied', requireAbsent: true };
  await f.runtime.cancelUnstartedCall(input);
  const reopened = createSessionMutationRuntime({ directory: f.storage });
  const query = { directory: f.directory, sessionID: 'a', calls: [{ messageID: input.messageID, callID: input.callID }] };
  expect((await reopened.executionOutcomes(query))[0].outcome).toBe('never_started');
  await expect(reopened.cancelUnstartedCall({ ...input, messageID: 'other-assistant' })).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  const active = { directory: f.directory, sessionID: 'a', userMessageID: 'pa', messageID: 'pa-assistant', callID: 'active', kind: 'control' };
  const lease = await f.runtime.begin(active);
  await expect(f.runtime.cancelUnstartedCall({ ...active, requireAbsent: true })).rejects.toMatchObject({ code: 'execution_already_started' });
  expect((await f.runtime.executionOutcomes({ ...query, calls: [{ messageID: active.messageID, callID: active.callID }] }))[0].outcome).toBe('uncertain');
  await f.runtime.cancelLease(lease); await f.runtime.cleanupLease(lease);
});

test('read-only lease and outcome lookups do not stage Git metadata, while mutations remain durable', async () => {
  const f = await fixture();
  const lease = await f.begin('a', 'pa', 'ca', { kind: 'control' });
  const writeFile = fs.writeFile.bind(fs);
  const writes = spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
    // Ledger metadata writes: index staging, or a direct tree commit's loose objects.
    if (String(file).startsWith(`${f.storage}${path.sep}`) && /\.metadata-index\.blobs|[/\\]tmp_obj_/.test(String(file))) throw new Error('unexpected metadata write');
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

test('sequential publication receipts and file Undo/Redo retain boundary order after reload', async () => {
  const f = await fixture();
  const versions = [
    ['ac', 'ab', 'é\r\nc', Buffer.from([0, 255, 97])],
    ['abc', 'aB', 'é\r\n😀c', Buffer.from([0, 255, 98])],
    ['aYc', 'aQ', 'é\r\n🀄c', Buffer.from([0, 254, 98])],
    ['aXYc', 'aQX', 'é\r\nX🀄c', Buffer.from([0, 254, 99])],
  ];
  const names = ['before.txt', 'after.txt', 'utf8.txt', 'binary.dat'];
  for (const [index, name] of names.entries()) await f.write(name, versions[0][index]);
  const changesDirectory = path.join(f.root, 'changes');
  let mutations = f.runtime;
  const restoreOwned = async (input) => {
    const tx = await mutations.prepareFileRestore(input);
    await mutations.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  };
  const previewOwned = input => mutations.previewFileRestore(input);
  let changes = createSessionChangeRuntime({ directory: changesDirectory, previewOwned, restoreOwned });
  const tokens = [];
  const receiptBytes = async (content) => {
    const chunks = [];
    for await (const chunk of content.byteStream) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  try {
    for (let operation = 0; operation < 3; operation++) {
      const lease = await f.begin(`s${operation}`, `p${operation}`, `c${operation}`); tokens.push(lease.token);
      for (const [index, name] of names.entries()) {
        expect(await fs.readFile(path.join(lease.viewDirectory, name))).toEqual(Buffer.from(versions[operation][index]));
        await fs.writeFile(path.join(lease.viewDirectory, name), versions[operation + 1][index]);
      }
      expect((await f.finish(lease)).files.map((file) => file.path).sort()).toEqual([...names].sort());
      for (const [index, name] of names.entries()) expect(await fs.readFile(path.join(f.directory, name)))
        .toEqual(Buffer.from(versions[operation + 1][index]));
      await changes.recordReceipt(await f.runtime.executionReceipt({ directory: f.directory, token: lease.token }));
    }
    await changes.drain(); await f.runtime.drain();
    mutations = createSessionMutationRuntime({ directory: f.storage });
    changes = createSessionChangeRuntime({ directory: changesDirectory, previewOwned, restoreOwned });
    for (const [operation, token] of tokens.entries()) {
      const receipt = await mutations.executionReceipt({ directory: f.directory, token });
      expect(receipt).toMatchObject({ sessionID: `s${operation}`, complete: true, source: 'confined-execution' });
      for (const file of receipt.files) {
        const index = names.indexOf(path.basename(file.path)); expect(index).toBeGreaterThanOrEqual(0);
        expect(await receiptBytes(file.before)).toEqual(Buffer.from(versions[operation][index]));
        expect(await receiptBytes(file.after)).toEqual(Buffer.from(versions[operation + 1][index]));
      }
    }
    const earlier = await changes.summarize({ directory: f.directory, rootSessionID: 's1' });
    const earlierDiff = await changes.diff({ directory: f.directory, rootSessionID: 's1', revision: earlier.revision, file: 'before.txt' });
    expect(earlierDiff.patch).toContain('-abc'); expect(earlierDiff.patch).toContain('+aYc');
    expect((await changes.previewRestore({ directory: f.directory, rootSessionID: 's1', summary: earlier })).restoreAvailable).toBe(false);
    await expect(changes.restore({ directory: f.directory, rootSessionID: 's1', revision: earlier.revision })).rejects.toMatchObject({ code: 'restore_proof_stale' });
    for (const [index, name] of names.entries()) expect(await fs.readFile(path.join(f.directory, name))).toEqual(Buffer.from(versions[3][index]));
    const summary = await changes.summarize({ directory: f.directory, rootSessionID: 's2' });
    expect(summary).toMatchObject({ coverage: 'complete', fileCount: 4, restoreAvailable: true });
    const diff = await changes.diff({ directory: f.directory, rootSessionID: 's2', revision: summary.revision, file: 'before.txt' });
    expect(diff.patch).toContain('-aYc'); expect(diff.patch).toContain('+aXYc');
    const preview = await changes.previewRestore({ directory: f.directory, rootSessionID: 's2', summary });
    expect(preview.restoreAvailable).toBe(true);
    await changes.restore({ directory: f.directory, rootSessionID: 's2', revision: summary.revision, restoreProof: preview.restoreProof });
    const undone = versions[2];
    for (const [index, name] of names.entries()) expect(await fs.readFile(path.join(f.directory, name))).toEqual(Buffer.from(undone[index]));
    await changes.drain(); await mutations.drain();
    mutations = createSessionMutationRuntime({ directory: f.storage });
    changes = createSessionChangeRuntime({ directory: changesDirectory, previewOwned, restoreOwned });
    const restored = await changes.summarize({ directory: f.directory, rootSessionID: 's2' });
    const redo = await changes.previewRestore({ directory: f.directory, rootSessionID: 's2', summary: restored });
    expect(redo.restoreAvailable).toBe(true);
    await changes.restore({ directory: f.directory, rootSessionID: 's2', revision: restored.revision, redo: true, restoreProof: redo.restoreProof });
    for (const [index, name] of names.entries()) expect(await fs.readFile(path.join(f.directory, name))).toEqual(Buffer.from(versions[3][index]));
  } finally { await changes.drain(); await mutations.drain(); }
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
