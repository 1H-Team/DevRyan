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
test('an uncommitted prompt intent preserves existing Redo and cannot authorize execution', async () => {
  const f = await fixture(); await f.write('x', 'before');
  const lease = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(lease.viewDirectory, 'x'), 'after'); await f.finish(lease);
  await f.revert('a', 'pa');
  const intent = { directory: f.directory, sessionID: 'a', userMessageID: 'not-committed', parentID: null,
    fingerprint: 'a'.repeat(64), candidateHash: 'b'.repeat(64) };
  await f.runtime.reservePromptBoundary(intent);
  await expect(f.runtime.prepareRevert({ directory: f.directory, sessionID: 'a', messageID: intent.userMessageID }))
    .rejects.toMatchObject({ code: 'mutation_history_unavailable' });
  await expect(f.begin('a', intent.userMessageID, 'unauthorized')).rejects.toMatchObject({ code: 'prompt_boundary_uncommitted' });
  await expect(f.runtime.admitDirect({ ...intent, messageID: 'assistant', callID: 'read' })).rejects.toMatchObject({ code: 'prompt_boundary_uncommitted' });
  const redo = await f.runtime.prepareRedo({ directory: f.directory, sessionID: 'a' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true });
  expect(await f.read('x')).toBe('after');
});
test('late promotion of an older reserved prompt preserves later Redo ownership', async () => {
  const f = await fixture(); await f.write('x', 'before');
  await f.runtime.registerNativeSession({ directory: f.directory, sessionID: 'a' });
  const earlier = { directory: f.directory, sessionID: 'a', userMessageID: 'early', parentID: null,
    fingerprint: 'a'.repeat(64), candidateHash: 'b'.repeat(64) };
  await f.runtime.reservePromptBoundary(earlier);
  const lease = await f.begin('a', 'later', 'write'); await fs.writeFile(path.join(lease.viewDirectory, 'x'), 'after'); await f.finish(lease);
  await f.revert('a', 'later');
  await f.runtime.registerPrompt({ ...earlier, proof: true });
  const redo = await f.runtime.prepareRedo({ directory: f.directory, sessionID: 'a' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true });
  expect(await f.read('x')).toBe('after');
});
test('file restore proof rejects stale previews and revalidates after preparation', async () => {
  const f = await fixture(); await f.write('x', 'before');
  const lease = await f.begin('a', 'pa', 'write');
  await fs.writeFile(path.join(lease.viewDirectory, 'x'), 'after'); await f.finish(lease);
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review', calls: [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'write' }] };
  const proof = await f.runtime.previewFileRestore(selection);
  await f.write('x', 'foreign');
  const foreignObject = path.join(f.storage, changeKey(await fs.realpath(f.directory)), 'objects', createHash('sha256').update('foreign').digest('hex'));
  await expect(f.runtime.prepareFileRestore({ ...selection, proof })).rejects.toMatchObject({ code: 'working_tree_changed' });
  await expect(fs.access(foreignObject)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.write('x', 'after');
  const tx = await f.runtime.prepareFileRestore({ ...selection, proof });
  await f.write('x', 'foreign');
  await expect(f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true })).rejects.toMatchObject({ code: 'restore_proof_stale' });
  expect(await f.read('x')).toBe('foreign');
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: false });
});
test('file restore proof projects parallel sibling edits and supports redo', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=1\n');
  const a = await f.begin('a', 'pa', 'ca');
  const b = await f.begin('b', 'pb', 'cb', { parentID: 'a' });
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=2; b=1\n');
  await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=1; b=2\n');
  await f.finish(a); await f.finish(b);
  expect(await f.read('x')).toBe('a=2; b=2\n');
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review', calls: [
    { sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' }, { sessionID: 'b', messageID: 'pb-assistant', callID: 'cb' },
  ] };
  const proof = await f.runtime.previewFileRestore(selection);
  const tx = await f.runtime.prepareFileRestore({ ...selection, proof });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(await f.read('x')).toBe('a=1; b=1\n');
  const redo = { ...selection, revision: 'review-redo', redo: true };
  const redoProof = await f.runtime.previewFileRestore(redo);
  const redoTx = await f.runtime.prepareFileRestore({ ...redo, proof: redoProof });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: redoTx.id, commit: true });
  expect(await f.read('x')).toBe('a=2; b=2\n');
});
test('segmented review uses the ledger proof without changing receipt semantics', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=1\n');
  const a = await f.begin('a', 'pa', 'ca'); const b = await f.begin('a', 'pa', 'cb');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=2; b=1\n');
  await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=1; b=2\n');
  await f.finish(a); await f.finish(b);
  const changes = createSessionChangeRuntime({ directory: path.join(f.root, 'changes'),
    previewOwned: input => f.runtime.previewFileRestore(input),
    restoreOwned: async input => { const tx = await f.runtime.prepareFileRestore(input);
      await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true }); } });
  try {
    await changes.registerSession({ directory: f.directory, sessionID: 'a', userMessageID: 'pa' });
    for (const lease of [a, b]) await changes.recordReceipt(await f.runtime.executionReceipt({ directory: f.directory, token: lease.token }));
    const summary = await changes.summarize({ directory: f.directory, rootSessionID: 'a' });
    expect(summary.restoreReasons).toContain('segmented_changes');
    const preview = await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary });
    expect(preview).toMatchObject({ restoreAvailable: true, restoreReasons: [] });
    await changes.restore({ directory: f.directory, rootSessionID: 'a', revision: summary.revision, restoreProof: preview.restoreProof });
    expect(await f.read('x')).toBe('a=1; b=1\n');
  } finally { await changes.drain(); }
});
test('historical file receipts become restorable only with an exact ownership graph', async () => {
  const f = await fixture(); await f.write('x', 'before');
  const lease = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(lease.viewDirectory, 'x'), 'after'); await f.finish(lease);
  const changes = createSessionChangeRuntime({ directory: path.join(f.root, 'changes'),
    previewOwned: input => f.runtime.previewFileRestore(input),
    restoreOwned: async input => { const tx = await f.runtime.prepareFileRestore(input);
      await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true }); } });
  try {
    await changes.registerSession({ directory: f.directory, sessionID: 'a', userMessageID: 'pa' });
    await changes.importHistorical([{ directory: f.directory, sessionID: 'a', userMessageID: 'pa', messageID: 'pa-assistant',
      callID: 'ca', source: 'opencode', createdAt: 1, files: [{ path: 'x', before: 'before', after: 'after' }] }]);
    const summary = await changes.summarize({ directory: f.directory, rootSessionID: 'a' });
    expect(summary.restoreReasons).toContain('restore_evidence_unavailable');
    const preview = await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary });
    expect(preview.restoreAvailable).toBe(true);
    await changes.restore({ directory: f.directory, rootSessionID: 'a', revision: summary.revision, restoreProof: preview.restoreProof });
    expect(await f.read('x')).toBe('before');
  } finally { await changes.drain(); }
});
test('historical receipts without an ownership graph remain unavailable', async () => {
  const f = await fixture(); await f.write('x', 'after');
  const changes = createSessionChangeRuntime({ directory: path.join(f.root, 'changes'), previewOwned: input => f.runtime.previewFileRestore(input) });
  try {
    await changes.registerSession({ directory: f.directory, sessionID: 'a', userMessageID: 'pa' });
    await changes.importHistorical([{ directory: f.directory, sessionID: 'a', userMessageID: 'pa', messageID: 'pa-assistant',
      callID: 'ca', source: 'opencode', createdAt: 1, files: [{ path: 'x', before: 'before', after: 'after' }] }]);
    const summary = await changes.summarize({ directory: f.directory, rootSessionID: 'a' });
    expect((await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary })).restoreAvailable).toBe(false);
  } finally { await changes.drain(); }
});
test('file restore proof retains renamed binary contents and executable mode', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.directory, 'old'), Buffer.from([0, 1, 2]), { mode: 0o755 });
  const lease = await f.begin('a', 'pa', 'ca');
  await fs.rename(path.join(lease.viewDirectory, 'old'), path.join(lease.viewDirectory, 'new'));
  await fs.writeFile(path.join(lease.viewDirectory, 'new'), Buffer.from([0, 4, 5]));
  await f.runtime.finish({ directory: f.directory, token: lease.token, renames: [{ from: 'old', to: 'new' }] });
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review', calls: [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' }] };
  const proof = await f.runtime.previewFileRestore(selection);
  const tx = await f.runtime.prepareFileRestore({ ...selection, proof });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(await fs.readFile(path.join(f.directory, 'old'))).toEqual(Buffer.from([0, 1, 2]));
  expect((await fs.stat(path.join(f.directory, 'old'))).mode & 0o777).toBe(0o755);
  await expect(fs.stat(path.join(f.directory, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
});
test('file restore proof preserves the winning document after a same-path collision', async () => {
  const f = await fixture();
  const a = await f.begin('a', 'pa', 'ca'), b = await f.begin('b', 'pb', 'cb');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'A'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'B');
  await f.finish(a); await f.finish(b);
  const selection = { directory: f.directory, sessionID: 'a', revision: 'collision', calls: [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' }] };
  const proof = await f.runtime.previewFileRestore(selection);
  const tx = await f.runtime.prepareFileRestore({ ...selection, proof });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(await f.read('x')).toBe('B');
});

test('file restore proof preserves a later operation that converged on the same content', async () => {
  const f = await fixture(); await f.write('x', '\0before');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), '\0after'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), '\0else'); await f.finish(b);
  const c = await f.begin('b', 'pc', 'cc'); await fs.writeFile(path.join(c.viewDirectory, 'x'), '\0after'); await f.finish(c);
  const selection = { directory: f.directory, sessionID: 'a', revision: 'converged', calls: [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' }] };
  const proof = await f.runtime.previewFileRestore(selection);
  const tx = await f.runtime.prepareFileRestore({ ...selection, proof });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(await f.read('x')).toBe('\0after');
});

test('file restore proof refuses ambiguous granular convergence', async () => {
  const f = await fixture(); await f.write('x', 'before');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'after'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'else'); await f.finish(b);
  const c = await f.begin('b', 'pc', 'cc'); await fs.writeFile(path.join(c.viewDirectory, 'x'), 'after'); await f.finish(c);
  await expect(f.runtime.previewFileRestore({ directory: f.directory, sessionID: 'a', revision: 'converged',
    calls: [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' }] })).rejects.toMatchObject({ code: 'mutation_history_unavailable' });
  expect(await f.read('x')).toBe('after');
});
test('file restore proof refuses later granular edits whose base includes the selected operation', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=1\n');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=2; b=1\n'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=2; b=2\n'); await f.finish(b);
  await expect(f.runtime.previewFileRestore({ directory: f.directory, sessionID: 'a', revision: 'dependent',
    calls: [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' }] })).rejects.toMatchObject({ code: 'mutation_history_unavailable' });
  expect(await f.read('x')).toBe('a=2; b=2\n');
});

test('a committed file proof recovers its exact receipt after materialization interruption', async () => {
  let crash = false;
  const f = await fixture({ onMaterialize: () => { if (crash) throw new Error('fixture crash'); } });
  await f.write('x', 'before'); const lease = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(lease.viewDirectory, 'x'), 'after'); await f.finish(lease);
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review', calls: [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' }] };
  const proof = await f.runtime.previewFileRestore(selection), tx = await f.runtime.prepareFileRestore({ ...selection, proof });
  crash = true;
  await expect(f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true })).rejects.toThrow('fixture crash');
  const reopened = createSessionMutationRuntime({ directory: f.storage });
  const result = await reopened.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(result.files).toEqual([{ path: 'x', status: 'modified' }]); expect(await f.read('x')).toBe('before');
  expect((await reopened.prepareFileRestore({ ...selection, proof })).id).toBe(tx.id);
  expect(await reopened.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true })).toEqual(result);
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
  const a = await f.begin('a', 'pa', 'ca');
  const b = await f.begin('b', 'pb', 'cb');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=3; b=2'); await f.finish(a);
  await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=1; b=4'); await f.finish(b);
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review-1', calls: [{ sessionID: 'a', messageID:'pa-assistant', callID: 'ca' }] };
  const proof = await f.runtime.previewFileRestore(selection);
  const undo = await f.runtime.prepareFileRestore({ ...selection, proof });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: undo.id, commit: true });
  expect(await f.read('x')).toBe('a=1; b=4');
  expect((await f.runtime.prepareFileRestore({ ...selection, proof })).id).toBe(undo.id);
  await expect(f.runtime.prepareFileRestore({...selection,calls:[{sessionID:'a',callID:'ca'}]})).rejects.toMatchObject({code:'mutation_history_unavailable'});
  await expect(f.runtime.prepareFileRestore({...selection,calls:[{sessionID:'a',messageID:'wrong',callID:'ca'}]})).rejects.toMatchObject({code:'capture_identity_mismatch'});
  await f.revert('a', 'pa');
  const redo = await f.runtime.prepareRedo({ directory: f.directory, sessionID: 'a' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true });
  expect(await f.read('x')).toBe('a=1; b=4');
  const redoSelection = { ...selection, revision: 'review-2', redo: true };
  const fileRedo = await f.runtime.prepareFileRestore({ ...redoSelection, proof: await f.runtime.previewFileRestore(redoSelection) });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: fileRedo.id, commit: true });
  expect(await f.read('x')).toBe('a=3; b=4');
});

test('file restore skips only exact durable no-start calls alongside real published operations', async () => {
  const f = await fixture(); await f.write('x', 'before');
  const lease = await f.begin('a', 'pa', 'write'); await fs.writeFile(path.join(lease.viewDirectory, 'x'), 'after'); await f.finish(lease);
  const denied = { directory: f.directory, sessionID: 'a', messageID: 'denied-message', callID: 'denied' };
  await f.runtime.cancelUnstartedCall({ ...denied, requireAbsent: true });
  const calls = [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'write' }, denied];
  for (const failed of [{ ...denied, callID: 'unknown' }, { ...denied, messageID: 'wrong' }]) {
    await expect(f.runtime.prepareFileRestore({ directory: f.directory, sessionID: 'a', revision: 'bad', calls: [calls[0], failed] }))
      .rejects.toMatchObject({ code: 'mutation_history_unavailable' });
    expect(await f.read('x')).toBe('after');
  }
  await expect(f.runtime.prepareFileRestore({ directory: f.directory, sessionID: 'a', revision: 'only-no-start', calls: [denied] }))
    .rejects.toMatchObject({ code: 'mutation_history_unavailable' });
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review', calls };
  const proof = await f.runtime.previewFileRestore(selection);
  const undo = await f.runtime.prepareFileRestore({ ...selection, proof });
  expect((await f.runtime.prepareFileRestore({ ...selection, proof })).id).toBe(undo.id);
  for(const invalid of [{...denied,messageID:'wrong'},{sessionID:'a',callID:denied.callID}])await expect(f.runtime.prepareFileRestore({directory:f.directory,sessionID:'a',revision:'review',calls:[calls[0],invalid]})).rejects.toMatchObject({code:invalid.messageID?'capture_identity_mismatch':'mutation_history_unavailable'});
  await f.runtime.settleRevert({ directory: f.directory, transactionID: undo.id, commit: true }); expect(await f.read('x')).toBe('before');
  const redoSelection = { directory: f.directory, sessionID: 'a', revision: 'redo', redo: true, calls };
  const redo = await f.runtime.prepareFileRestore({ ...redoSelection, proof: await f.runtime.previewFileRestore(redoSelection) });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: redo.id, commit: true }); expect(await f.read('x')).toBe('after');
});
test('a cached file restore cannot reuse a new exact denial under the same provider call ID',async()=>{
  const f=await fixture();await f.write('x','before');
  const writer=await f.begin('a','writer','write');await fs.writeFile(path.join(writer.viewDirectory,'x'),'after');await f.finish(writer);
  const denied={directory:f.directory,sessionID:'a',messageID:'first-denial',callID:'reused'};
  await f.runtime.cancelUnstartedCall({...denied,requireAbsent:true});
  const writerCall={sessionID:'a',messageID:'writer-assistant',callID:'write'};
  const selection={directory:f.directory,sessionID:'a',revision:'review',calls:[writerCall,denied]};
  const proof=await f.runtime.previewFileRestore(selection);
  const original=await f.runtime.prepareFileRestore({...selection,proof});
  expect((await f.runtime.prepareFileRestore({...selection,proof})).id).toBe(original.id);
  const reopened=createSessionMutationRuntime({directory:f.storage});
  expect((await reopened.prepareFileRestore({...selection,proof})).id).toBe(original.id);
  const later={...denied,messageID:'later-denial'};await f.runtime.cancelUnstartedCall(later);
  expect((await f.runtime.executionOutcomes({directory:f.directory,sessionID:'a',calls:[later]}))[0].outcome).toBe('never_started');
  await expect(f.runtime.prepareFileRestore({...selection,calls:[writerCall,later]})).rejects.toMatchObject({code:'capture_identity_mismatch'});
  expect(await f.runtime.transaction({directory:f.directory,transactionID:original.id})).toEqual(original);
  expect(await f.read('x')).toBe('after');
});
test('a legacy cached restore without message identities refuses rather than changing its transaction',async()=>{
  const f=await fixture();await f.write('x','before');
  const writer=await f.begin('a','writer','write');await fs.writeFile(path.join(writer.viewDirectory,'x'),'after');await f.finish(writer);
  const selection={directory:f.directory,sessionID:'a',revision:'review',calls:[{sessionID:'a',messageID:'writer-assistant',callID:'write'}]};
  const proof=await f.runtime.previewFileRestore(selection);
  const original=await f.runtime.prepareFileRestore({...selection,proof});
  const root=path.join(f.storage,changeKey(await fs.realpath(f.directory))),db=await openChangeStore(root,path.join(root,'git'));
  const identity=JSON.stringify(['a','review',false]),receiptKey=`file-restores/${changeKey(identity)}.json`;
  const receipt=await db.get(receiptKey);
  db.set(receiptKey,{...receipt,fingerprint:createHash('sha256').update(JSON.stringify([['a','write']])).digest('hex')});await db.commit();
  await expect(f.runtime.prepareFileRestore(selection)).rejects.toMatchObject({code:'capture_identity_mismatch'});
  expect(await f.runtime.transaction({directory:f.directory,transactionID:original.id})).toEqual(original);
  expect(await f.read('x')).toBe('after');
});
test('reused provider call IDs do not borrow publication or cancellation authority from another message',async()=>{
  const f=await fixture(),published=await f.begin('a','first','published',{kind:'control'});
  await f.runtime.claimLease({directory:f.directory,token:published.token,kind:'control'});await f.finish(published);
  await expect(f.begin('a','later','published',{kind:'control'})).rejects.toMatchObject({code:'capture_identity_mismatch'});
  await f.runtime.cancelUnstartedCall({directory:f.directory,sessionID:'a',messageID:'first-assistant',callID:'cancelled',requireAbsent:true});
  await expect(f.begin('a','later','cancelled',{kind:'control'})).rejects.toMatchObject({code:'execution_cancelled'});
  expect((await f.runtime.executionOutcomes({directory:f.directory,sessionID:'a',calls:[{messageID:'later-assistant',callID:'published'},{messageID:'later-assistant',callID:'cancelled'}]})).map(row=>row.outcome)).toEqual(['uncertain','uncertain']);
});
test('clean cancelled prelaunch leases without a tombstone have the same no-start restore authority as outcome queries',async()=>{
  const f=await fixture();await f.write('x','before');
  const writer=await f.begin('a','write-user','write');await fs.writeFile(path.join(writer.viewDirectory,'x'),'after');await f.finish(writer);
  const cancelled=await f.begin('a','cancel-user','cancel',{kind:'process'});
  await f.runtime.cancelLease(cancelled);
  const denied={sessionID:'a',messageID:'cancel-user-assistant',callID:'cancel'};
  const query={directory:f.directory,sessionID:'a',calls:[denied]};
  expect((await f.runtime.executionOutcomes(query))[0].outcome).toBe('uncertain');
  const calls=[{sessionID:'a',messageID:'write-user-assistant',callID:'write'},denied];
  await expect(f.runtime.prepareFileRestore({directory:f.directory,sessionID:'a',revision:'dirty',calls})).rejects.toMatchObject({code:'mutation_history_unavailable'});
  await f.runtime.cleanupLease(cancelled);
  expect((await f.runtime.executionOutcomes(query))[0].outcome).toBe('never_started');
  for(const invalid of [{...denied,messageID:'wrong'},{...denied,callID:'unknown'}])await expect(f.runtime.prepareFileRestore({directory:f.directory,sessionID:'a',revision:'mismatch',calls:[calls[0],invalid]})).rejects.toMatchObject({code:'mutation_history_unavailable'});
  await expect(f.runtime.prepareFileRestore({directory:f.directory,sessionID:'a',revision:'only-no-start',calls:[denied]})).rejects.toMatchObject({code:'mutation_history_unavailable'});
  const undoSelection={directory:f.directory,sessionID:'a',revision:'clean',calls};
  const undo=await f.runtime.prepareFileRestore({...undoSelection,proof:await f.runtime.previewFileRestore(undoSelection)});await f.runtime.settleRevert({directory:f.directory,transactionID:undo.id,commit:true});expect(await f.read('x')).toBe('before');
  const redoSelection={directory:f.directory,sessionID:'a',revision:'redo-clean',redo:true,calls};
  const redo=await f.runtime.prepareFileRestore({...redoSelection,proof:await f.runtime.previewFileRestore(redoSelection)});await f.runtime.settleRevert({directory:f.directory,transactionID:redo.id,commit:true});expect(await f.read('x')).toBe('after');
});
test('guarded negative cancellation rechecks queued authority and leaves no durable proof after revocation',async()=>{
  const f=await fixture();let revoked=false;
  const cause=Object.assign(Error('revoked'),{code:'native_permit_revoked'});
  const input={directory:f.directory,sessionID:'a',messageID:'denied',callID:'denied',requireAbsent:true,
    guard:{admissionRevision:0,assertCurrent:()=>{if(revoked)throw cause;queueMicrotask(()=>{revoked=true;});}}};
  await expect(f.runtime.cancelUnstartedCall(input)).rejects.toBe(cause);
  expect((await f.runtime.executionOutcomes({directory:f.directory,sessionID:'a',calls:[{messageID:'denied',callID:'denied'}]}))[0].outcome).toBe('uncertain');
});
test('guarded no-start admission refuses a changed durable session hold revision',async()=>{
  const f=await fixture();await f.runtime.registerNativeSession({directory:f.directory,sessionID:'a'});
  await f.runtime.holdNativeAdmission({directory:f.directory,sessionID:'a',ownerID:'other-owner'});
  await expect(f.runtime.cancelUnstartedCall({directory:f.directory,sessionID:'a',messageID:'denied',callID:'denied',requireAbsent:true,
    guard:{admissionRevision:0,assertCurrent:()=>{}}})).rejects.toMatchObject({code:'native_permit_revoked'});
  expect((await f.runtime.executionOutcomes({directory:f.directory,sessionID:'a',calls:[{messageID:'denied',callID:'denied'}]}))[0].outcome).toBe('uncertain');
});
test('a clean cancelled already-claimed control call remains uncertain and cannot be skipped by restore',async()=>{
  const f=await fixture();await f.write('x','before');
  const writer=await f.begin('a','writer','writer');await fs.writeFile(path.join(writer.viewDirectory,'x'),'after');await f.finish(writer);
  const started=await f.begin('a','started','started',{kind:'control'});
  await f.runtime.claimLease({directory:f.directory,token:started.token,kind:'control'});
  await f.runtime.cancelLease(started);await f.runtime.cleanupLease(started);
  const call={sessionID:'a',messageID:'started-assistant',callID:'started'};
  expect((await f.runtime.executionOutcomes({directory:f.directory,sessionID:'a',calls:[call]}))[0].outcome).toBe('uncertain');
  await expect(f.runtime.prepareFileRestore({directory:f.directory,sessionID:'a',revision:'started',calls:[{sessionID:'a',messageID:'writer-assistant',callID:'writer'},call]})).rejects.toMatchObject({code:'mutation_history_unavailable'});
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
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review',
    calls: ['tool-1', 'tool-2'].map((callID) => ({ sessionID: 'a', messageID:'pa-assistant', callID })) };
  const tx = await f.runtime.prepareFileRestore({ ...selection, proof: await f.runtime.previewFileRestore(selection) });
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

test('private Git views keep the branch and HEAD with a file named HEAD and with an unborn branch', async () => {
  const f = await fixture();
  await f.write('HEAD', 'not a revision');
  const unborn = await f.begin('u', 'pu', 'cu');
  // No commit yet: the view's HEAD is the same unborn branch.
  await expect(git(unborn.viewDirectory, ['rev-parse', '--verify', 'HEAD'])).rejects.toBeDefined();
  expect((await git(unborn.viewDirectory, ['symbolic-ref', 'HEAD'])).toString().trim()).toMatch(/^refs\/heads\//);
  await f.finish(unborn);

  await git(f.directory, ['add', 'HEAD']);
  await git(f.directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']);
  const head = (await git(f.directory, ['rev-parse', 'HEAD', '--'])).toString().split('\n')[0];
  const lease = await f.begin('h', 'ph', 'ch');
  expect((await git(lease.viewDirectory, ['rev-parse', '--verify', 'HEAD'])).toString().trim()).toBe(head);
  // Still on a branch, as `update-ref HEAD` leaves it, not detached.
  expect((await git(lease.viewDirectory, ['symbolic-ref', 'HEAD'])).toString().trim()).toMatch(/^refs\/heads\//);
  expect((await git(lease.viewDirectory, ['status', '--porcelain'])).toString()).toBe('');
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

test('net review refuses Undo when a later foreign edit depends on its content', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=1\n');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=2; b=1\n'); await f.finish(a);
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=2; b=2\n'); await f.finish(b);
  const changes = createSessionChangeRuntime({ directory: path.join(f.root, 'changes'), previewOwned: input => f.runtime.previewFileRestore(input),
    restoreOwned: async input => { const tx = await f.runtime.prepareFileRestore(input); await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true }); } });
  try {
    await changes.registerSession({ directory: f.directory, sessionID: 'a', userMessageID: 'pa' });
    await changes.recordReceipt(await f.runtime.executionReceipt({ directory: f.directory, token: a.token }));
    const summary = await changes.summarize({ directory: f.directory, rootSessionID: 'a' });
    expect(summary.restoreAvailable).toBe(true);
    const preview = await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary });
    expect(preview.restoreAvailable).toBe(false);
    await expect(changes.restore({ directory: f.directory, rootSessionID: 'a', revision: summary.revision })).rejects.toMatchObject({ code: 'restore_proof_stale' });
    expect(await f.read('x')).toBe('a=2; b=2\n');
  } finally { await changes.drain(); }
});

test('new graph proof refreshes a stable review while older approved tokens remain stale', async () => {
  const f = await fixture(); await f.write('x', 'a=1; b=1\n');
  const a = await f.begin('a', 'pa', 'ca'), b = await f.begin('a', 'pa', 'cb');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=2; b=1\n'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=1; b=2\n');
  await f.finish(a); await f.finish(b);
  const changes = createSessionChangeRuntime({ directory: path.join(f.root, 'changes'), previewOwned: input => f.runtime.previewFileRestore(input),
    restoreOwned: async input => { const tx = await f.runtime.prepareFileRestore(input); await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true }); } });
  try {
    await changes.registerSession({ directory: f.directory, sessionID: 'a', userMessageID: 'pa' });
    for (const lease of [a, b]) await changes.recordReceipt(await f.runtime.executionReceipt({ directory: f.directory, token: lease.token }));
    const summary = await changes.summarize({ directory: f.directory, rootSessionID: 'a' });
    const old = await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary });
    expect(old.restoreAvailable).toBe(true);
    const other = await f.begin('other', 'pc', 'cc'); await fs.writeFile(path.join(other.viewDirectory, 'z'), 'unrelated'); await f.finish(other);
    const same = await changes.summarize({ directory: f.directory, rootSessionID: 'a' }); expect(same.revision).toBe(summary.revision);
    const fresh = await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary: same });
    expect(fresh.restoreAvailable).toBe(true); expect(fresh.restoreProof.digest).not.toBe(old.restoreProof.digest);
    await expect(changes.restore({ directory: f.directory, rootSessionID: 'a', revision: summary.revision, restoreProof: old.restoreProof })).rejects.toMatchObject({ code: 'restore_proof_stale' });
    await expect(changes.restore({ directory: f.directory, rootSessionID: 'a', revision: summary.revision })).rejects.toMatchObject({ code: 'restore_proof_stale' });
    await changes.restore({ directory: f.directory, rootSessionID: 'a', revision: summary.revision, restoreProof: fresh.restoreProof });
    expect(await f.read('x')).toBe('a=1; b=1\n'); expect(await f.read('z')).toBe('unrelated');
    const undone = await changes.summarize({ directory: f.directory, rootSessionID: 'a' });
    const redo = await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary: undone });
    expect(redo.restoreAvailable).toBe(true);
    await changes.restore({ directory: f.directory, rootSessionID: 'a', revision: undone.revision, redo: true, restoreProof: redo.restoreProof });
    expect(await f.read('x')).toBe('a=2; b=2\n');
  } finally { await changes.drain(); }
});

test('a writer admitted after review invalidates the approved proof before publication', async () => {
  const f = await fixture(); await f.write('x', 'before');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'after'); await f.finish(a);
  const selection = { directory: f.directory, sessionID: 'a', revision: 'review', calls: [{ sessionID: 'a', messageID: 'pa-assistant', callID: 'ca' }] };
  const proof = await f.runtime.previewFileRestore(selection);
  const tx = await f.runtime.prepareFileRestore({ ...selection, proof });
  const b = await f.begin('b', 'pb', 'cb'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'foreign');
  await expect(f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true })).rejects.toMatchObject({ code: 'restore_proof_stale' });
  expect(await f.read('x')).toBe('after');
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: false });
  await f.finish(b); expect(await f.read('x')).toBe('foreign');
});

test('overlapping reviews cannot authorize a different proof than the one returned', async () => {
  const f = await fixture(); await f.write('x', 'before');
  const a = await f.begin('a', 'pa', 'ca'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'after'); await f.finish(a);
  let release, captured;
  const waiting = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { captured = resolve; });
  let first = true;
  const changes = createSessionChangeRuntime({ directory: path.join(f.root, 'changes'),
    previewOwned: async input => {
      const proof = await f.runtime.previewFileRestore(input);
      if (first) { first = false; captured(); await waiting; }
      return proof;
    },
    restoreOwned: async input => { const tx = await f.runtime.prepareFileRestore(input); await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true }); } });
  try {
    await changes.registerSession({ directory: f.directory, sessionID: 'a', userMessageID: 'pa' });
    await changes.recordReceipt(await f.runtime.executionReceipt({ directory: f.directory, token: a.token }));
    const summary = await changes.summarize({ directory: f.directory, rootSessionID: 'a' });
    const delayed = changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary });
    await ready;
    const other = await f.begin('other', 'pb', 'cb'); await fs.writeFile(path.join(other.viewDirectory, 'z'), 'foreign'); await f.finish(other);
    const newer = await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary });
    release(); const older = await delayed;
    expect(newer.restoreProof.digest).not.toBe(older.restoreProof.digest);
    await expect(changes.restore({ directory: f.directory, rootSessionID: 'a', revision: summary.revision, restoreProof: newer.restoreProof })).rejects.toMatchObject({ code: 'restore_proof_stale' });
    expect(await f.read('x')).toBe('after');
    const refreshed = await changes.previewRestore({ directory: f.directory, rootSessionID: 'a', summary });
    await changes.restore({ directory: f.directory, rootSessionID: 'a', revision: summary.revision, restoreProof: refreshed.restoreProof });
    expect(await f.read('x')).toBe('before'); expect(await f.read('z')).toBe('foreign');
  } finally { release(); await changes.drain(); }
});
