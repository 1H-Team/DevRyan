// Coverage scenarios of the ledger dual run: together with dual-run-scenarios.mjs
// they call every method of the product host (SESSION_MUTATION_METHODS in
// packages/harness-runtime/lib/session-mutation-host.js) at least once, with
// the inputs the server and the ledger suites pass, on the success path and,
// where it is cheap, with a refusal the ledger documents. `AGED_MUTATIONS`
// mutates the aged-profile corpus (the `aged` suite supplies its fixture).
//
// Source references are to packages/harness-runtime/lib/session-mutations.js
// ("sm:<line>") unless another file is named.
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { writeProject } from './dual-run-fixture.mjs';

/** Per method: what its calls here exercise (methods dual-run-scenarios.mjs already covers are not listed). */
export const COVERAGE_NOTES = Object.freeze({
  // native admission and holds
  assertAdmission: 'admitted child of an unheld parent; refused native_session_held once the parent holds a native fence (sm:1862, sm:1415).',
  registerNativeSession: 'root and child sessions created; idempotent re-register; refused invalid_session_lineage for a changed parent (sm:1595).',
  holdNativeAdmission: 'plain hold, idempotent repeat, a hold taken during a prepared Revert (carries transactionID), and a retention hold (sm:1609).',
  releaseNativeAdmission: 'release by hold ID and revision; refused native_hold_revision_conflict for a stale revision (sm:1624).',
  recoverNativeTransientHolds: 'releases one plain hold of the recovering owner (returns 1); refused invalid_capture_identity for a malformed owner ID (sm:1637).',
  nativeTransactionHolds: 'lists the hold taken on a session while its Revert was prepared, once that Revert committed (sm:1680).',
  // native removal
  beginNativeRemoval: 'intent on a root with a child; a quiet intent from a retention hold (quietHold); refused native_removal_owner_mismatch for a second owner (sm:1428).',
  recoverNativeRemovalOwnership: 'checkpoint ref written into the ledger Git store (an empty-tree loose object, deterministic): returns 0 with no foreign intent; refused native_removal_inheritance_invalid for a malformed sourceOID and for a foreign intent the checkpoint does not hold (sm:1470). Real inheritance (returns 1) needs sourceOID = the ledger state tree, which is not a deterministic scenario value: not driven.',
  abandonQuietNativeRemoval: 'drops the quiet intent begun from the retention hold (sm:1578).',
  nativeRetentionHolds: 'lists the retention hold of its owner (sm:1588).',
  commitNativeRemoval: 'beforeCommit {$fn:"throw",code:"grant_revoked"} refuses with that code and leaves the intent preparing; beforeCommit {$fn:"noop"} seals it (sm:1511, sm:1537).',
  prepareNativeRemovalMembers: 'prepareOnly commit of the root and child members, no beforeCommit call (sm:3302 -> sm:1511).',
  nativeRemoval: 'read of the intent while preparing and after the refused commit (sm:1462).',
  nativeRemovals: 'live intents before and after completion (sm:1463).',
  stageNativeRemovalMember: 'staged dispositions of both members, one with an inbox ID (sm:1561).',
  acknowledgeNativeRemoval: 'ACK of both members (sm:1541).',
  completeNativeRemoval: 'refused native_removal_incomplete before the last ACK; completes after it (sm:1573).',
  // continuations and shell jobs
  deferNativeContinuation: 'execution.wake and shell.complete:<job> deferred on a session (sm:1654).',
  nativeContinuations: 'per-session continuations before and after acknowledgement (sm:1662).',
  nativeShellContinuations: 'the deferred shell.complete row (sm:1678).',
  nativeExecutionContinuations: 'the session with a deferred execution.wake (sm:1679).',
  acknowledgeNativeContinuation: 'execution.wake with expectedRevision; shell.complete refused native_continuation_started_proof_required for a user message that is not the delivered notice, then acknowledged with it (sm:1738).',
  bindNativeShellJob: 'binds a job to a claimed process lease; refused native_shell_job_conflict for another command (sm:1693).',
  nativeShellJob: 'lease read back by job; refused native_shell_job_unavailable for an unknown job (sm:1710).',
  bindNativeShellNotification: 'notice ID with itemHash and itemDelivery "queue" (sm:1719).',
  acknowledgeNativeShellCompletion: 'refused native_shell_job_unavailable while the lease is still ready; delivered after publication (sm:1730).',
  // prompts and children
  reservePromptBoundary: 'provisional boundary on a registered session; refused invalid_capture_identity for a malformed fingerprint (sm:1843).',
  pendingPromptBoundary: 'provisional prompt returned, then null after promotion by registerPrompt proof (sm:1857).',
  registerChild: 'child registered by the parent\'s published call, then edits in the child and a tree Revert of the parent; refused execution_reverted for an unknown parent call (sm:3143).',
  // views and leases
  projectDirectory: 'resolved project directory (sm:3300).',
  prewarmView: 'standby view after a warm, adopted by the next preparation in that session (sm:2147).',
  reserve: 'reservation of a process lease (sm:1876).',
  prepare: 'preparation of the reserved lease, passed back as returned (sm:2254; server: execution-preparations.js:52).',
  admitDirect: 'direct-receipt admission; refused prompt_boundary_uncommitted on a provisional boundary and execution_already_started once finished (sm:1937).',
  finishDirect: 'direct receipt with a caller token, the admitted generation and a fingerprint (sm:1960; session-mutations-lock-timing.test.js:81).',
  leaseForCall: 'lease by call and by alias (sm:3050).',
  aliasCalls: 'alias of a published lease\'s call; refused capture_identity_mismatch for a call owned by another lease (sm:3088).',
  // revert and restore
  previewFileRestore: 'proof for one call, and for its redo (sm:2995).',
  prepareFileRestore: 'files transaction from that proof, and its redo; refused restore_proof_stale for a digest that is not the proof (sm:2999).',
  transaction: 'read of the files transaction and of the conversation Revert (sm:3159).',
  updateTransaction: 'prepared -> stopped with boundaries -> conversation; refused revert_phase_mismatch for a wrong expectedPhase (sm:3160).',
  restoreForeign: 'add + modify + conflict in one call, then the same call again (unchanged + conflict) (sm:3186).',
});

// ---------------------------------------------------------------- helpers
const smallProject = async (stage) => { await writeProject(path.join(stage, 'project'), { size: 'small' }); };
const scope = (s, session, user, call, extra = {}) => ({ directory: s.project, sessionID: session, userMessageID: user, messageID: `${user}-assistant`, callID: call, ...extra });
const append = (s, file, text) => async (view) => { await s.fs.append(path.join(view, file), text); };
/** One confined edit through the full lease lifecycle; `prompt` and `extra` reach registerPrompt and begin (a child's parent fields). */
async function confinedEdit(s, label, { session = 's1', user, call, edit, prompt = {}, extra = {} }) {
  await s.call(`${label}:prompt`, 'registerPrompt', { directory: s.project, sessionID: session, userMessageID: user, ...prompt });
  const lease = await s.call(`${label}:begin`, 'begin', scope(s, session, user, call, extra));
  await s.call(`${label}:claim`, 'claimLease', { directory: s.project, token: lease.token, kind: 'process' });
  await edit(lease.workingDirectory, lease);
  await s.terminate(lease);
  await s.call(`${label}:finish`, 'finish', { directory: s.project, token: lease.token });
  await s.call(`${label}:cleanup`, 'cleanupLease', { directory: s.project, token: lease.token });
  return lease;
}
/** A call meant to be refused: the recording keeps its error; a success or another code is a scenario bug. */
async function refused(s, label, code, method, ...args) {
  const result = await s.attempt(label, method, ...args);
  if (result.ok) throw new Error(`${label}: expected ${code}, the call succeeded`);
  if (result.error.code !== code) throw new Error(`${label}: expected ${code}, got ${result.error.code ?? result.error.message}`);
  return result.error;
}
const HEX_A = 'a'.repeat(64), HEX_B = 'b'.repeat(64);
// Git's empty tree: a checkpoint ref target whose object is deterministic.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------------------------------------------------------------- scenarios
export const COVERAGE_SCENARIOS = Object.freeze([
  {
    name: 'coverage-admission',
    description: 'Native admission: sessions and lineage, plain, transaction and retention holds, release, transient-hold recovery, a quiet removal abandoned.',
    fixture: smallProject,
    async script(s) {
      const directory = s.project;
      await s.call('register-n1', 'registerNativeSession', { directory, sessionID: 'n1' });
      await s.call('register-n2', 'registerNativeSession', { directory, sessionID: 'n2', parentID: 'n1' });
      await s.call('register-n2-again', 'registerNativeSession', { directory, sessionID: 'n2', parentID: 'n1' });
      // sm:1598: a known session keeps its parent.
      await refused(s, 'register-n2-reparent', 'invalid_session_lineage', 'registerNativeSession', { directory, sessionID: 'n2', parentID: null });
      await s.call('admit-n2', 'assertAdmission', { directory, sessionID: 'n2' });
      const hold = await s.call('hold-n1', 'holdNativeAdmission', { directory, sessionID: 'n1', ownerID: 'owner-a' });
      await s.call('hold-n1-again', 'holdNativeAdmission', { directory, sessionID: 'n1', ownerID: 'owner-a' });
      // A hold on the parent fences the child too (sm:1400 walks the lineage).
      await refused(s, 'admit-n2-held', 'native_session_held', 'assertAdmission', { directory, sessionID: 'n2' });
      await s.call('state-n2-held', 'nativeAdmissionState', { directory, sessionID: 'n2' });
      await refused(s, 'release-stale', 'native_hold_revision_conflict', 'releaseNativeAdmission',
        { directory, sessionID: 'n1', ownerID: 'owner-a', holdID: hold.id, expectedRevision: hold.revision - 1 });
      await s.call('release-n1', 'releaseNativeAdmission', { directory, sessionID: 'n1', ownerID: 'owner-a', holdID: hold.id, expectedRevision: hold.revision });
      // Transient holds: plain {id, ownerID} holds of the recovering owner (sm:1643).
      await s.call('hold-n2-transient', 'holdNativeAdmission', { directory, sessionID: 'n2', ownerID: 'owner-transient' });
      await refused(s, 'recover-transient-bad-owner', 'invalid_capture_identity', 'recoverNativeTransientHolds', { directory, ownerID: 'not an owner!' });
      await s.call('recover-transient', 'recoverNativeTransientHolds', { directory, ownerID: 'owner-transient' });
      await s.call('admit-n2-released', 'assertAdmission', { directory, sessionID: 'n2' });

      // A hold taken while the session's Revert is prepared carries its transaction (sm:1617).
      await confinedEdit(s, 'edit-n1', { session: 'n1', user: 'nu1', call: 'nc1', edit: append(s, 'src/m0/f0.js', '// n1 edit\n') });
      const revert = await s.call('revert-n1:prepare', 'prepareRevert', { directory, sessionID: 'n1', messageID: 'nu1' });
      const fence = await s.call('hold-n1-reverting', 'holdNativeAdmission', { directory, sessionID: 'n1', ownerID: 'reverter' });
      await s.call('revert-n1:settle', 'settleRevert', { directory, transactionID: revert.id, commit: true });
      await s.call('transaction-holds', 'nativeTransactionHolds', { directory, ownerID: 'reverter' });
      await s.call('release-n1-reverting', 'releaseNativeAdmission', { directory, sessionID: 'n1', ownerID: 'reverter', holdID: fence.id, expectedRevision: fence.revision });

      // Retention hold -> quiet removal -> abandoned (sm:1448, sm:1578).
      await s.call('register-n3', 'registerNativeSession', { directory, sessionID: 'n3' });
      const retention = await s.call('hold-n3-retention', 'holdNativeAdmission', { directory, sessionID: 'n3', ownerID: 'retainer', retentionInstanceID: 'retention-1' });
      await s.call('retention-holds', 'nativeRetentionHolds', { directory, ownerID: 'retainer' });
      const quiet = await s.call('quiet-removal', 'beginNativeRemoval', { directory, rootSessionID: 'n3', ownerID: 'retainer',
        quietHold: { id: retention.id, revision: retention.revision, retentionInstanceID: 'retention-1' } });
      await s.call('quiet-abandon', 'abandonQuietNativeRemoval', { directory, intentID: quiet.id, ownerID: 'retainer' });
      await s.call('state-n3', 'nativeAdmissionState', { directory, sessionID: 'n3' });
    },
  },
  {
    name: 'coverage-removal',
    description: 'Native removal of a root and its child: intent, prepared members, a revoked then authorized commit, dispositions, ACKs, completion; ownership recovery from a checkpoint ref.',
    fixture: smallProject,
    async script(s) {
      const directory = s.project;
      await s.call('register-r1', 'registerNativeSession', { directory, sessionID: 'r1' });
      await s.call('register-r2', 'registerNativeSession', { directory, sessionID: 'r2', parentID: 'r1' });
      await s.call('register-q1', 'registerNativeSession', { directory, sessionID: 'q1' });
      const intent = await s.call('begin', 'beginNativeRemoval', { directory, rootSessionID: 'r1', ownerID: 'remover' });
      await refused(s, 'begin-other-owner', 'native_removal_owner_mismatch', 'beginNativeRemoval', { directory, rootSessionID: 'r1', ownerID: 'intruder' });
      await s.call('read-preparing', 'nativeRemoval', { directory, intentID: intent.id });
      await s.call('list-preparing', 'nativeRemovals', { directory });
      // Members as native-session-removal passes them: id, parentID, directory (aged-profile-fixture.mjs:354).
      const members = [{ id: 'r1', parentID: null, directory }, { id: 'r2', parentID: 'r1', directory }];
      await s.call('prepare-members', 'prepareNativeRemovalMembers', { directory, intentID: intent.id, ownerID: 'remover', members });
      // The host's final authorization runs inside the commit (sm:1537): a revoked grant leaves it preparing.
      await refused(s, 'commit-revoked', 'grant_revoked', 'commitNativeRemoval',
        { directory, intentID: intent.id, ownerID: 'remover', members, beforeCommit: { $fn: 'throw', code: 'grant_revoked' } });
      await s.call('read-after-revoked', 'nativeRemoval', { directory, intentID: intent.id });
      await s.call('commit', 'commitNativeRemoval', { directory, intentID: intent.id, ownerID: 'remover', members, beforeCommit: { $fn: 'noop' } });
      const dispositions = { r1: { inboxIDs: ['msg_inbox_r1'], pendingIDs: [] }, r2: { inboxIDs: [], pendingIDs: [] } };
      for (const id of ['r2', 'r1']) {
        await s.call(`stage-${id}`, 'stageNativeRemovalMember', { directory, intentID: intent.id, ownerID: 'remover', sessionID: id, ...dispositions[id] });
      }
      await s.call('ack-r2', 'acknowledgeNativeRemoval', { directory, intentID: intent.id, ownerID: 'remover', sessionID: 'r2', ...dispositions.r2 });
      await refused(s, 'complete-early', 'native_removal_incomplete', 'completeNativeRemoval', { directory, intentID: intent.id, ownerID: 'remover' });
      await s.call('ack-r1', 'acknowledgeNativeRemoval', { directory, intentID: intent.id, ownerID: 'remover', sessionID: 'r1', ...dispositions.r1 });
      await s.call('complete', 'completeNativeRemoval', { directory, intentID: intent.id, ownerID: 'remover' });
      await s.call('list-after', 'nativeRemovals', { directory });

      // Ownership recovery reads refs/devryan/migration/<checkpoint>/state of the
      // ledger's Git store (sm:1473). A verified clone writes it with
      // update-ref; here the ref names Git's empty tree, written as a loose
      // object so the store stays fsck-clean.
      const project = await s.call('project-directory', 'projectDirectory', { directory });
      const gitDir = path.join(s.storage, createHash('sha256').update(project).digest('hex'), 'git');
      const object = path.join(gitDir, 'objects', EMPTY_TREE.slice(0, 2), EMPTY_TREE.slice(2));
      if (!existsSync(object)) await s.fs.write(object, deflateSync(Buffer.from('tree 0\0')), { flag: 'wx', mode: 0o444 });
      await s.fs.write(path.join(gitDir, 'refs/devryan/migration/checkpoint-1/state'), `${EMPTY_TREE}\n`);
      const proof = { directory, ownerID: 'remover', checkpointID: 'checkpoint-1', sourceOID: EMPTY_TREE };
      await s.call('recover-ownership', 'recoverNativeRemovalOwnership', proof);
      await refused(s, 'recover-ownership-bad-oid', 'native_removal_inheritance_invalid', 'recoverNativeRemovalOwnership', { ...proof, sourceOID: 'not-an-oid' });
      // A live intent of another owner that the checkpoint does not hold is never adopted (sm:1480).
      await s.call('begin-foreign', 'beginNativeRemoval', { directory, rootSessionID: 'q1', ownerID: 'previous-owner' });
      await refused(s, 'recover-ownership-foreign', 'native_removal_inheritance_invalid', 'recoverNativeRemovalOwnership', proof);
    },
  },
  {
    name: 'coverage-continuations',
    description: 'A background shell bound to its process lease, its notice, publication, delivery, then deferred shell and execution continuations acknowledged.',
    fixture: smallProject,
    async script(s) {
      const directory = s.project;
      await s.call('prompt', 'registerPrompt', { directory, sessionID: 's1', userMessageID: 'u1' });
      const lease = await s.call('begin', 'begin', scope(s, 's1', 'u1', 'c1'));
      await s.call('claim', 'claimLease', { directory, token: lease.token, kind: 'process' });
      // Shape: aged-profile-fixture.mjs:342 (session-execution-host binds the job of a background shell).
      const job = { directory, token: lease.token, jobID: 'job1', sessionID: 's1', messageID: 'u1-assistant', callID: 'c1' };
      await s.call('bind-job', 'bindNativeShellJob', { ...job, command: 'npm run dev' });
      await refused(s, 'bind-job-other-command', 'native_shell_job_conflict', 'bindNativeShellJob', { ...job, command: 'npm test' });
      await s.call('job', 'nativeShellJob', { directory, sessionID: 's1', jobID: 'job1' });
      await refused(s, 'job-unknown', 'native_shell_job_unavailable', 'nativeShellJob', { directory, sessionID: 's1', jobID: 'job-unknown' });
      // itemHash: 64 hex; itemDelivery: queue | steer (sm:1726).
      await s.call('bind-notice', 'bindNativeShellNotification', { directory, sessionID: 's1', jobID: 'job1', notificationID: 'msg_notice_1', itemHash: 'c'.repeat(64), itemDelivery: 'queue' });
      await refused(s, 'deliver-before-finish', 'native_shell_job_unavailable', 'acknowledgeNativeShellCompletion', { directory, sessionID: 's1', jobID: 'job1', notificationID: 'msg_notice_1' });
      await s.fs.append(path.join(lease.workingDirectory, 'src/m2/f2.js'), '// shell output\n');
      await s.terminate(lease);
      await s.call('finish', 'finish', { directory, token: lease.token });
      await s.call('deliver', 'acknowledgeNativeShellCompletion', { directory, sessionID: 's1', jobID: 'job1', notificationID: 'msg_notice_1' });
      await s.call('cleanup', 'cleanupLease', { directory, token: lease.token });
      await s.call('defer-shell', 'deferNativeContinuation', { directory, sessionID: 's1', operation: 'shell.complete:job1' });
      await s.call('defer-wake', 'deferNativeContinuation', { directory, sessionID: 's1', operation: 'execution.wake' });
      await s.call('continuations', 'nativeContinuations', { directory, sessionID: 's1' });
      await s.call('shell-continuations', 'nativeShellContinuations', { directory });
      await s.call('execution-continuations', 'nativeExecutionContinuations', { directory });
      const { revision } = await s.call('admission', 'nativeAdmissionState', { directory, sessionID: 's1' });
      await s.call('ack-wake', 'acknowledgeNativeContinuation', { directory, sessionID: 's1', operation: 'execution.wake', expectedRevision: revision });
      // The continuation's user message must be the delivered notice (sm:1751).
      await refused(s, 'ack-shell-unproved', 'native_continuation_started_proof_required', 'acknowledgeNativeContinuation',
        { directory, sessionID: 's1', operation: 'shell.complete:job1', userMessageID: 'msg_other', assistantMessageID: 'msg_continued_assistant', expectedRevision: revision });
      await s.call('ack-shell', 'acknowledgeNativeContinuation',
        { directory, sessionID: 's1', operation: 'shell.complete:job1', userMessageID: 'msg_notice_1', assistantMessageID: 'msg_continued_assistant', expectedRevision: revision });
      await s.call('continuations-after', 'nativeContinuations', { directory, sessionID: 's1' });
    },
  },
  {
    name: 'coverage-prompts',
    description: 'A provisional prompt boundary promoted by proof; a child registered by its parent\'s call edits, and a tree Revert of the parent covers it.',
    fixture: smallProject,
    async script(s) {
      const directory = s.project;
      // Boundary shape: session-mutations.revert-restore.test.js:32.
      const boundary = { directory, sessionID: 'p1', userMessageID: 'pu1', parentID: null, fingerprint: HEX_A, candidateHash: HEX_B };
      await s.call('register-p1', 'registerNativeSession', { directory, sessionID: 'p1' });
      await refused(s, 'reserve-bad-fingerprint', 'invalid_capture_identity', 'reservePromptBoundary', { ...boundary, fingerprint: 'not-hex' });
      await s.call('reserve-boundary', 'reservePromptBoundary', boundary);
      await s.call('pending-boundary', 'pendingPromptBoundary', { directory, sessionID: 'p1', userMessageID: 'pu1' });
      await refused(s, 'direct-uncommitted', 'prompt_boundary_uncommitted', 'admitDirect', scope(s, 'p1', 'pu1', 'pd1'));
      await s.call('promote-boundary', 'registerPrompt', { ...boundary, proof: true });
      await s.call('pending-after', 'pendingPromptBoundary', { directory, sessionID: 'p1', userMessageID: 'pu1' });
      await confinedEdit(s, 'edit-p1', { session: 'p1', user: 'pu1', call: 'pc1', edit: append(s, 'src/m3/f3.js', '// promoted prompt\n') });

      // Parent edit, child registered by that call (aged-profile-fixture.mjs:158), child edit.
      await confinedEdit(s, 'parent', { user: 'u1', call: 'c1', edit: append(s, 'src/m4/f4.js', '// parent\n') });
      await refused(s, 'child-unknown-call', 'execution_reverted', 'registerChild', { directory, sessionID: 'k1', parentID: 's1', parentCallID: 'c-unknown' });
      const { parentGeneration } = await s.call('register-child', 'registerChild', { directory, sessionID: 'k1', parentID: 's1', parentCallID: 'c1' });
      await confinedEdit(s, 'child', { session: 'k1', user: 'ku1', call: 'kc1', edit: append(s, 'src/m5/f5.js', '// child\n'),
        prompt: { parentID: 's1', parentGeneration }, extra: { parentID: 's1', parentGeneration, parentCallID: 'c1' } });
      const tx = await s.call('revert-parent:prepare', 'prepareRevert', { directory, sessionID: 's1', messageID: 'u1' });
      await s.call('revert-parent:settle', 'settleRevert', { directory, transactionID: tx.id, commit: true });
      await s.call('outcomes', 'executionOutcomes', { directory, sessionID: 'k1', calls: [{ messageID: 'ku1-assistant', callID: 'kc1' }] });
    },
  },
  {
    name: 'coverage-views',
    description: 'Views and leases: project directory, a prewarmed standby, reserve then prepare, lookup and aliases of a call, direct receipts.',
    fixture: smallProject,
    async script(s) {
      const directory = s.project;
      await s.call('warm', 'warm', { directory });
      await s.call('project-directory', 'projectDirectory', { directory });
      await s.call('prewarm', 'prewarmView', { directory, sessionID: 's1' });
      await s.call('prompt', 'registerPrompt', { directory, sessionID: 's1', userMessageID: 'u1' });
      // The server reserves, then prepares the lease it got (session-execution-owner.js:41,51).
      const reserved = await s.call('reserve', 'reserve', { ...scope(s, 's1', 'u1', 'c1'), kind: 'process', executionFingerprint: HEX_A });
      const lease = await s.call('prepare', 'prepare', reserved);
      await s.call('lease-for-call', 'leaseForCall', { directory, sessionID: 's1', callID: 'c1' });
      await s.call('claim', 'claimLease', { directory, token: lease.token, kind: 'process' });
      await s.fs.append(path.join(lease.workingDirectory, 'src/m6/f6.js'), '// prepared view\n');
      await s.terminate(lease);
      await s.call('finish', 'finish', { directory, token: lease.token });
      // Cursor receipts alias the provider's call IDs to the lease (cursor-execution-receipts.js:46).
      await s.call('alias', 'aliasCalls', { directory, token: lease.token, calls: ['c1-provider'] });
      await s.call('lease-for-alias', 'leaseForCall', { directory, sessionID: 's1', callID: 'c1-provider' });
      await s.call('cleanup', 'cleanupLease', { directory, token: lease.token });
      const other = await s.call('other:begin', 'begin', scope(s, 's1', 'u1', 'c2'));
      await refused(s, 'alias-taken', 'capture_identity_mismatch', 'aliasCalls', { directory, token: other.token, calls: ['c1'] });
      await s.call('other:cancel', 'cancelLease', { directory, token: other.token });
      await s.call('other:cleanup', 'cleanupLease', { directory, token: other.token });
      // Direct receipt: admission, then the caller's token, generation and fingerprint (session-mutations-lock-timing.test.js:80).
      const direct = scope(s, 's1', 'u1', 'd1');
      const { generation } = await s.call('admit-direct', 'admitDirect', direct);
      await s.call('finish-direct', 'finishDirect', { ...direct, token: '00000000-0000-4000-8000-0000000000d1', generation, executionFingerprint: 'd'.repeat(64) });
      await refused(s, 'admit-direct-again', 'execution_already_started', 'admitDirect', direct);
      await s.call('outcomes', 'executionOutcomes', { directory, sessionID: 's1', calls: [
        { messageID: 'u1-assistant', callID: 'c1' }, { messageID: 'u1-assistant', callID: 'c1-provider' }, { messageID: 'u1-assistant', callID: 'd1' }] });
    },
  },
  {
    name: 'coverage-restore',
    description: 'File restore of one call by proof and its redo; a conversation Revert walked through its phases; compare-and-swap restoration of foreign content.',
    fixture: smallProject,
    async script(s) {
      const directory = s.project;
      await confinedEdit(s, 'first', { user: 'u1', call: 'c1', edit: append(s, 'src/m7/f7.js', '// first\n') });
      await confinedEdit(s, 'second', { user: 'u2', call: 'c2', edit: append(s, 'src/m8/f8.js', '// second\n') });
      // Selection shape: session-mutations.revert-restore.test.js:46.
      const selection = { directory, sessionID: 's1', revision: 'review-1', calls: [{ sessionID: 's1', messageID: 'u2-assistant', callID: 'c2' }] };
      const proof = await s.call('preview', 'previewFileRestore', selection);
      await refused(s, 'restore-stale-proof', 'restore_proof_stale', 'prepareFileRestore', { ...selection, revision: 'review-stale', proof: { version: 1, digest: '0'.repeat(64) } });
      const restore = await s.call('restore', 'prepareFileRestore', { ...selection, proof });
      await s.call('restore-read', 'transaction', { directory, transactionID: restore.id });
      await s.call('restore-settle', 'settleRevert', { directory, transactionID: restore.id, commit: true });
      const redo = { ...selection, revision: 'review-1-redo', redo: true };
      const redoProof = await s.call('redo-preview', 'previewFileRestore', redo);
      const redone = await s.call('redo', 'prepareFileRestore', { ...redo, proof: redoProof });
      await s.call('redo-settle', 'settleRevert', { directory, transactionID: redone.id, commit: true });

      // The revert coordinator's phases (session-revert-coordinator.js:72; boundaries: session-mutations-native-holds.test.js:422).
      const revert = await s.call('revert:prepare', 'prepareRevert', { directory, sessionID: 's1', messageID: 'u1' });
      const reference = { directory, transactionID: revert.id };
      await refused(s, 'revert:phase-mismatch', 'revert_phase_mismatch', 'updateTransaction', { ...reference, expectedPhase: 'stopped', phase: 'conversation' });
      await s.call('revert:stopped', 'updateTransaction', { ...reference, expectedPhase: 'prepared', phase: 'stopped',
        boundaries: revert.targets.map((target) => ({ id: target.id, revert: null })) });
      await s.call('revert:conversation', 'updateTransaction', { ...reference, expectedPhase: 'stopped', phase: 'conversation' });
      await s.call('revert:read', 'transaction', reference);
      await s.call('revert:settle', 'settleRevert', { ...reference, commit: true });

      // restoreForeign: each side { mode, bytes } or null (session-mutations.d.ts restoreForeign).
      const current = await s.fs.read(path.join(directory, 'no-newline.txt'));
      const files = [
        { path: 'foreign/added.txt', expected: null, target: { mode: '100644', bytes: Buffer.from('restored by the host\n') } },
        { path: 'no-newline.txt', expected: { mode: '100644', bytes: current }, target: { mode: '100644', bytes: Buffer.from('replaced by the host\n') } },
        { path: 'empty.txt', expected: { mode: '100644', bytes: Buffer.from('not what is there\n') }, target: { mode: '100644', bytes: Buffer.from('never written\n') } },
      ];
      await s.call('foreign', 'restoreForeign', { directory, files });
      await s.call('foreign-again', 'restoreForeign', { directory, files });
    },
  },
]);

// ---------------------------------------------------------------- aged corpus
// The aged-profile corpus (scripts/opencode-v2-native/aged-profile-fixture.mjs,
// written by aged-writer.mjs) names its messages msg_<session without ses_>_<kind>_<n>
// (aged-profile-fixture.mjs:309) and its shell jobs job_<user message without msg_>.
const AGED_CONTROL = { sessionID: 'ses_aged_control', messageID: 'msg_aged_control_assistant_2', callID: 'call_aged_control' };
const AGED_CLAIMED = { sessionID: 'ses_aged_claimed', messageID: 'msg_aged_claimed_assistant_2', callID: 'call_aged_claimed' };
const AGED_SHELL = { sessionID: 'ses_aged_undelivered_shell', jobID: 'job_aged_undelivered_shell_user_1', notificationID: 'msg_aged_undelivered_notice' };

export const AGED_MUTATIONS = Object.freeze({
  name: 'aged-mutations',
  description: 'The aged-profile corpus mutated through the ledger: its abandoned leases settled, its unstarted Revert cancelled, an edit and a Revert, native holds, a continuation of the undelivered shell, and a native removal of an aged session.',
  async script(s) {
    const directory = s.project;
    await s.call('warm', 'warm', { directory, refresh: true });
    const leases = await s.call('leases', 'activeLeases', { directory, sessions: [AGED_CONTROL.sessionID, AGED_CLAIMED.sessionID] });
    const leaseOf = (sessionID) => {
      const found = leases.find((lease) => lease.scope.sessionID === sessionID);
      if (!found) throw new Error(`aged-mutations: no active lease of ${sessionID}`);
      return found;
    };
    // The never-claimed control lease: cancelled and cleaned (no receipt needed for a control lease, sm:2706).
    const control = leaseOf(AGED_CONTROL.sessionID);
    await s.call('control:cancel', 'cancelLease', { directory, token: control.token });
    await s.call('control:cleanup', 'cleanupLease', { directory, token: control.token });
    // The claimed process lease whose owner died before starting it: cancelled before start (sm:3256), then cleaned.
    const claimed = leaseOf(AGED_CLAIMED.sessionID);
    await s.call('claimed:cancel', 'cancelUnstartedCall', { directory, ...AGED_CLAIMED, token: claimed.token });
    await s.call('claimed:cleanup', 'cleanupLease', { directory, token: claimed.token });
    // The prepared Revert that never reached the conversation: cancelled as cold startup does (sm:2804).
    const pending = await s.call('pending', 'pendingTransactions', { directory });
    const unstarted = pending.find((tx) => tx.rootSessionID === 'ses_aged_unstarted');
    if (!unstarted) throw new Error('aged-mutations: the unstarted Revert is missing');
    await s.call('unstarted:cancel', 'settleRevert', { directory, transactionID: unstarted.id, commit: false, cancelUnstarted: true });

    // A new turn in an aged session: an edit, then its Revert.
    await confinedEdit(s, 'edit', { session: AGED_CONTROL.sessionID, user: 'msg_aged_control_user_3', call: 'call_aged_control_edit',
      edit: append(s, 'src/m0/f0.js', '// aged edit\n') });
    const revert = await s.call('revert:prepare', 'prepareRevert', { directory, sessionID: AGED_CONTROL.sessionID, messageID: 'msg_aged_control_user_3' });
    await s.call('revert:settle', 'settleRevert', { directory, transactionID: revert.id, commit: true });

    // Native admission on aged sessions.
    await s.call('register-control', 'registerNativeSession', { directory, sessionID: AGED_CONTROL.sessionID });
    const hold = await s.call('hold-claimed', 'holdNativeAdmission', { directory, sessionID: AGED_CLAIMED.sessionID, ownerID: 'aged-owner' });
    await refused(s, 'admit-claimed-held', 'native_session_held', 'assertAdmission', { directory, sessionID: AGED_CLAIMED.sessionID });
    await s.call('release-claimed', 'releaseNativeAdmission', { directory, sessionID: AGED_CLAIMED.sessionID, ownerID: 'aged-owner', holdID: hold.id, expectedRevision: hold.revision });

    // The undelivered cancelled shell: delivered now, its continuation deferred and acknowledged.
    await s.call('shell:job', 'nativeShellJob', { directory, sessionID: AGED_SHELL.sessionID, jobID: AGED_SHELL.jobID });
    await s.call('shell:deliver', 'acknowledgeNativeShellCompletion', { directory, ...AGED_SHELL });
    await s.call('shell:defer', 'deferNativeContinuation', { directory, sessionID: AGED_SHELL.sessionID, operation: `shell.complete:${AGED_SHELL.jobID}` });
    await s.call('shell:continuations', 'nativeShellContinuations', { directory });
    const { revision } = await s.call('shell:admission', 'nativeAdmissionState', { directory, sessionID: AGED_SHELL.sessionID });
    await s.call('shell:ack', 'acknowledgeNativeContinuation', { directory, sessionID: AGED_SHELL.sessionID, operation: `shell.complete:${AGED_SHELL.jobID}`,
      userMessageID: AGED_SHELL.notificationID, assistantMessageID: 'msg_aged_undelivered_shell_continued', expectedRevision: revision });

    // An execution wake on the claimed session, then its native removal.
    await s.call('wake:defer', 'deferNativeContinuation', { directory, sessionID: AGED_CLAIMED.sessionID, operation: 'execution.wake' });
    await s.call('wake:list', 'nativeExecutionContinuations', { directory });
    const wake = await s.call('wake:admission', 'nativeAdmissionState', { directory, sessionID: AGED_CLAIMED.sessionID });
    await s.call('wake:ack', 'acknowledgeNativeContinuation', { directory, sessionID: AGED_CLAIMED.sessionID, operation: 'execution.wake', expectedRevision: wake.revision });
    const intent = await s.call('removal:begin', 'beginNativeRemoval', { directory, rootSessionID: AGED_CLAIMED.sessionID, ownerID: 'aged-remover' });
    const members = [{ id: AGED_CLAIMED.sessionID, parentID: null, directory }];
    await s.call('removal:commit', 'commitNativeRemoval', { directory, intentID: intent.id, ownerID: 'aged-remover', members, beforeCommit: { $fn: 'noop' } });
    const disposition = { directory, intentID: intent.id, ownerID: 'aged-remover', sessionID: AGED_CLAIMED.sessionID, inboxIDs: [], pendingIDs: [] };
    await s.call('removal:stage', 'stageNativeRemovalMember', disposition);
    await s.call('removal:ack', 'acknowledgeNativeRemoval', disposition);
    await s.call('removal:complete', 'completeNativeRemoval', { directory, intentID: intent.id, ownerID: 'aged-remover' });
    await s.call('removals', 'nativeRemovals', { directory });
    await s.call('pending-after', 'pendingTransactions', { directory });
    await s.call('cleanup-after', 'pendingCleanup', { directory });
  },
});
