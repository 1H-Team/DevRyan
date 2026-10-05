import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { createNativeAdmissionOwner } from '../../web/server/lib/opencode/runtime-host/native-admission-owner.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const scopeFor = directory => ({ directory, sessionID: 'ses_child' });
async function fixture(onContinuation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-wake-')); roots.push(root);
  const directory = path.join(root, 'project'), storage = path.join(root, 'ledger');
  await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
  let runtime = createSessionMutationRuntime({ directory: storage });
  await runtime.registerNativeSession({ directory, sessionID: 'ses_root' });
  await runtime.registerNativeSession({ directory, sessionID: 'ses_child', parentID: 'ses_root' });
  const reads = [], policy = [];
  let owner;
  const compose = () => createNativeAdmissionOwner({ runtime, directory, ownerID: 'wake-fixture',
    getSession: async id => { reads.push(id); return { id, directory, ...(id === 'ses_child' ? { parentID: 'ses_root' } : {}) }; },
    authorizeOperation: async request => { policy.push(request.operation); },
    withSessionLock: async (_id, action) => action(), onContinuation: input => onContinuation(input, api) });
  const api = { directory, reads, policy, get runtime() { return runtime; }, get owner() { return owner; },
    rpc: (method, input) => owner.handleRpc(`native.admission.${method}`, input),
    reopen: () => { owner.dispose(); runtime = createSessionMutationRuntime({ directory: storage }); owner = compose(); },
    defer: operation => runtime.deferNativeContinuation({ ...scopeFor(directory), operation }),
    pending: () => runtime.nativeContinuations(scopeFor(directory)),
    release: () => owner.handleRpc('native.admission.releaseHold', { sessionID: 'ses_child' }) };
  owner = compose(); return api;
}
const receipt = (input, kind = 'idle') => ({ kind, operation: 'execution.wake', sessionID: input.sessionID });

test('held deferred wake receives a fresh exact capability and acknowledges verified native idle', async () => {
  let captured;
  const f = await fixture(async (input, f) => {
    captured = input;
    expect(input.operation).toBe('execution.wake');
    expect(input.directory).toBe(f.directory);
    expect(JSON.parse(f.owner.requestHeaders()['x-devryan-native-permit'])).toEqual(input.permit);
    const request = { operation: 'execution.deferred.wake', sessionID: input.sessionID, existingPermit: input.permit };
    expect(await f.rpc('authorize', request)).toEqual(input.permit);
    await f.rpc('recheck', { permit: input.permit, request: { operation: 'execution.wake', sessionID: input.sessionID } });
    for (const operation of ['session.prompt', 'session.setPermissions', 'session.create', 'shell.continue']) {
      await expect(f.rpc('recheck', { permit: input.permit, request: { operation, sessionID: input.sessionID } }))
        .rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
    }
    await expect(f.rpc('authorize', { ...request, sessionID: 'ses_root' })).rejects.toMatchObject({ code: 'native_permit_invalid' });
    // Store.claim may not recursively fetch native HTTP inside SQLite. The
    // wake issuer has already rebound both child and parent before dispatch.
    const reads = f.reads.length;
    const independent = await f.rpc('authorize', { operation: 'store.claim', sessionID: input.sessionID });
    expect(f.reads.length).toBe(reads);
    await f.rpc('release', independent);
    return receipt(input);
  });
  await f.rpc('hold', { sessionID: 'ses_child' }); await f.defer('execution.wake');
  await f.release();
  expect(await f.pending()).toEqual([]);
  expect(f.policy).toEqual(['store.claim']);
  expect(f.owner.requestHeaders()).toEqual({});
  await expect(f.rpc('recheck', { permit: captured.permit, request: { operation: 'execution.wake', sessionID: 'ses_child' } }))
    .rejects.toMatchObject({ code: 'native_permit_invalid' });
  await expect(f.rpc('authorize', { operation: 'execution.deferred.wake', sessionID: 'ses_child' }))
    .rejects.toMatchObject({ code: 'native_deferred_wake_capability_required' });
  const ordinary = await f.rpc('authorize', { operation: 'session.generate', sessionID: 'ses_child' });
  await expect(f.rpc('authorize', { operation: 'execution.deferred.wake', sessionID: 'ses_child', existingPermit: ordinary }))
    .rejects.toMatchObject({ code: 'native_deferred_wake_capability_required' });
});

test('replacement rebinds retained deferred wake and success is idempotent', async () => {
  let calls = 0;
  const f = await fixture(async input => { calls++; return receipt(input, 'registered'); });
  await f.defer('execution.wake'); f.reopen();
  await f.release(); await f.release();
  expect(calls).toBe(1); expect(await f.pending()).toEqual([]);
  expect(f.reads).toContain('ses_root');
});

test('startup recovery consumes only unheld execution wakes with a fresh verified capability', async () => {
  let calls = 0;
  const f = await fixture(async input => { calls++; return receipt(input); });
  await f.defer('execution.wake'); await f.defer('shell.complete:job_retained'); f.reopen();
  await f.runtime.holdNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'foreign-owner' });
  await f.owner.recoverExecutionContinuations({ directory: f.directory });
  expect(calls).toBe(0); expect(await f.pending()).toEqual(['execution.wake', 'shell.complete:job_retained']);
  expect(await f.runtime.recoverNativeTransientHolds({ directory: f.directory, ownerID: 'foreign-owner' })).toBe(1);
  await f.owner.recoverExecutionContinuations({ directory: f.directory });
  await f.owner.recoverExecutionContinuations({ directory: f.directory });
  expect(calls).toBe(1); expect(await f.pending()).toEqual(['shell.complete:job_retained']);
  await expect(f.rpc('recoverExecutionContinuations', { directory: f.directory })).rejects.toMatchObject({ code: 'native_admission_rpc_unavailable' });
});

test('startup recovery retains an unverified wake and an unresolved restored input', async () => {
  const f = await fixture(async () => ({ kind: 'blocked' })); await f.defer('execution.wake');
  await expect(f.owner.recoverExecutionContinuations({ directory: f.directory })).rejects.toMatchObject({ code: 'native_continuation_wake_unverified' });
  expect(await f.pending()).toEqual(['execution.wake']);
  let calls = 0;
  const restored = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'restored-fixture',
    getSession: async id => ({ id, directory: f.directory, ...(id === 'ses_child' ? { parentID: 'ses_root' } : {}) }),
    authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action(),
    assertRecoveredInputOperation: () => { throw Object.assign(new Error('native_recovered_input_fenced'), { code: 'native_recovered_input_fenced' }); },
    onContinuation: async input => { calls++; return receipt(input); } });
  try {
    await restored.recoverExecutionContinuations({ directory: f.directory });
    expect(calls).toBe(0); expect(await f.pending()).toEqual(['execution.wake']);
  } finally { restored.dispose(); }
});

test('concurrent hold releases share one independently registered wake', async () => {
  let calls = 0, complete;
  const entered = Promise.withResolvers();
  const f = await fixture(async input => { calls++; entered.resolve(); await new Promise(resolve => { complete = resolve; }); return receipt(input); });
  await f.defer('execution.wake');
  const first = f.release(); await entered.promise;
  const second = f.release(); complete(); await Promise.all([first, second]);
  expect(calls).toBe(1); expect(await f.pending()).toEqual([]);
});

test.each([undefined, { kind: 'registered' }, { kind: 'blocked', operation: 'execution.wake', sessionID: 'ses_child' },
  { kind: 'idle', operation: 'shell.complete', sessionID: 'ses_child' },
  { kind: 'idle', operation: 'execution.wake', sessionID: 'ses_root' }])('unverified wake result preserves durable intent: %j', async result => {
  const f = await fixture(async () => result); await f.defer('execution.wake');
  await expect(f.release()).rejects.toMatchObject({ code: 'native_continuation_wake_unverified' });
  expect(await f.pending()).toEqual(['execution.wake']);
});

test('failed wake retains intent for the next owned release', async () => {
  let reject = true;
  const f = await fixture(async input => { if (reject) throw Object.assign(new Error('runner admission failed'), { code: 'runner_failed' }); return receipt(input); });
  await f.defer('execution.wake');
  await expect(f.release()).rejects.toMatchObject({ code: 'runner_failed' });
  expect(await f.pending()).toEqual(['execution.wake']);
  reject = false; await f.release(); expect(await f.pending()).toEqual([]);
});

test('hold reacquisition before wake proof revokes acknowledgement', async () => {
  let revoke = true;
  const f = await fixture(async (input, f) => {
    if (revoke) await f.runtime.holdNativeAdmission({ ...scopeFor(f.directory), ownerID: 'wake-fixture' });
    return receipt(input);
  });
  await f.defer('execution.wake');
  await expect(f.release()).rejects.toMatchObject({ code: 'native_permit_revoked' });
  expect(await f.pending()).toEqual(['execution.wake']);
  revoke = false; await f.release(); expect(await f.pending()).toEqual([]);
});

test('controller invalidation after callback refuses old proof and recovery retries the intent', async () => {
  let invalidate = true;
  const f = await fixture(async (input, f) => { if (invalidate) await f.owner.invalidateController(); return receipt(input); });
  await f.defer('execution.wake');
  await expect(f.release()).rejects.toMatchObject({ code: 'native_permit_revoked' });
  expect(await f.pending()).toEqual(['execution.wake']);
  invalidate = false; await f.release(); expect(await f.pending()).toEqual([]);
});

test('atomic acknowledgement refuses hold-and-release between proof and ledger commit', async () => {
  const f = await fixture(async input => receipt(input));
  await f.defer('execution.wake');
  const acknowledge = f.runtime.acknowledgeNativeContinuation;
  f.runtime.acknowledgeNativeContinuation = async input => {
    const scope = scopeFor(f.directory);
    const hold = await f.runtime.holdNativeAdmission({ ...scope, ownerID: 'competing-owner' });
    await f.runtime.releaseNativeAdmission({ ...scope, ownerID: 'competing-owner', holdID: hold.id, expectedRevision: hold.revision });
    return acknowledge(input);
  };
  await expect(f.release()).rejects.toMatchObject({ code: 'native_hold_revision_conflict' });
  expect(await f.pending()).toEqual(['execution.wake']);
  f.runtime.acknowledgeNativeContinuation = acknowledge;
  await f.release(); expect(await f.pending()).toEqual([]);
});

test('replacement waits for an admitted ACK through its full durable API settlement', async () => {
  const f = await fixture(async input => receipt(input));
  await f.defer('execution.wake');
  const entered = Promise.withResolvers(), commit = Promise.withResolvers(), settled = Promise.withResolvers();
  const acknowledge = f.runtime.acknowledgeNativeContinuation;
  f.runtime.acknowledgeNativeContinuation = async input => {
    entered.resolve(); await commit.promise;
    await acknowledge(input);
    // The runtime API is still committing/settling even after its transaction
    // callback has returned. Epoch rotation must wait for this entire promise.
    await settled.promise;
  };
  const release = f.release();
  const releaseResult = release.then(() => null, error => error);
  await entered.promise;
  expect(() => f.owner.dispose()).toThrow('native_controller_ack_pending');
  let rotated = false;
  const replacement = f.owner.invalidateController().then(() => { rotated = true; });
  const concurrent = f.owner.invalidateController();
  expect(() => f.owner.dispose()).toThrow('native_controller_ack_pending');
  await expect(f.rpc('authorize', { operation: 'runner.drain', sessionID: 'ses_child' }))
    .rejects.toMatchObject({ code: 'native_controller_replacing' });
  expect(rotated).toBe(false);
  commit.resolve();
  await f.pending();
  expect(rotated).toBe(false);
  settled.resolve();
  await Promise.all([replacement, concurrent]);
  const releaseError = await releaseResult;
  if (releaseError) expect(releaseError.code).toBe('native_permit_revoked');
  expect(await f.pending()).toEqual([]);
  const fresh = await f.rpc('authorize', { operation: 'runner.drain', sessionID: 'ses_child' });
  await f.rpc('recheck', { permit: fresh, request: { operation: 'runner.drain', sessionID: 'ses_child' } });
  f.owner.dispose();
  await expect(f.rpc('authorize', { operation: 'runner.drain', sessionID: 'ses_child' }))
    .rejects.toMatchObject({ code: 'native_owner_stopped' });
});

test('closing replacement refuses an old proof that has not entered ACK and retains its durable intent', async () => {
  const entered = Promise.withResolvers(), complete = Promise.withResolvers();
  const f = await fixture(async input => { entered.resolve(); await complete.promise; return receipt(input); });
  await f.defer('execution.wake');
  const release = f.release();
  const result = release.then(() => null, error => error);
  await entered.promise;
  await f.owner.invalidateController();
  complete.resolve();
  expect((await result).code).toBe('native_permit_revoked');
  expect(await f.pending()).toEqual(['execution.wake']);
  await f.release(); expect(await f.pending()).toEqual([]);
});

test('an old proof cannot enter a new ACK while replacement drains another queued ACK', async () => {
  const rootEntered = Promise.withResolvers(), rootProof = Promise.withResolvers();
  const ackEntered = Promise.withResolvers(), ackCommit = Promise.withResolvers();
  const f = await fixture(async input => {
    if (input.sessionID === 'ses_root') { rootEntered.resolve(); await rootProof.promise; }
    return receipt(input);
  });
  const rootScope = { directory: f.directory, sessionID: 'ses_root' };
  await f.defer('execution.wake'); await f.runtime.deferNativeContinuation({ ...rootScope, operation: 'execution.wake' });
  const acknowledge = f.runtime.acknowledgeNativeContinuation;
  f.runtime.acknowledgeNativeContinuation = async input => {
    if (input.sessionID === 'ses_child') { ackEntered.resolve(); await ackCommit.promise; }
    return acknowledge(input);
  };
  const rootRelease = f.rpc('releaseHold', { sessionID: 'ses_root' });
  const rootFailure = rootRelease.then(() => null, error => error);
  await rootEntered.promise;
  const childRelease = f.release(), childResult = childRelease.then(() => null, error => error);
  await ackEntered.promise;
  const replacement = f.owner.invalidateController();
  rootProof.resolve();
  expect((await rootFailure).code).toBe('native_controller_replacing');
  expect(await f.runtime.nativeContinuations(rootScope)).toEqual(['execution.wake']);
  ackCommit.resolve(); await replacement;
  const childError = await childResult;
  if (childError) expect(childError.code).toBe('native_permit_revoked');
  await f.rpc('releaseHold', { sessionID: 'ses_root' });
  expect(await f.runtime.nativeContinuations(rootScope)).toEqual([]);
});

test('failed admitted ACK releases replacement barrier and keeps failure and retry intent explicit', async () => {
  const f = await fixture(async input => receipt(input));
  await f.defer('execution.wake');
  const entered = Promise.withResolvers(), complete = Promise.withResolvers();
  const acknowledge = f.runtime.acknowledgeNativeContinuation;
  f.runtime.acknowledgeNativeContinuation = async () => {
    entered.resolve(); await complete.promise;
    throw Object.assign(new Error('ledger commit failed'), { code: 'ledger_commit_failed' });
  };
  const release = f.release(), failure = release.then(() => null, error => error);
  await entered.promise;
  const replacement = f.owner.invalidateController();
  complete.resolve(); await replacement;
  expect((await failure).code).toBe('ledger_commit_failed');
  expect(await f.pending()).toEqual(['execution.wake']);
  f.runtime.acknowledgeNativeContinuation = acknowledge;
  await f.release(); expect(await f.pending()).toEqual([]);
});

test('unknown deferred operation is refused without invoking or acknowledging it', async () => {
  let calls = 0;
  const f = await fixture(async input => { calls++; return receipt(input); });
  await f.defer('session.prompt');
  await expect(f.release()).rejects.toMatchObject({ code: 'native_continuation_operation_unavailable' });
  expect(calls).toBe(0); expect(await f.pending()).toEqual(['session.prompt']);
});
