import { expect, test, vi } from 'vitest';
import { createNativeAdmissionOwner } from './native-admission-owner.js';
import { createOpenCodeClient } from '../opencode-client/index.js';
import { createWebManagedOpenCodeExecutor } from '../../orchestration/open-code-executor.js';

test('detached managed abort uses its live task lease and only grants interruption of its canonical child', async () => {
  const directory = '/fixture', sessionID = 'ses_child';
  let live = true, owner, duringRequest = async () => {};
  const task = { owner: 'devryan', taskId: 'dvr_task_one', leaseToken: 'lease_one', directory,
    status: 'running', rootSessionId: 'ses_root', childSessionId: sessionID, dispatchCallId: 'call_parent' };
  const captureWebAuthorization = vi.fn(async () => { throw Object.assign(Error('native_web_principal_required'), { statusCode: 403 }); });
  const verifyManagedTaskDispatch = vi.fn(async input => {
    if (!live || input.taskId !== task.taskId || input.leaseToken !== task.leaseToken) {
      throw Object.assign(Error('stale lease'), { code: 'native_managed_task_lease_invalid' });
    }
    return { ...task };
  });
  owner = createNativeAdmissionOwner({ directory, ownerID: 'fixture', captureWebAuthorization, verifyManagedTaskDispatch,
    getSession: async id => ({ id, directory, ...(id === sessionID ? { parentID: 'ses_root' } : {}) }),
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ revision: 0, held: false }),
      capturedSessionState: async () => ({ captured: true, pending: false, generation: 1 }),
      leaseForCall: async () => ({ directory, generation: 1, executionKind: 'control', preparation: 'none', state: 'published',
        scope: { sessionID: 'ses_root', callID: 'call_parent' } }) },
    authorizeOperation: async () => { throw Error('Unowned operation'); },
  });
  const fetchImpl = vi.fn(async (url, init) => {
    expect(new URL(url).pathname).toBe(`/api/session/${sessionID}/interrupt`);
    await duringRequest();
    await owner.handleRpc('native.admission.authorize', { operation: 'session.interrupt', sessionID, input: {},
      existingPermit: JSON.parse(init.headers['x-devryan-native-permit']) });
    return Response.json({ data: { interrupted: true } });
  });
  const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: 'http://fixture.invalid', epoch: 1 }),
    getAuthHeaders: () => owner.requestHeaders(), withNativeWebOperation: (spec, action) => owner.withWebOperation(spec, action), fetchImpl });
  const executor = createWebManagedOpenCodeExecutor({ openCodeClient: client,
    nativeTaskDispatch: (scope, action) => owner.withManagedTaskDispatch(scope, action) });
  const scope = { operation: 'abort', taskId: task.taskId, leaseToken: task.leaseToken, directory, sessionID };
  try {
    await expect(executor.abort(task)).resolves.toEqual({ aborted: true });
    expect(verifyManagedTaskDispatch).toHaveBeenCalledWith(scope);
    expect(captureWebAuthorization).not.toHaveBeenCalled();
    await expect(owner.withManagedTaskDispatch({ ...scope, sessionID: 'ses_other' }, async () => {}))
      .rejects.toMatchObject({ code: 'native_managed_task_scope_invalid' });
    await expect(owner.withManagedTaskDispatch({ ...scope, leaseToken: 'old_lease' }, async () => {}))
      .rejects.toMatchObject({ code: 'native_managed_task_lease_invalid' });
    await expect(owner.withManagedTaskDispatch(scope, () => owner.withWebOperation({ operation: 'sessions.abort', method: 'POST',
      path: `/api/session/${sessionID}/interrupt?resume=true`, directory }, () => owner.handleRpc('native.admission.authorize', {
      operation: 'session.interrupt.resume', sessionID, input: { resume: true }, existingPermit: JSON.parse(owner.requestHeaders()['x-devryan-native-permit']),
    })))).rejects.toMatchObject({ code: 'native_managed_task_scope_invalid' });
    await expect(owner.withManagedTaskDispatch(scope, () => owner.handleRpc('native.admission.authorize', {
      operation: 'session.remove', sessionID, existingPermit: JSON.parse(owner.requestHeaders()['x-devryan-native-permit']),
    }))).rejects.toMatchObject({ code: 'native_owned_lifecycle_required' });
    duringRequest = async () => { live = false; };
    await expect(executor.abort(task)).rejects.toMatchObject({ code: 'native_managed_task_lease_invalid' });
  } finally { await executor.shutdown(); owner.dispose(); }
});
