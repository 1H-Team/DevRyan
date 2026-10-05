import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { recoveredInputHash } from '../../web/server/lib/opencode/runtime-host/native-recovered-input-hash.js';
import { createNativeAdmissionOwner } from '../../web/server/lib/opencode/runtime-host/native-admission-owner.js';
import { createManagedOrchestrationPrivateHost } from '../../web/server/lib/orchestration/private-host.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-holds-'))); roots.push(root);
  const directory = path.join(root, 'project'), storage = path.join(root, 'ledger');
  await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
  const runtime = createSessionMutationRuntime({ directory: storage });
  const reopen = () => createSessionMutationRuntime({ directory: storage });
  await runtime.registerNativeSession({ directory, sessionID: 'ses_root' });
  await runtime.registerNativeSession({ directory, sessionID: 'ses_child', parentID: 'ses_root' });
  await runtime.registerNativeSession({ directory, sessionID: 'ses_other' });
  const sessions = new Map([['ses_root', { id: 'ses_root', directory }], ['ses_child', { id: 'ses_child', directory, parentID: 'ses_root' }], ['ses_other', { id: 'ses_other', directory }]]);
  const owner = createNativeAdmissionOwner({ runtime, directory, ownerID: 'fixture-bundle', getSession: async (id) => sessions.get(id),
    authorizeOperation: async (request) => { if (request.operation === 'session.setPermissions') throw Object.assign(new Error('permission_denied'), { code: 'permission_denied', status: 403 }); },
    withSessionLock: async (_id, action) => action() });
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  return { directory, storage, runtime, reopen, owner, rpc };
}

async function managedFixture() {
  const f = await fixture();
  const scope = { directory: f.directory, sessionID: 'ses_root', userMessageID: 'msg_task_user',
    messageID: 'msg_task_assistant', callID: 'call_task', kind: 'control' };
  const control = await f.runtime.begin(scope);
  await f.runtime.claimLease({ directory: f.directory, token: control.token, kind: 'control' });
  await f.runtime.finish({ directory: f.directory, token: control.token });
  const task = { owner: 'devryan', taskId: 'task_owned', leaseToken: 'task_lease', status: 'starting', directory: f.directory,
    rootSessionId: 'ses_root', dispatchCallId: 'call_task', childSessionId: null, providerId: 'fixture', modelId: 'model', agent: 'build', variant: null };
  let verifier = async () => structuredClone(task);
  const locks = [];
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'managed-dispatch-fixture',
    getSession: async id => ({ id, directory: f.directory, ...(id === 'ses_child' ? { parentID: 'ses_root' } : {}) }),
    authorizeOperation: async request => { if (request.operation !== 'tool.execute') throw new Error(`Generic policy must not authorize managed dispatch: ${request.operation}`); },
    withSessionLock: async (id, action) => { locks.push(id); return action(); },
    verifyManagedTaskDispatch: input => verifier(input) });
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  const create = { operation: 'create', taskId: task.taskId, leaseToken: task.leaseToken, directory: f.directory,
    parentID: task.rootSessionId, parentCallID: task.dispatchCallId };
  const prompt = { operation: 'prompt', taskId: task.taskId, leaseToken: task.leaseToken, directory: f.directory,
    sessionID: 'ses_child', providerId: task.providerId, modelId: task.modelId, agent: task.agent, variant: task.variant };
  const fingerprint = 'a'.repeat(64), accepted = { sessionID: 'ses_child', messageID: 'msg_task_prompt', fingerprint,
    metadata: { devryan: { admission: { fingerprint } } }, request: { text: 'owned task' } };
  return { ...f, owner, rpc, control, task, create, prompt, accepted, locks, setVerifier: value => { verifier = value; } };
}

test('replacement clears only exact temporary owner holds and preserves independent durable fences', async () => {
  const f = await fixture();
  const ownerID = 'fixture-bundle', directory = f.directory;
  await f.rpc('hold', { sessionID: 'ses_root' });
  await f.runtime.holdNativeAdmission({ directory, sessionID: 'ses_root', ownerID: 'foreign-owner' });
  await f.runtime.holdNativeAdmission({ directory, sessionID: 'ses_child', ownerID, retentionInstanceID: 'old-retention' });
  const removal = await f.runtime.beginNativeRemoval({ directory, rootSessionID: 'ses_other', ownerID });
  await f.runtime.registerNativeSession({ directory, sessionID: 'ses_revert' });
  await f.runtime.registerPrompt({ directory, sessionID: 'ses_revert', userMessageID: 'msg_revert' });
  const tx = await f.runtime.prepareRevert({ directory, sessionID: 'ses_revert', messageID: 'msg_revert' });
  await f.runtime.holdNativeAdmission({ directory, sessionID: 'ses_revert', ownerID });
  f.owner.dispose();
  const runtime = f.reopen();
  expect(await runtime.recoverNativeTransientHolds({ directory, ownerID })).toBe(1);
  expect(await runtime.recoverNativeTransientHolds({ directory, ownerID })).toBe(0);
  expect((await runtime.nativeAdmissionState({ directory, sessionID: 'ses_root' })).holds.map(hold => hold.ownerID)).toEqual(['foreign-owner']);
  expect((await runtime.nativeAdmissionState({ directory, sessionID: 'ses_child' })).holds.find(hold => hold.sessionID === 'ses_child'))
    .toMatchObject({ ownerID, retentionInstanceID: 'old-retention' });
  expect((await runtime.nativeAdmissionState({ directory, sessionID: 'ses_other' })).held).toBe(true);
  expect((await runtime.nativeRemoval({ directory, intentID: removal.id })).state).toBe('preparing');
  expect((await runtime.nativeAdmissionState({ directory, sessionID: 'ses_revert' })).holds).toEqual([
    expect.objectContaining({ ownerID, transactionID: tx.id })]);
  await runtime.settleRevert({ directory, transactionID: tx.id, commit: true });
  expect(await runtime.recoverNativeTransientHolds({ directory, ownerID })).toBe(0);
  expect((await runtime.nativeAdmissionState({ directory, sessionID: 'ses_revert' })).held).toBe(true);
  await expect(runtime.recoverNativeTransientHolds({ directory, ownerID: '../foreign' })).rejects.toMatchObject({ code: 'invalid_capture_identity' });
});

test('web permits bind exact effects, the original caller, interaction ownership, and their request lifetime', async () => {
  const f = await fixture();
  let principal = 'caller', allowed = true, checks = 0;
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'web-fixture',
    getSession: async id => ({ id, directory: f.directory }), withSessionLock: async (_id, action) => action(),
    authorizeOperation: async () => { throw Object.assign(new Error('plugin_denied'), { code: 'plugin_denied' }); },
    captureWebAuthorization: async request => {
      const original = principal;
      expect(request.directory).toBe(f.directory);
      return async () => { checks++; if (original !== 'caller' || !allowed) throw Object.assign(new Error('grant_revoked'), { code: 'grant_revoked' }); };
    } });
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  let stale;
  await owner.withWebOperation({ operation: 'sessions.update', method: 'PATCH', path: '/api/session/ses_root', body: { title: 'Reviewed' } }, async () => {
    stale = JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
    const request = { operation: 'session.rename', sessionID: 'ses_root', input: { sessionID: 'ses_root', title: 'Reviewed' }, existingPermit: stale };
    expect(await rpc('authorize', request)).toEqual(stale);
    await expect(rpc('authorize', { ...request, input: { ...request.input, title: 'Changed' } })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
    await expect(rpc('authorize', { ...request, operation: 'session.setPermissions' })).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
    principal = 'different'; // The callback continues checking the captured original.
    await rpc('recheck', { permit: stale, request });
    allowed = false;
    await expect(rpc('recheck', { permit: stale, request })).rejects.toMatchObject({ code: 'grant_revoked' });
  });
  expect(checks).toBeGreaterThan(2);
  await expect(rpc('recheck', { permit: stale, request: { operation: 'session.rename', sessionID: 'ses_root' } })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  principal = 'caller'; allowed = true;
  await owner.withWebOperation({ operation: 'permissions.reply', method: 'POST', path: '/api/session/ses_root/permission/per_one/reply', body: { decision: 'always' } }, async () => {
    const permit = JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
    const request = { operation: 'permission.reply', sessionID: 'ses_root', existingPermit: permit,
      input: { requestID: 'per_one', reply: 'always', pending: { sessionID: 'ses_root', action: 'read', resources: ['owned'] } } };
    await rpc('authorize', request);
    await expect(rpc('authorize', { ...request, input: { ...request.input, pending: { sessionID: 'ses_other' } } })).rejects.toMatchObject({ code: 'native_permit_lineage_mismatch' });
    await expect(rpc('authorize', { ...request, input: { ...request.input, reply: 'once' } })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
  });
  await expect(owner.withWebOperation({ operation: 'setPermissions', method: 'PATCH', path: '/api/session/ses_root', body: { permissions: [] } }, async () => {})).rejects.toMatchObject({ code: 'native_accepted_operation_required' });
});

test('web authorization refuses revocation during its canonical session read', async () => {
  const f = await fixture();
  let allowed = true, pauseRead;
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'web-revocation-fixture',
    authorizeOperation: async () => { throw new Error('Web effects require their captured grant'); },
    getSession: async id => {
      if (pauseRead) {
        const pause = pauseRead; pauseRead = undefined;
        pause.started();
        await pause.released;
      }
      return { id, directory: f.directory };
    },
    withSessionLock: async (_id, action) => action(),
    captureWebAuthorization: async () => async () => {
      if (!allowed) throw Object.assign(new Error('grant_revoked'), { code: 'grant_revoked' });
    } });
  for (const method of ['authorize', 'recheck']) {
    allowed = true;
    await owner.withWebOperation({ operation: 'sessions.update', method: 'PATCH', path: '/api/session/ses_root', body: { title: 'Reviewed' } }, async () => {
      const permit = JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
      const request = { operation: 'session.rename', sessionID: 'ses_root', input: { sessionID: 'ses_root', title: 'Reviewed' }, existingPermit: permit };
      let started, release;
      const reading = new Promise(resolve => { started = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      pauseRead = { started, released };
      const outcome = owner.handleRpc(`native.admission.${method}`, method === 'authorize' ? request : { permit, request });
      outcome.catch(() => {});
      await reading;
      allowed = false; // Logout, expiry, or revocation after the first authenticator check.
      release();
      await expect(outcome).rejects.toMatchObject({ code: 'grant_revoked' });
    });
  }
});

test('deferred execution wake acknowledgement cannot erase a newer hold revision', async () => {
  const f = await fixture(), input = { directory: f.directory, sessionID: 'ses_root', operation: 'execution.wake' };
  await f.runtime.deferNativeContinuation(input);
  const previous = (await f.runtime.nativeAdmissionState(input)).revision;
  await expect(f.runtime.acknowledgeNativeContinuation(input)).rejects.toMatchObject({ code: 'native_hold_revision_conflict' });
  const hold = await f.runtime.holdNativeAdmission({ ...input, ownerID: 'wake-revision' });
  await f.runtime.deferNativeContinuation(input);
  await f.runtime.releaseNativeAdmission({ ...input, ownerID: 'wake-revision', holdID: hold.id, expectedRevision: hold.revision });
  await expect(f.runtime.acknowledgeNativeContinuation({ ...input, expectedRevision: previous })).rejects.toMatchObject({ code: 'native_hold_revision_conflict' });
  expect(await f.reopen().nativeContinuations(input)).toEqual(['execution.wake']);
  const current = (await f.runtime.nativeAdmissionState(input)).revision;
  await f.runtime.acknowledgeNativeContinuation({ ...input, expectedRevision: current });
  expect(await f.reopen().nativeContinuations(input)).toEqual([]);
});

test('captured generation exists only for registered, settled sessions and changes on Revert', async () => {
  const f = await fixture(), query = { directory: f.directory, sessionID: 'ses_root' };
  expect(await f.runtime.capturedSessionState({ ...query, sessionID: 'missing' })).toEqual({ captured: false, pending: false });
  expect(await f.runtime.capturedSessionState(query)).toEqual({ captured: true, pending: false, generation: 0 });
  await f.runtime.registerPrompt({ ...query, userMessageID: 'msg_boundary' });
  const tx = await f.runtime.prepareRevert({ ...query, messageID: 'msg_boundary' });
  expect(await f.runtime.capturedSessionState(query)).toEqual({ captured: true, pending: true });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(await f.runtime.capturedSessionState(query)).toEqual({ captured: true, pending: false, generation: 1 });
});

test('queued managed create replaces an expired tool context with only the exact parent creation authority', async () => {
  const f = await managedFixture();
  const authorization = { operation: 'tool.execute', sessionID: 'ses_root', messageID: 'msg_task_assistant',
    input: { toolID: 'devryan_task', callID: 'call_task', provenance: { id: 'managed-task' }, input: { action: 'start' } } };
  const old = await f.rpc('authorize', authorization);
  await f.owner.withPermit({ permit: old, authorization, directory: f.directory, sessionID: 'ses_root',
    messageID: authorization.messageID, callID: 'call_task', tool: 'devryan_task', input: authorization.input.input }, async () => {
    await f.rpc('release', old);
    await f.owner.withManagedTaskDispatch(f.create, async () => {
      const permit = JSON.parse(f.owner.requestHeaders()['x-devryan-native-permit']);
      expect(permit.token).not.toBe(old.token);
      const request = { operation: 'session.create', sessionID: 'ses_root', input: { id: 'ses_new', parentID: 'ses_root', location: { directory: f.directory } }, existingPermit: permit };
      expect(await f.rpc('authorize', request)).toEqual(permit);
      await f.rpc('recheck', { permit, request });
      for (const changed of [{ ...request, operation: 'session.prompt' }, { ...request, input: { ...request.input, parentID: 'ses_other' } },
        { ...request, input: { ...request.input, location: { directory: f.storage } } }]) {
        await expect(f.rpc('authorize', changed)).rejects.toMatchObject({ code: 'native_managed_task_scope_invalid' });
      }
      f.task.status = 'cancelled';
      await expect(f.rpc('recheck', { permit, request })).rejects.toMatchObject({ code: 'native_managed_task_lease_invalid' });
    });
  });
  expect(f.locks).toEqual(['ses_root', 'ses_root']);
  expect(f.owner.requestHeaders()).toEqual({});
  await expect(f.rpc('withManagedTaskDispatch', f.create)).rejects.toMatchObject({ code: 'native_admission_rpc_unavailable' });
});

test('managed child accepted selection and inbox effects retain exact tuple and current task lease', async () => {
  const f = await managedFixture(); f.task.childSessionId = 'ses_child';
  await f.owner.withManagedTaskDispatch(f.prompt, async () => {
    expect(f.owner.requestHeaders()).toEqual({});
    await f.owner.withAcceptedOperation(f.accepted, async () => {
      const permit = JSON.parse(f.owner.requestHeaders()['x-devryan-native-permit']);
      const requests = [
        { operation: 'session.switchAgent', sessionID: 'ses_child', input: { agent: 'build' } },
        { operation: 'session.switchModel', sessionID: 'ses_child', input: { model: { providerID: 'fixture', id: 'model' } } },
        { operation: 'session.setPermissions', sessionID: 'ses_child', input: { rules: [] } },
        { operation: 'session.prompt', sessionID: 'ses_child', messageID: f.accepted.messageID },
        { operation: 'inbox.admit', sessionID: 'ses_child', messageID: f.accepted.messageID },
      ];
      for (const request of requests) expect(await f.rpc('authorize', { ...request, existingPermit: permit })).toEqual(permit);
      await expect(f.rpc('authorize', { ...requests[1], input: { model: { providerID: 'foreign', id: 'model' } }, existingPermit: permit }))
        .rejects.toMatchObject({ code: 'native_managed_task_scope_invalid' });
      f.task.leaseToken = 'replacement_lease';
      for (const request of requests) await expect(f.rpc('recheck', { permit, request })).rejects.toMatchObject({ code: 'native_managed_task_lease_invalid' });
    });
  });
  expect(f.locks).toEqual([]);
});

test('managed dispatch rejects reverted parent generation and durable holds before invoking native effects', async () => {
  const f = await managedFixture(); let effects = 0;
  await f.owner.withManagedTaskDispatch(f.create, async () => { effects++; });
  const hold = await f.runtime.holdNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'managed-hold' });
  await expect(f.owner.withManagedTaskDispatch(f.create, async () => { effects++; })).rejects.toMatchObject({ code: 'native_session_held' });
  await f.runtime.releaseNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'managed-hold', holdID: hold.id, expectedRevision: hold.revision });
  const tx = await f.runtime.prepareRevert({ directory: f.directory, sessionID: 'ses_root', messageID: 'msg_task_user' });
  await expect(f.owner.withManagedTaskDispatch(f.create, async () => { effects++; })).rejects.toMatchObject({ code: 'native_managed_task_control_invalid' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect((await f.runtime.leaseForCall({ directory: f.directory, sessionID: 'ses_root', callID: 'call_task' })).generation).toBe(0);
  expect((await f.runtime.capturedSessionState({ directory: f.directory, sessionID: 'ses_root' })).generation).toBe(1);
  await expect(f.owner.withManagedTaskDispatch(f.create, async () => { effects++; })).rejects.toMatchObject({ code: 'native_managed_task_control_invalid' });
  expect(effects).toBe(1);
});

test('managed dispatch awaiting scheduler ownership cannot survive controller invalidation', async () => {
  const f = await managedFixture(); let entered, unblock, effects = 0;
  const blocked = new Promise(resolve => { entered = resolve; });
  f.setVerifier(async () => { entered(); await new Promise(resolve => { unblock = resolve; }); return structuredClone(f.task); });
  const pending = f.owner.withManagedTaskDispatch(f.create, async () => { effects++; });
  await blocked; await f.owner.invalidateController(); unblock();
  await expect(pending).rejects.toMatchObject({ code: 'native_permit_revoked' });
  expect(effects).toBe(0);
  f.setVerifier(async () => structuredClone(f.task));
  await f.owner.withManagedTaskDispatch(f.create, async () => { effects++; });
  expect(effects).toBe(1);
});

test('durable native holds fence descendants after restart while siblings retain admission', async () => {
  const f = await fixture();
  const hold = await f.runtime.holdNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'native' });
  const reopened = f.reopen();
  expect((await reopened.nativeAdmissionState({ directory: f.directory, sessionID: 'ses_child' })).held).toBe(true);
  await expect(reopened.assertAdmission({ directory: f.directory, sessionID: 'ses_child' })).rejects.toMatchObject({ code: 'native_session_held' });
  expect(await reopened.assertAdmission({ directory: f.directory, sessionID: 'ses_other' })).toEqual({ admitted: true });
  await expect(reopened.releaseNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'wrong', holdID: hold.id, expectedRevision: hold.revision }))
    .rejects.toMatchObject({ code: 'native_hold_owner_mismatch' });
  await expect(reopened.releaseNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'native', holdID: hold.id, expectedRevision: hold.revision + 1 }))
    .rejects.toMatchObject({ code: 'native_hold_revision_conflict' });
  await reopened.releaseNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'native', holdID: hold.id, expectedRevision: hold.revision });
  expect((await f.runtime.nativeAdmissionState({ directory: f.directory, sessionID: 'ses_child' })).revision).toBe(2);
});

test('controller invalidation fences old global/session permits and authorization suspended across replacement', async () => {
  const f = await fixture();
  let unblock, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'epoch-fixture',
    getSession: async id => ({ id, directory: f.directory }), withSessionLock: async (_id, action) => action(),
    authorizeOperation: async request => {
      if (request.operation === 'fixture.blocked') { entered(); await new Promise(resolve => { unblock = resolve; }); }
    } });
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  const global = await rpc('authorize', { operation: 'session.create' });
  const runner = await rpc('authorize', { operation: 'runner.drain', sessionID: 'ses_root' });
  const pending = rpc('authorize', { operation: 'fixture.blocked' });
  await blocked;
  await owner.invalidateController(); unblock();
  await expect(pending).rejects.toMatchObject({ code: 'native_permit_revoked' });
  await expect(rpc('recheck', { permit: global, request: { operation: 'session.create' } })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  await expect(rpc('authorize', { operation: 'primary.step', sessionID: 'ses_root', existingPermit: runner })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  await expect(rpc('invalidateController')).rejects.toMatchObject({ code: 'native_admission_rpc_unavailable' });
  const fresh = await rpc('authorize', { operation: 'runner.drain', sessionID: 'ses_root' });
  expect(await rpc('recheck', { permit: fresh, request: { operation: 'runner.drain', sessionID: 'ses_root' } })).toBeNull();
  const hold = await f.runtime.holdNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'epoch-fixture' });
  await owner.invalidateController();
  await expect(rpc('authorize', { operation: 'runner.drain', sessionID: 'ses_root' })).rejects.toMatchObject({ code: 'native_session_held' });
  expect((await f.reopen().nativeAdmissionState({ directory: f.directory, sessionID: 'ses_root' })).holds)
    .toEqual([{ id: hold.id, ownerID: 'epoch-fixture', sessionID: 'ses_root' }]);
});

test('a recheck waiting for canonical state cannot complete from its captured old controller entry', async () => {
  const f = await fixture();
  let pause = false, unblock, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'epoch-recheck-fixture',
    getSession: async id => {
      if (pause) { entered(); await new Promise(resolve => { unblock = resolve; }); }
      return { id, directory: f.directory };
    }, authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action() });
  const request = { operation: 'runner.drain', sessionID: 'ses_root' };
  const permit = await owner.handleRpc('native.admission.authorize', request);
  pause = true;
  const pending = owner.handleRpc('native.admission.recheck', { permit, request });
  await blocked; await owner.invalidateController(); pause = false; unblock();
  await expect(pending).rejects.toMatchObject({ code: 'native_permit_revoked' });
  const fresh = await owner.handleRpc('native.admission.authorize', request);
  expect(await owner.handleRpc('native.admission.recheck', { permit: fresh, request })).toBeNull();
});

test('private HTTP preserves native owner invalid/held/stopped refusal status and exact code', async () => {
  const f = await fixture();
  const host = createManagedOrchestrationPrivateHost({ handleRpc: ({ method, params }) => f.owner.handleRpc(method, params) });
  const environment = await host.start();
  const call = async (method, params) => {
    const response = await fetch(environment.DEVRYAN_ORCHESTRATION_URL, { method: 'POST',
      headers: { authorization: `Bearer ${environment.DEVRYAN_ORCHESTRATION_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: `native.admission.${method}`, params }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const invalid = await call('recheck', { permit: { token: 'a'.repeat(64), sessionID: 'ses_root', revision: 0 },
      request: { operation: 'runner.drain', sessionID: 'ses_root' } });
    expect(invalid).toMatchObject({ status: 403, body: { ok: false, error: { code: 'native_permit_invalid' } } });
    await f.runtime.holdNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'http-fixture' });
    expect(await call('authorize', { operation: 'runner.drain', sessionID: 'ses_root' }))
      .toMatchObject({ status: 409, body: { ok: false, error: { code: 'native_session_held' } } });
    f.owner.dispose();
    expect(await call('ready', {})).toMatchObject({ status: 503, body: { ok: false, error: { code: 'native_owner_stopped' } } });
  } finally { await host.stop(); }
});

test('a hold refuses already reserved claim and publication, preserving project bytes', async () => {
  const f = await fixture();
  const scope = { directory: f.directory, sessionID: 'ses_root', userMessageID: 'msg_u', messageID: 'msg_a', callID: 'call_a', kind: 'control' };
  const lease = await f.runtime.begin(scope);
  await f.runtime.holdNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'native' });
  await expect(f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'control' })).rejects.toMatchObject({ code: 'native_session_held' });
  await expect(f.runtime.registerPrompt({ ...scope, userMessageID: 'msg_next' })).rejects.toMatchObject({ code: 'native_session_held' });
});

test('generic native release preserves an independently prepared Revert and deferred intents', async () => {
  const f = await fixture();
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'ses_root', userMessageID: 'msg_u' });
  const tx = await f.runtime.prepareRevert({ directory: f.directory, sessionID: 'ses_root', messageID: 'msg_u' });
  const hold = await f.runtime.holdNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'native' });
  await f.runtime.deferNativeContinuation({ directory: f.directory, sessionID: 'ses_root', operation: 'execution.wake' });
  const released = await f.runtime.releaseNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'native', holdID: hold.id, expectedRevision: hold.revision });
  expect(released.held).toBe(true); expect(released.reverting).toBe(true);
  expect(await f.reopen().nativeContinuations({ directory: f.directory, sessionID: 'ses_root' })).toEqual(['execution.wake']);
  await expect(f.runtime.acknowledgeNativeContinuation({ directory: f.directory, sessionID: 'ses_root', operation: 'execution.wake' })).rejects.toMatchObject({ code: 'session_reverting' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: false });
});

test('real private permits bind tool provenance, input presence, outer dispatch identity and durable revisions', async () => {
  const f = await fixture();
  const authorization = { operation: 'tool.execute', sessionID: 'ses_root', messageID: 'msg_a', input: { toolID: 'write', callID: 'call_a', provenance: { id: 'native-write' }, input: { path: 'a', content: 'safe' } } };
  const permit = await f.rpc('authorize', authorization);
  const input = { permit, authorization, sessionID: 'ses_root', messageID: 'msg_a', callID: 'call_a', tool: 'write', directory: f.directory, input: authorization.input.input };
  await f.owner.recheckExecution(input);
  for (const changed of [{ ...authorization, input: { ...authorization.input, provenance: { id: 'managed-task' } } },
    { ...authorization, input: { toolID: 'write', callID: 'call_a', provenance: authorization.input.provenance } }]) {
    await expect(f.rpc('recheck', { permit, request: changed })).rejects.toMatchObject({ code: 'native_permit_lineage_mismatch' });
  }
  await expect(f.owner.recheckExecution({ ...input, sessionID: 'ses_other' })).rejects.toMatchObject({ code: 'native_execution_lineage_mismatch' });
  await expect(f.rpc('authorize', { operation: 'session.setPermissions', sessionID: 'ses_root', existingPermit: permit })).rejects.toMatchObject({ code: 'permission_denied' });
  await f.rpc('hold', { sessionID: 'ses_root' });
  await expect(f.owner.recheckExecution(input)).rejects.toMatchObject({ code: 'native_permit_revoked' });
});

test('accepted web admission reuses its owner span and cannot trust caller fingerprint metadata', async () => {
  const f = await fixture(), fingerprint = 'a'.repeat(64);
  const metadata = { devryan: { v: 1, origin: 'user', planMode: false, parts: [{ kind: 'text', length: 4 }], admission: { v: 1, fingerprint } } };
  await f.owner.withAcceptedOperation({ sessionID: 'ses_root', messageID: 'msg_u', fingerprint, metadata, request: { text: 'safe' } }, async () => {
    const permit = JSON.parse(f.owner.requestHeaders()['x-devryan-native-permit']);
    expect((await f.rpc('authorize', { operation: 'session.prompt', sessionID: 'ses_root', existingPermit: permit })).token).toBe(permit.token);
    const sealed = await f.rpc('sealPrompt', { permit, input: { sessionID: 'ses_root', messageID: 'msg_u', prompt: { text: 'safe' }, delivery: 'queue', metadata: { devryan: { admission: { fingerprint: 'b'.repeat(64) } } } } });
    expect(sealed).toEqual(metadata);
    await f.rpc('verifyAccepted', { permit, accepted: { id: 'msg_u', sessionID: 'ses_root', type: 'user', payload: { text: 'safe', metadata: sealed } } });
    await expect(f.rpc('verifyAccepted', { permit, accepted: { id: 'msg_u', sessionID: 'ses_root', type: 'user', payload: { text: 'safe', metadata: { ...sealed, forged: true } } } }))
      .rejects.toMatchObject({ code: 'native_prompt_metadata_unsealed' });
  });
  expect(f.owner.requestHeaders()).toEqual({});
});

test('transaction capabilities admit only exact conversation targets and settled recovery releases owned holds', async () => {
  const f = await fixture();
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'ses_root', userMessageID: 'msg_u' });
  const tx = await f.runtime.prepareRevert({ directory: f.directory, sessionID: 'ses_root', messageID: 'msg_u' });
  await f.rpc('hold', { sessionID: 'ses_root' });
  await f.runtime.updateTransaction({ directory: f.directory, transactionID: tx.id, expectedPhase: 'prepared', phase: 'stopped', boundaries: [{ id: 'ses_root', revert: null }] });
  await f.runtime.updateTransaction({ directory: f.directory, transactionID: tx.id, expectedPhase: 'stopped', phase: 'conversation' });
  const input = { directory: f.directory, sessionID: 'ses_root', transactionID: tx.id, operation: 'session.revert.stage', messageID: 'msg_u', files: false };
  await expect(f.owner.withRevertOperation({ ...input, messageID: 'msg_other' }, async () => {})).rejects.toMatchObject({ code: 'native_revert_capability_invalid' });
  await f.owner.withRevertOperation(input, async () => {
    const permit = JSON.parse(f.owner.requestHeaders()['x-devryan-native-permit']);
    expect(await f.rpc('authorize', { operation: input.operation, sessionID: input.sessionID, input: { messageID: 'msg_u', files: false }, existingPermit: permit })).toEqual(permit);
    await expect(f.rpc('authorize', { operation: 'session.prompt', sessionID: input.sessionID, existingPermit: permit })).rejects.toMatchObject({ code: 'native_revert_capability_invalid' });
    await expect(f.rpc('authorize', { operation: 'session.revert.commit', sessionID: input.sessionID, existingPermit: permit })).rejects.toMatchObject({ code: 'native_revert_capability_invalid' });
    await expect(f.rpc('recheck', { permit, request: { operation: input.operation, sessionID: input.sessionID, input: { messageID: 'msg_u', files: true } } })).rejects.toMatchObject({ code: 'native_revert_capability_invalid' });
  });
  await expect(f.owner.releaseTransactionHolds({ directory: f.directory, transactionID: tx.id, sessions: tx.members })).rejects.toMatchObject({ code: 'native_revert_release_invalid' });
  await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: false });
  expect((await f.runtime.nativeAdmissionState({ directory: f.directory, sessionID: 'ses_root' })).held).toBe(true);
  const recovered = createNativeAdmissionOwner({ runtime: f.reopen(), directory: f.directory, ownerID: 'fixture-bundle',
    getSession: async id => ({ id, directory: f.directory }), authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action() });
  await recovered.recoverTransactionHolds({ directory: f.directory });
  await recovered.releaseTransactionHolds({ directory: f.directory, transactionID: tx.id, sessions: tx.members });
  expect((await f.runtime.nativeAdmissionState({ directory: f.directory, sessionID: 'ses_root' })).held).toBe(false);
});

test('uncoordinated native deletion and whole claim sweeps refuse despite permissive host policy', async () => {
  const f = await fixture();
  for (const operation of ['session.revert.stage', 'session.revert.clear', 'session.revert.commit']) {
    await expect(f.rpc('authorize', { operation, sessionID: 'ses_root' })).rejects.toMatchObject({ code: 'native_revert_capability_required' });
  }
  await expect(f.rpc('authorize', { operation: 'session.remove', sessionID: 'ses_root' })).rejects.toMatchObject({ code: 'native_owned_lifecycle_required' });
  await f.rpc('hold', { sessionID: 'ses_child' });
  for (const operation of ['restart.resume', 'store.releaseChildClaims']) {
    await expect(f.rpc('authorize', { operation, input: ['ses_other'] })).rejects.toMatchObject({ code: 'native_owned_lifecycle_required' });
  }
  await expect(f.owner.handleRpc('withRevertOperation', {})).rejects.toMatchObject({ code: 'native_admission_rpc_unavailable' });
});

test('detached runner starts obtain independent admission while expired tool capabilities remain denied', async () => {
  const f = await fixture();
  const tool = { operation: 'tool.execute', sessionID: 'ses_root', messageID: 'msg_a',
    input: { toolID: 'read', callID: 'call_a', provenance: { id: 'native-read' }, input: { path: 'one.txt' } } };
  const expired = await f.rpc('authorize', tool);
  await f.rpc('release', expired);
  for (const operation of ['runner.drain', 'store.claim', 'execution.resume']) {
    const permit = await f.rpc('authorize', { operation, sessionID: 'ses_root', existingPermit: expired });
    expect(permit.token).not.toBe(expired.token);
    await f.rpc('release', permit);
  }
  await expect(f.rpc('authorize', { ...tool, existingPermit: expired })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  await f.rpc('hold', { sessionID: 'ses_root' });
  await expect(f.rpc('authorize', { operation: 'runner.drain', sessionID: 'ses_root', existingPermit: expired })).rejects.toMatchObject({ code: 'native_session_held' });
});

test('claim commit uses captured canonical authority without a recursive native database read', async () => {
  const f = await fixture();
  let inCommit = false;
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'commit-fixture',
    getSession: async id => { if (inCommit) throw new Error('Recursive native database read'); return { id, directory: f.directory }; },
    authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action() });
  await expect(owner.handleRpc('native.admission.authorize', { operation: 'store.claim', sessionID: 'ses_root' }))
    .rejects.toMatchObject({ code: 'native_session_binding_required' });
  const initial = await owner.handleRpc('native.admission.authorize', { operation: 'runner.drain', sessionID: 'ses_root' });
  await owner.handleRpc('native.admission.release', initial);
  inCommit = true;
  const claim = await owner.handleRpc('native.admission.authorize', { operation: 'store.claim', sessionID: 'ses_root', existingPermit: initial });
  expect(claim.token).not.toBe(initial.token);
  await f.runtime.holdNativeAdmission({ directory: f.directory, sessionID: 'ses_root', ownerID: 'other' });
  await expect(owner.handleRpc('native.admission.authorize', { operation: 'store.claim', sessionID: 'ses_root' })).rejects.toMatchObject({ code: 'native_session_held' });
});

test('shell job identity persists in the same ledger and released tool permits retain only one exact publication check', async () => {
  const f = await fixture();
  const scope = { directory: f.directory, sessionID: 'ses_root', userMessageID: 'msg_u', messageID: 'msg_a', callID: 'call_a', kind: 'process' };
  const lease = await f.runtime.begin(scope);
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'shell-fixture',
    getSession: async id => ({ id, directory: f.directory }), authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action(),
    bindShellJob: input => f.runtime.bindNativeShellJob({ ...input, token: lease.token }) });
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  const authorization = { operation: 'tool.execute', sessionID: 'ses_root', messageID: 'msg_a',
    input: { toolID: 'shell', callID: 'call_a', provenance: { kind: 'native', id: 'opencode.tool.shell' }, input: { command: 'echo safe', background: true } } };
  const permit = await rpc('authorize', authorization);
  const input = { permit, authorization, directory: f.directory, sessionID: 'ses_root', messageID: 'msg_a', callID: 'call_a', tool: 'shell' };
  await rpc('registerShellJob', { ...input, jobID: 'shell_a', command: 'echo safe', handle: 'owned_handle' });
  const bound = await f.reopen().nativeShellJob({ directory: f.directory, sessionID: 'ses_root', jobID: 'shell_a' });
  expect(bound.token).toBe(lease.token); expect(bound.scope.userMessageID).toBe('msg_u');
  await rpc('authorize', { operation: 'job.shell.start', sessionID: 'ses_root', existingPermit: permit,
    input: { jobID: 'shell_a', type: 'shell', command: 'echo safe', recovery: { kind: 'shell', sessionID: 'ses_root', shellID: 'shell_a', command: 'echo safe' } } });
  await rpc('authorize', { operation: 'job.shell.background.commit', sessionID: 'ses_root', existingPermit: permit,
    input: { jobID: 'shell_a', notificationID: 'msg_notice' } });
  await f.runtime.bindNativeShellJob({ ...scope, token: lease.token, jobID: 'shell_a', command: 'echo safe' });
  expect((await f.runtime.nativeShellJob({ directory: f.directory, sessionID: 'ses_root', jobID: 'shell_a' })).nativeShellJob.notificationID).toBe('msg_notice');
  await expect(f.runtime.bindNativeShellNotification({ directory: f.directory, sessionID: 'ses_root', jobID: 'shell_a', notificationID: 'msg_forged' }))
    .rejects.toMatchObject({ code: 'native_shell_job_conflict' });
  await rpc('release', permit);
  await expect(rpc('authorize', { ...authorization, existingPermit: permit })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  await expect(owner.recheckExecution({ ...input, phase: 'publication', token: 'other' })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  await owner.recheckExecution({ ...input, phase: 'publication', token: lease.token });
  await expect(owner.recheckExecution({ ...input, phase: 'publication', token: lease.token })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  const old = await rpc('authorize', authorization), oldInput = { ...input, permit: old };
  await rpc('registerShellJob', { ...oldInput, jobID: 'shell_a', command: 'echo safe', handle: 'owned_handle' });
  await rpc('release', old);
  // This contract fixture has no launched OS process. Native acceptance proves
  // the prerequisite real settlement before replacement independently.
  await f.runtime.finish({ directory: f.directory, token: lease.token });
  await owner.invalidateController();
  await expect(owner.recheckExecution({ ...oldInput, phase: 'publication', token: lease.token })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  expect((await f.runtime.nativeShellJob({ directory: f.directory, sessionID: 'ses_root', jobID: 'shell_a' })).state).toBe('published');
});

test('shell synthetic admission requires actual terminal lease proof and commits a separate owned wake capability', async () => {
  const f = await fixture(), notices = [];
  const scope = { directory: f.directory, sessionID: 'ses_root', userMessageID: 'msg_u', messageID: 'msg_a', callID: 'call_a', kind: 'process' };
  const lease = await f.runtime.begin(scope);
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  await f.runtime.bindNativeShellJob({ ...scope, token: lease.token, jobID: 'shell_a', command: 'echo safe' });
  await f.runtime.bindNativeShellNotification({ directory: f.directory, sessionID: 'ses_root', jobID: 'shell_a', notificationID: 'msg_notice' });
  await f.runtime.finish({ directory: f.directory, token: lease.token });
  let terminated = false, pauseReceipt = false, unblockReceipt, enteredReceipt;
  const receiptBlocked = new Promise(resolve => { enteredReceipt = resolve; });
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'shell-completion-fixture',
    getSession: async id => ({ id, directory: f.directory }), authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action(),
    // This contract fixture injects the worker's receipt boundary. Native QA
    // separately requires the real confined process termination receipt.
    getShellJobReceipt: async input => {
      if (pauseReceipt) { enteredReceipt(); await new Promise(resolve => { unblockReceipt = resolve; }); }
      return { lease: await f.runtime.nativeShellJob(input), receipt: { terminated, confined: true, exitCode: 0 } };
    },
    onContinuation: async input => {
      notices.push(input);
      expect(await owner.handleRpc('native.admission.authorize', { operation: 'shell.continue', sessionID: input.sessionID, existingPermit: input.permit })).toEqual(input.permit);
      await expect(owner.handleRpc('native.admission.authorize', { operation: 'session.setPermissions', sessionID: input.sessionID, existingPermit: input.permit }))
        .rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
    } });
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  const input = { id: 'msg_notice', sessionID: 'ses_root', description: 'echo safe',
    text: '<shell id="shell_a" state="completed" command="echo safe">\nsafe\n</shell>',
    metadata: { source: 'shell', jobID: 'shell_a', shellID: 'shell_a' },
    nativeJob: { id: 'shell_a', type: 'shell', title: 'echo safe', status: 'completed', output: 'safe', notificationID: 'msg_notice' } };
  const request = { operation: 'session.synthetic', sessionID: 'ses_root', messageID: 'msg_notice', input };
  await expect(rpc('authorize', request)).rejects.toMatchObject({ code: 'native_completion_receipt_invalid' });
  terminated = true;
  pauseReceipt = true;
  const oldReceipt = rpc('authorize', request);
  await receiptBlocked; await owner.invalidateController(); pauseReceipt = false; unblockReceipt();
  await expect(oldReceipt).rejects.toMatchObject({ code: 'native_permit_revoked' });
  await expect(rpc('authorize', { ...request, input: { ...input, text: 'forged' } })).rejects.toMatchObject({ code: 'native_completion_payload_changed' });
  const permit = await rpc('authorize', request), metadata = await rpc('sealSynthetic', { permit, input });
  const item = { type: 'synthetic', id: input.id, sessionID: input.sessionID, payload: { text: input.text, description: input.description, metadata } };
  await rpc('verifyAccepted', { permit, accepted: { item: { id: item.id, sessionID: item.sessionID,
    item: { type: item.type, payload: item.payload, delivery: 'steer' } }, phase: 'preflight' } });
  const retained=await f.runtime.nativeShellJob({directory:f.directory,sessionID:'ses_root',jobID:'shell_a'});
  expect(retained.nativeShellJob.itemHash).toBe(recoveredInputHash({type:'synthetic',delivery:'steer',payload:item.payload}));
  expect(retained.nativeShellJob.itemDelivery).toBe('steer');
  await expect(f.runtime.bindNativeShellNotification({directory:f.directory,sessionID:'ses_root',jobID:'shell_a',notificationID:'msg_notice',itemHash:'0'.repeat(64),itemDelivery:'steer'})).rejects.toMatchObject({code:'native_shell_job_conflict'});
  await expect(f.runtime.bindNativeShellNotification({directory:f.directory,sessionID:'ses_root',jobID:'shell_a',notificationID:'msg_notice',itemHash:42,itemDelivery:'steer'})).rejects.toMatchObject({code:'native_shell_job_conflict'});
  expect(notices).toEqual([]);
  expect((await f.runtime.nativeShellJob({ directory: f.directory, sessionID: 'ses_root', jobID: 'shell_a' })).nativeShellJob.deliveredID).toBeUndefined();
  await rpc('verifyAccepted', { permit, accepted: { item, phase: 'committed' } });
  expect(notices[0]).toMatchObject({ operation: 'shell.complete', userMessageID: 'msg_u', assistantMessageID: 'msg_a', callID: 'call_a', messageID: 'msg_notice' });
  expect(await f.runtime.nativeContinuations({ directory: f.directory, sessionID: 'ses_root' })).toEqual(['shell.complete:shell_a']);
  // Wake registration is coalesced in this owner, while the durable intent
  // survives until exact native started evidence is observed.
  await rpc('verifyAccepted', { permit, accepted: { item, phase: 'committed' } });
  expect(notices).toHaveLength(1);
  // The same Node owner survives a replacement native controller. A volatile
  // wake cache must not skip inspection of the retained durable operation.
  await owner.recoverShellContinuations({ directory: f.directory });
  expect(notices).toHaveLength(2);
  await expect(rpc('acknowledgeStartedContinuation', { sessionID: 'ses_root', userMessageID: 'msg_notice', assistantMessageID: 'msg_resume' }))
    .rejects.toMatchObject({ code: 'native_admission_rpc_unavailable' });
  await owner.acknowledgeStartedContinuation({ sessionID: 'ses_root', userMessageID: 'msg_other', assistantMessageID: 'msg_resume' });
  expect(await f.runtime.nativeContinuations({ directory: f.directory, sessionID: 'ses_root' })).toEqual(['shell.complete:shell_a']);
  await owner.acknowledgeStartedContinuation({ sessionID: 'ses_root', userMessageID: 'msg_notice', assistantMessageID: 'msg_resume' });
  await owner.acknowledgeStartedContinuation({ sessionID: 'ses_root', userMessageID: 'msg_notice', assistantMessageID: 'msg_resume' });
  expect(await f.runtime.nativeContinuations({ directory: f.directory, sessionID: 'ses_root' })).toEqual([]);
  expect((await f.runtime.nativeShellJob({ directory: f.directory, sessionID: 'ses_root', jobID: 'shell_a' })).nativeShellJob)
    .toMatchObject({ continuedID: 'msg_notice', continuedAssistantID: 'msg_resume' });
  await expect(rpc('authorize', { operation: 'shell.continue', sessionID: 'ses_root', existingPermit: notices[0].permit })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  await rpc('release', permit);
  await rpc('hold', { sessionID: 'ses_root' });
  await expect(rpc('authorize', request)).rejects.toMatchObject({ code: 'native_session_held' });
  expect(await f.reopen().nativeContinuations({ directory: f.directory, sessionID: 'ses_root' })).toEqual(['shell.complete:shell_a']);
  const restarted = createNativeAdmissionOwner({ runtime: f.reopen(), directory: f.directory, ownerID: 'shell-completion-fixture',
    getSession: async id => ({ id, directory: f.directory }), authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action(),
    onContinuation: async () => { throw new Error('Already continued shell must not resume twice'); } });
  await restarted.handleRpc('native.admission.releaseHold', { sessionID: 'ses_root' });
  expect(await f.runtime.nativeContinuations({ directory: f.directory, sessionID: 'ses_root' })).toEqual([]);
}, 20_000);

test('same-owner replacement rebinds current canonical lineage before a retained shell wake enters Store.claim', async () => {
  const f = await fixture();
  const scope = { directory: f.directory, sessionID: 'ses_child', parentID: 'ses_root',
    userMessageID: 'msg_u', messageID: 'msg_a', callID: 'call_restart', kind: 'process' };
  const lease = await f.runtime.begin(scope);
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  await f.runtime.bindNativeShellJob({ ...scope, token: lease.token, jobID: 'shell_restart', command: 'echo fixture' });
  await f.runtime.bindNativeShellNotification({ ...scope, jobID: 'shell_restart', notificationID: 'msg_notice_restart' });
  await f.runtime.finish({ directory: f.directory, token: lease.token });
  await f.runtime.acknowledgeNativeShellCompletion({ ...scope, jobID: 'shell_restart', notificationID: 'msg_notice_restart' });
  await f.runtime.deferNativeContinuation({ ...scope, operation: 'shell.complete:shell_restart' });
  const reads = [], claims = [];
  let insideClaim = false;
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'replacement-binding-fixture',
    getSession: async id => {
      expect(insideClaim).toBe(false);
      reads.push(id);
      return { id, directory: f.directory, ...(id === 'ses_child' ? { parentID: 'ses_root' } : {}) };
    }, authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action(),
    getShellJobReceipt: async input => ({ lease: await f.runtime.nativeShellJob(input),
      receipt: { terminated: true, confined: true, exitCode: 0 } }),
    onContinuation: async input => {
      expect(input).toMatchObject({ sessionID: 'ses_child', messageID: 'msg_notice_restart', jobID: 'shell_restart' });
      // Model the native commit callback: no recursive HTTP/session read may
      // occur while its store transaction awaits this independent claim.
      insideClaim = true;
      try {
        for (const sessionID of ['ses_root', 'ses_child']) {
          const permit = await owner.handleRpc('native.admission.authorize', { operation: 'store.claim', sessionID });
          claims.push(sessionID);
          await owner.handleRpc('native.admission.release', permit);
        }
      } finally { insideClaim = false; }
      return { kind: 'registered', messageID: input.messageID };
    } });
  await owner.handleRpc('native.admission.authorize', { operation: 'runner.drain', sessionID: 'ses_child' });
  await owner.invalidateController();
  await expect(owner.handleRpc('native.admission.authorize', { operation: 'store.claim', sessionID: 'ses_child' }))
    .rejects.toMatchObject({ code: 'native_session_binding_required' });
  reads.length = 0;
  await owner.recoverShellContinuations({ directory: f.directory });
  expect(reads).toEqual(['ses_child', 'ses_child', 'ses_root']);
  expect(claims).toEqual(['ses_root', 'ses_child']);
  expect(await f.runtime.nativeContinuations(scope)).toEqual(['shell.complete:shell_restart']);
  const held = await f.runtime.holdNativeAdmission({ ...scope, ownerID: 'replacement-binding-fixture' });
  await owner.recoverShellContinuations({ directory: f.directory });
  expect(claims).toHaveLength(2);
  expect((await f.runtime.nativeAdmissionState(scope)).holds).toContainEqual({ id: held.id,
    ownerID: 'replacement-binding-fixture', sessionID: 'ses_child' });
});

test('retained shell intents recover consumed notices without another wake and acknowledge an exact batch atomically against holds', async () => {
  const f = await fixture(), scope = { directory: f.directory, sessionID: 'ses_root', userMessageID: 'msg_u', messageID: 'msg_a', kind: 'process' };
  for (const index of [1, 2]) {
    const lease = await f.runtime.begin({ ...scope, callID: `call_${index}` });
    await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
    await f.runtime.bindNativeShellJob({ ...scope, token: lease.token, callID: `call_${index}`, jobID: `shell_${index}`, command: 'echo fixture' });
    await f.runtime.bindNativeShellNotification({ ...scope, jobID: `shell_${index}`, notificationID: `msg_notice_${index}` });
    await f.runtime.finish({ directory: f.directory, token: lease.token });
    await f.runtime.acknowledgeNativeShellCompletion({ ...scope, jobID: `shell_${index}`, notificationID: `msg_notice_${index}` });
    await f.runtime.deferNativeContinuation({ ...scope, operation: `shell.complete:shell_${index}` });
  }
  let observations = 0, raced = false;
  const owner = createNativeAdmissionOwner({ runtime: f.reopen(), directory: f.directory, ownerID: 'recover-fixture',
    getSession: async id => ({ id, directory: f.directory }), authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action(),
    getShellJobReceipt: async input => {
      if (raced) {
        const hold = await f.runtime.holdNativeAdmission({ ...scope, ownerID: 'racing-hold' });
        await f.runtime.releaseNativeAdmission({ ...scope, ownerID: 'racing-hold', holdID: hold.id, expectedRevision: hold.revision });
        raced = false;
      }
      return { lease: await f.runtime.nativeShellJob(input), receipt: { terminated: true, confined: true, exitCode: 0 } };
    },
    onContinuation: async input => { observations++; return { kind: 'consumed', messageID: input.messageID, assistantMessageID: 'msg_real_step' }; } });
  raced = true;
  await expect(owner.acknowledgeStartedContinuation({ sessionID: scope.sessionID, userMessageID: 'msg_notice_2',
    consumedUserMessageIDs: ['msg_notice_1', 'msg_notice_2'], assistantMessageID: 'msg_real_step' })).rejects.toMatchObject({ code: 'native_permit_revoked' });
  expect(await f.runtime.nativeContinuations(scope)).toEqual(['shell.complete:shell_1', 'shell.complete:shell_2']);
  await owner.recoverShellContinuations({ directory: f.directory });
  expect(observations).toBe(2);
  expect(await f.runtime.nativeContinuations(scope)).toEqual([]);
  for (const index of [1, 2]) expect((await f.runtime.nativeShellJob({ ...scope, jobID: `shell_${index}` })).nativeShellJob)
    .toMatchObject({ continuedID: `msg_notice_${index}`, continuedAssistantID: 'msg_real_step' });
  // A generic web owner without shell machinery must still accept unrelated
  // canonical Steps when it has no retained shell intents.
  await f.owner.acknowledgeStartedContinuation({ sessionID: 'ses_other', userMessageID: 'msg_other', assistantMessageID: 'msg_other_step' });
}, 20_000);

test('native attachment sealing refuses lexical and canonical git metadata and protected owner roots', async () => {
  const f = await fixture(), protectedRoot = path.join(f.directory, 'private');
  await fs.mkdir(protectedRoot); await fs.writeFile(path.join(protectedRoot, 'state'), 'fixture');
  await fs.writeFile(path.join(f.directory, 'safe.txt'), 'fixture');
  await fs.symlink('.git/config', path.join(f.directory, 'git-link'));
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'attachment-fixture', protectedRoots: [protectedRoot],
    getSession: async id => ({ id, directory: f.directory }), authorizeOperation: async () => {}, withSessionLock: async (_id, action) => action() });
  const fingerprint = 'a'.repeat(64), metadata = { devryan: { v: 1, origin: 'user', planMode: false,
    parts: [{ kind: 'text', length: 4 }], admission: { v: 1, fingerprint } } };
  await owner.withAcceptedOperation({ sessionID: 'ses_root', messageID: 'msg_u', fingerprint, metadata, request: { text: 'safe' } }, async () => {
    const permit = JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
    const seal = file => owner.handleRpc('native.admission.sealPrompt', { permit, input: { sessionID: 'ses_root', messageID: 'msg_u',
      prompt: { text: 'safe', files: [{ uri: pathToFileURL(file).href }] } } });
    for (const file of ['.git/config', 'git-link', 'private/state']) {
      await expect(seal(path.join(f.directory, file))).rejects.toMatchObject({ code: 'native_prompt_attachment_denied' });
    }
    expect(await seal(path.join(f.directory, 'safe.txt'))).toEqual(metadata);
  });
  await expect(f.rpc('authorize', { operation: 'primary.step', sessionID: 'ses_root' })).rejects.toMatchObject({ code: 'native_primary_step_capability_required' });
});

test('reviewed command derivation binds one exact native prompt and never authorizes forged or expired scopes', async () => {
  const f = await fixture(); let allowed = true;
  const definition = { template: 'Reviewed $ARGUMENTS', agent: 'build', model: { providerID: 'fixture', model: 'm1' } };
  const configuration = { commands: { reviewed: definition }, agents: { build: { mode: 'primary' } } };
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'command-fixture',
    reviewedConfiguration: configuration, getSession: async id => ({ id, directory: f.directory,agent:'build',model:{providerID:'fixture',id:'m1'} }),
    withSessionLock: async (_id, action) => action(), authorizeOperation: async () => { throw new Error('unowned operation'); },
    captureWebAuthorization: async () => async () => { if (!allowed) throw Object.assign(new Error('grant_revoked'), { code: 'grant_revoked' }); } });
  configuration.commands.reviewed.template = 'caller mutation'; // Constructor owns its immutable copy.
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  let expired, expiredMarker;
  await owner.withWebOperation({ operation: 'sessions.command', method: 'POST', path: '/api/session/ses_root/command', body: { name: 'reviewed', text: 'original' } }, async () => {
    const permit = JSON.parse(owner.requestHeaders()['x-devryan-native-permit']); expired = permit;
    const originalDefinition = { ...definition, template: 'Reviewed $ARGUMENTS' };
    const command = { permit, sessionID: 'ses_root', name: 'reviewed', definition: originalDefinition,
      invocation: { sessionID: 'ses_root', prompt: { text: 'original' }, delivery: 'steer' }, model: { providerID: 'fixture', id: 'm1' } };
    await expect(rpc('beginCommand', { ...command, sessionID: 'ses_other' })).rejects.toMatchObject({ code: 'native_command_derivation_required' });
    await expect(rpc('beginCommand', { ...command, definition: { ...originalDefinition, template: 'forged' } })).rejects.toMatchObject({ code: 'native_command_definition_unreviewed' });
    await expect(rpc('beginCommand', { ...command, model: { providerID: 'other', id: 'm1' } })).rejects.toMatchObject({ code: 'native_command_selection_unreviewed' });
    const derivation = await rpc('beginCommand', command); expiredMarker = derivation;
    const request = { operation: 'session.prompt', sessionID: 'ses_root', existingPermit: permit, derivation,
      input: { sessionID: 'ses_root', id: 'msg_command', text: 'Reviewed original', delivery: 'steer' } };
    await expect(rpc('authorize', { ...request, derivation: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'native_command_derivation_required' });
    await expect(rpc('authorize', { ...request, input: { ...request.input, files: [{ uri: 'file:///outside' }] } })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
    expect(await rpc('authorize', request)).toEqual(permit);
    await expect(rpc('authorize', { ...request, input: { ...request.input, text: 'changed' } })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
    await expect(rpc('authorize', { ...request, input: { ...request.input, id: 'msg_other' } })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
    const metadata = await rpc('sealPrompt', { permit, input: { sessionID: 'ses_root', messageID: 'msg_command', prompt: { text: 'Reviewed original' }, delivery: 'steer' } });
    await rpc('verifyAccepted', { permit, accepted: { id: 'msg_command', sessionID: 'ses_root', type: 'user', payload: { text: 'Reviewed original', metadata } } });
    await expect(rpc('verifyAccepted', { permit, accepted: { id: 'msg_other', sessionID: 'ses_root', type: 'user', payload: { text: 'Reviewed original', metadata } } })).rejects.toMatchObject({ code: 'native_permit_lineage_mismatch' });
    allowed = false;
    await expect(rpc('recheck', { permit, request })).rejects.toMatchObject({ code: 'grant_revoked' });
  });
  await expect(rpc('authorize', { operation: 'session.prompt', sessionID: 'ses_root', existingPermit: expired, derivation: expiredMarker })).rejects.toMatchObject({ code: 'native_permit_invalid' });
});

test('manual compaction authorizes only its exact native control input and a following nonforce wake', async () => {
  const f = await fixture();
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'compact-fixture',
    getSession: async id => ({ id, directory: f.directory }), withSessionLock: async (_id, action) => action(),
    authorizeOperation: async () => { throw new Error('unowned operation'); }, captureWebAuthorization: async () => async () => {} });
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  await owner.withWebOperation({ operation: 'sessions.compact', method: 'POST', path: '/api/session/ses_root/compact', body: { delivery: 'queue' } }, async () => {
    const permit = JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
    const request = { operation: 'inbox.compaction', sessionID: 'ses_root', existingPermit: permit, input: { sessionID: 'ses_root', id: 'msg_compact', delivery: 'queue' } };
    await expect(rpc('authorize', { ...request, operation: 'execution.wake', input: undefined })).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
    await expect(rpc('authorize', { ...request, input: { ...request.input, delivery: 'steer' } })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
    await rpc('authorize', request);
    await expect(rpc('authorize', { ...request, input: { ...request.input, id: 'msg_other' } })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
    await rpc('authorize', { operation: 'execution.wake', sessionID: 'ses_root', existingPermit: permit });
    await expect(rpc('authorize', { operation: 'session.prompt', sessionID: 'ses_root', existingPermit: permit })).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
  });
});

test('command preselection is constructor-only, checks fresh grants, and cannot admit a command or prompt', async () => {
  const f = await fixture(); let allowed = true;
  const owner = createNativeAdmissionOwner({ runtime: f.runtime, directory: f.directory, ownerID: 'selection-fixture',
    getSession: async id => ({ id, directory: f.directory }), withSessionLock: async (_id, action) => action(),
    authorizeOperation: async () => { throw new Error('unowned operation'); },
    captureWebAuthorization: async () => async () => { if (!allowed) throw Object.assign(new Error('grant_revoked'), { code: 'grant_revoked' }); } });
  const rpc = (method, input) => owner.handleRpc(`native.admission.${method}`, input);
  let expired;
  await owner.withCommandSelection({ sessionID: 'ses_root' }, async () => {
    expired = JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
    await expect(rpc('authorize', { operation: 'session.switchAgent', sessionID: 'ses_root', existingPermit: expired, input: { sessionID: 'ses_root', agent: 'build' } })).rejects.toMatchObject({ code: 'native_web_authorization_required' });
    await owner.withWebOperation({ operation: 'switchAgent', method: 'POST', path: '/api/session/ses_root/agent', body: { agent: 'build' } }, async () => {
      const request = { operation: 'session.switchAgent', sessionID: 'ses_root', existingPermit: expired, input: { sessionID: 'ses_root', agent: 'build' } };
      expect(await rpc('authorize', request)).toEqual(expired);
      await expect(rpc('authorize', { ...request, input: { ...request.input, agent: 'other' } })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
      allowed = false;
      await expect(rpc('recheck', { permit: expired, request })).rejects.toMatchObject({ code: 'grant_revoked' });
      allowed = true;
    });
    for (const path of ['/prompt', '/command', '/compact']) await expect(owner.withWebOperation({ operation: 'forged', method: 'POST', path: `/api/session/ses_root${path}`, body: { name: 'reviewed', text: 'forged' } }, async () => {})).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
    await expect(owner.withWebOperation({ operation: 'switchAgent', method: 'POST', path: '/api/session/ses_other/agent', body: { agent: 'build' } }, async () => {})).rejects.toMatchObject({ code: 'native_permit_lineage_mismatch' });
  });
  await expect(rpc('authorize', { operation: 'session.switchAgent', sessionID: 'ses_root', existingPermit: expired })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  await expect(rpc('withCommandSelection', { sessionID: 'ses_root' })).rejects.toMatchObject({ code: 'native_admission_rpc_unavailable' });
  await f.owner.handleRpc('native.admission.hold', { sessionID: 'ses_root' });
  await expect(owner.withCommandSelection({ sessionID: 'ses_root' }, async () => {})).rejects.toMatchObject({ code: 'native_session_held' });
});


test('native removal seals the exact rooted tree and inventory while fencing Revert generation changes',async()=>{
  const f=await fixture(),ownerID='removal-owner';
  await f.runtime.registerPrompt({directory:f.directory,sessionID:'ses_root',userMessageID:'msg_boundary'});
  const intent=await f.runtime.beginNativeRemoval({directory:f.directory,rootSessionID:'ses_root',ownerID});
  const members=[{id:'ses_root',parentID:null,directory:f.directory},{id:'ses_child',parentID:'ses_root',directory:f.directory}];
  await expect(f.runtime.commitNativeRemoval({directory:f.directory,intentID:intent.id,ownerID,members:[...members,{id:'ses_other',parentID:null,directory:f.directory}]}))
    .rejects.toMatchObject({code:'native_removal_tree_invalid'});
  await f.runtime.prepareNativeRemovalMembers({directory:f.directory,intentID:intent.id,ownerID,members});
  await expect(f.runtime.prepareRevert({directory:f.directory,sessionID:'ses_root',messageID:'msg_boundary'})).rejects.toMatchObject({code:'native_removal_in_progress'});
  const committed=await f.runtime.commitNativeRemoval({directory:f.directory,intentID:intent.id,ownerID,members});
  expect(committed.state).toBe('committed');
  const input={directory:f.directory,intentID:intent.id,ownerID,sessionID:'ses_child',inboxIDs:['msg_inbox'],pendingIDs:['msg_pending']};
  await expect(f.runtime.acknowledgeNativeRemoval(input)).rejects.toMatchObject({code:'native_removal_disposition_missing'});
  await f.runtime.stageNativeRemovalMember(input);
  await expect(f.runtime.acknowledgeNativeRemoval({...input,pendingIDs:[]})).rejects.toMatchObject({code:'native_removal_disposition_changed'});
  await f.runtime.acknowledgeNativeRemoval(input);
  expect((await f.reopen().nativeRemoval({directory:f.directory,intentID:intent.id})).removed).toEqual(['ses_child']);
  await expect(f.runtime.completeNativeRemoval({directory:f.directory,intentID:intent.id,ownerID})).rejects.toMatchObject({code:'native_removal_incomplete'});
});

test('queued primary callback belongs to the exact committed item and original caller, and runs once', async () => {
  const f=await fixture();let calls=0,current=null;
  const caller=new (await import('node:async_hooks')).AsyncLocalStorage();
  const owner=createNativeAdmissionOwner({runtime:f.runtime,directory:f.directory,ownerID:'queue-callback',authorizeOperation:async()=>{},
    getSession:async id=>({id,directory:f.directory,agent:'orchestrator',model:{providerID:'fixture',id:'exact'}}),readQueuedPrimaryRecord:async()=>current,
    withSessionLock:async(_id,action)=>action(),captureWebAuthorization:async()=>async()=>{}});
  const metadata={devryan:{origin:'human',agent:'orchestrator',providerID:'fixture',modelID:'exact',variant:'default',admission:{fingerprint:'a'.repeat(64)}}};
  const item={type:'user',delivery:'queue',payload:{text:'Exact',metadata,files:[{data:'WA==',mime:'text/plain',source:{type:'inline'},name:'x'}]}};
  const input={sessionID:'ses_root',directory:f.directory,messageID:'msg_queued',item};
  const rpc=(method,arg)=>owner.handleRpc(`native.admission.${method}`,arg);
  await caller.run('original',()=>owner.withAcceptedOperation({sessionID:input.sessionID,messageID:input.messageID,fingerprint:'a'.repeat(64),metadata,request:{text:'Exact'}},async()=>{
    const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
    owner.updateAcceptedOperation({metadata,request:{id:input.messageID,text:'Exact',delivery:'queue'}});
    await owner.stageQueuedPromptAdmission(input,async()=>{expect(caller.getStore()).toBe('original');calls++;current={executionGeneration:2,directory:f.directory,anchorID:input.messageID,state:'observing',agent:'orchestrator',providerID:'fixture',modelID:'exact',variant:'default'};});
    expect(calls).toBe(0);expect(current).toBeNull();
    await rpc('verifyAccepted',{permit,accepted:{phase:'preflight',item:{sessionID:input.sessionID,id:input.messageID,item}}});
    await expect(rpc('queuedAdmissionCommitted',{...input,item:{...item,payload:{...item.payload,files:[]}}})).rejects.toMatchObject({code:'native_queued_admission_unverified'});
    await caller.run('reverse-rpc',()=>Promise.all([rpc('queuedAdmissionCommitted',input),rpc('queuedAdmissionCommitted',input)]));
    await rpc('queuedDeliveryAuthorized',input);expect(calls).toBe(1);
  }));
  await owner.assertQueuedPromptReconciled(input);
  current={...current,anchorID:'msg_newObjective'};
  await expect(owner.assertQueuedPromptReconciled(input)).rejects.toMatchObject({code:'native_queued_input_retained'});
  expect(calls).toBe(1);
});

test('rejected or revoked queued callbacks retain input without granting delivery or claiming retry success',async()=>{
  for(const failure of ['before-write','revoked-after-write']){
    const f=await fixture();let allowed=true,calls=0,current={anchorID:'msg_old',state:'observing'};
    const owner=createNativeAdmissionOwner({runtime:f.runtime,directory:f.directory,ownerID:`queue-${failure}`,authorizeOperation:async()=>{},
      getSession:async id=>({id,directory:f.directory}),readQueuedPrimaryRecord:async()=>current,
      withSessionLock:async(_id,action)=>action(),captureWebAuthorization:async()=>async()=>{if(!allowed)throw Object.assign(Error('Revoked'),{code:'grant_revoked'});}});
    const metadata={devryan:{origin:'human',admission:{fingerprint:'b'.repeat(64)}}};
    const item={type:'user',delivery:'queue',payload:{text:'Retained',metadata}};
    const input={sessionID:'ses_root',directory:f.directory,messageID:'msg_retained',item};
    const rpc=(method,arg)=>owner.handleRpc(`native.admission.${method}`,arg);
    await owner.withAcceptedOperation({sessionID:input.sessionID,messageID:input.messageID,fingerprint:'b'.repeat(64),metadata,request:{text:'Retained'}},async()=>{
      const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
      owner.updateAcceptedOperation({metadata,request:{text:'Retained',delivery:'queue'}});
      await owner.stageQueuedPromptAdmission(input,async()=>{calls++;if(failure==='before-write')throw Object.assign(Error('Refused'),{code:'callback_refused'});current={anchorID:input.messageID,state:'needs_attention'};allowed=false;});
      await rpc('verifyAccepted',{permit,accepted:{phase:'preflight',item:{sessionID:input.sessionID,id:input.messageID,item}}});
      await expect(rpc('queuedAdmissionCommitted',input)).rejects.toMatchObject({code:failure==='before-write'?'callback_refused':'grant_revoked'});
      await expect(rpc('queuedDeliveryAuthorized',input)).rejects.toThrow();expect(calls).toBe(1);
      if(failure==='before-write')expect(current.anchorID).toBe('msg_old');
    });
    await expect(owner.assertQueuedPromptReconciled(input)).rejects.toMatchObject({code:'native_queued_input_retained'});
  }
});

test('transaction rollback rejection is exact live-permit evidence of nonacceptance',async()=>{
 const f=await fixture(),metadata={devryan:{origin:'human',admission:{fingerprint:'c'.repeat(64)}}};
 await f.owner.withAcceptedOperation({sessionID:'ses_root',messageID:'msg_rejected',fingerprint:'c'.repeat(64),metadata,request:{text:'Queue'}},async()=>{
  f.owner.updateAcceptedOperation({metadata,request:{text:'Queue',delivery:'queue'}});
  await f.owner.stageQueuedPromptAdmission({sessionID:'ses_root',messageID:'msg_rejected'},async()=>{throw Error('Must not run');});
  const permit=JSON.parse(f.owner.requestHeaders()['x-devryan-native-permit']);
  expect(f.owner.queuedPromptWasRejected()).toBe(false);
  await expect(f.rpc('queuedAdmissionRejected',{permit,messageID:'msg_other'})).rejects.toMatchObject({code:'native_queued_admission_unverified'});
  await f.rpc('queuedAdmissionRejected',{permit,messageID:'msg_rejected'});
  expect(f.owner.queuedPromptWasRejected()).toBe(true);
 });
 expect(f.owner.queuedPromptWasRejected()).toBe(false);
});


test('queued inherited variants bind the actual native selection and current primary tuple',async()=>{
  const f=await fixture();let variant='xhigh';
  const current={executionGeneration:2,directory:f.directory,anchorID:'msg_inherited',state:'observing',agent:'orchestrator',providerID:'fixture',modelID:'exact',variant:'xhigh'};
  const owner=createNativeAdmissionOwner({runtime:f.runtime,directory:f.directory,ownerID:'queue-inherited',authorizeOperation:async()=>{},
    getSession:async id=>({id,directory:f.directory,agent:'orchestrator',model:{providerID:'fixture',id:'exact',variant}}),readQueuedPrimaryRecord:async()=>current});
  const input={sessionID:'ses_root',directory:f.directory,messageID:current.anchorID,item:{type:'user',delivery:'queue',payload:{text:'Inherited',metadata:{devryan:{origin:'human',agent:'orchestrator',providerID:'fixture',modelID:'exact'}}}}};
  await owner.assertQueuedPromptReconciled(input);
  const execution={agent:'orchestrator',providerID:'fixture',modelID:'exact',variant:'xhigh'};
  await owner.handleRpc('native.admission.queuedDeliveryAuthorized',{...input,execution});
  await expect(owner.handleRpc('native.admission.queuedDeliveryAuthorized',{...input,execution:{...execution,variant:'default'}})).rejects.toMatchObject({code:'native_queued_input_retained'});
  variant='default';
  await expect(owner.assertQueuedPromptReconciled(input)).rejects.toMatchObject({code:'native_queued_input_retained'});
});
