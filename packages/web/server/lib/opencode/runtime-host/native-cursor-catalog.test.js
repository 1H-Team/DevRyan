import { expect, it, vi } from 'vitest';
import { createNativeAdmissionOwner } from './native-admission-owner.js';
import { createNativeCursorOwner } from './native-cursor-owner.js';

const scope = { rootSessionId: 'ses_root', directory: '/fixture', agent: 'explorer', providerId: 'cursor-acp', modelId: 'haiku', variant: 'medium', taskId: 'dvr_task_one', autoResumeGeneration: 2 };
function fixture() {
  let revision = 0, held = false, allowed = true;
  const verifyManagedTaskCatalog = vi.fn(async input => {
    if (!allowed || input.autoResumeGeneration !== 2) throw Error('recovery revoked');
    return { owner: 'devryan', taskId: scope.taskId, rootSessionId: scope.rootSessionId, directory: scope.directory };
  });
  const captureManagedCatalogAuthorization = vi.fn(async () => async () => { if (!allowed) throw Error('owner revoked'); });
  const owner = createNativeAdmissionOwner({ directory: '/fixture', ownerID: 'fixture',
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ revision, held, reverting: false }) },
    getSession: async id => ({ id, directory: '/fixture' }), authorizeOperation: async () => { throw Error('generic operation forbidden'); },
    captureManagedCatalogAuthorization, verifyManagedTaskCatalog });
  return { owner, verifyManagedTaskCatalog, captureManagedCatalogAuthorization, hold: () => { held = true; }, revise: () => { revision++; }, revoke: () => { allowed = false; } };
}

it('requires private invocation or exact detached recovery identity for managed Cursor catalogs', async () => {
  const f = fixture();
  try {
    await expect(f.owner.captureManagedCursorCatalogAuthorization({ ...scope, taskId: undefined })).rejects.toMatchObject({ code: 'native_cursor_catalog_owner_required' });
    await expect(f.owner.captureManagedCursorCatalogAuthorization({ ...scope, autoResumeGeneration: 3 })).rejects.toThrow('recovery revoked');
    expect(await f.owner.captureManagedCursorCatalogAuthorization({ kind: 'catalog', directory: '/fixture' })).toBeNull();
    const recheck = await f.owner.captureManagedCursorCatalogAuthorization(scope);
    await recheck();
    expect(f.verifyManagedTaskCatalog).toHaveBeenLastCalledWith(scope);
    expect(f.captureManagedCatalogAuthorization).toHaveBeenLastCalledWith({ id: 'ses_root', directory: '/fixture' });
    f.revoke(); await expect(recheck()).rejects.toThrow('recovery revoked');
  } finally { f.owner.dispose(); }
});

it.each(['hold', 'revise'])('revokes detached catalog grants after canonical %s', async mutation => {
  const f = fixture();
  try { const recheck = await f.owner.captureManagedCursorCatalogAuthorization(scope); f[mutation]();
    await expect(recheck()).rejects.toMatchObject({ code: 'native_cursor_catalog_scope_revoked' });
  } finally { f.owner.dispose(); }
});

it('revokes catalog authorization when the native controller changes', async () => {
  const f = fixture();
  const recheck = await f.owner.captureManagedCursorCatalogAuthorization(scope);
  await f.owner.invalidateController();
  await expect(recheck()).rejects.toMatchObject({ code: 'native_permit_revoked' });
  f.owner.dispose();
});

it('exposes captured read-only authority without accepting policy in the prompt scope', async () => {
  const prompt = { directory: '/fixture', sessionID: 'ses_cursor', userMessageID: 'msg_user', assistantMessageID: 'msg_assistant', agent: 'explorer', modelID: 'haiku' };
  const owner = createNativeCursorOwner({ instanceID: 'fixture', isReady: () => true, runtime: {}, controller: () => ({ instanceID: 'fixture', call: async () => {} }),
    admissionOwner: { captureCursorAuthorization: async () => ({ readOnly: true, revision: 0, recheck: async () => {} }) }, abortAndWait: async () => {} });
  await expect(owner.ownedPrompt({ ...prompt, readOnly: false })).rejects.toMatchObject({ code: 'native_cursor_scope_invalid' });
  const grant = await owner.ownedPrompt(prompt);
  expect(grant.readOnly).toBe(true);
  await grant.close(); await owner.close();
});

it('captures managed read-only policy from the verified lease and revokes changes', async () => {
  const dispatch = { operation: 'prompt', taskId: 'dvr_task_one', leaseToken: 'lease_one', directory: '/fixture', sessionID: 'ses_cursor', providerId: 'cursor-acp', modelId: 'haiku', agent: 'explorer', variant: 'medium' };
  const task = { ...dispatch, owner: 'devryan', status: 'running', rootSessionId: 'ses_root', childSessionId: 'ses_cursor', dispatchCallId: 'call_task', readOnly: true };
  const owner = createNativeAdmissionOwner({ directory: '/fixture', ownerID: 'fixture',
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ revision: 0, held: false, reverting: false }),
      capturedSessionState: async () => ({ captured: true, pending: false, generation: 1 }),
      leaseForCall: async () => ({ executionKind: 'control', preparation: 'none', state: 'published', generation: 1, directory: '/fixture', scope: { sessionID: 'ses_root', callID: 'call_task' } }) },
    getSession: async id => ({ id, directory: '/fixture', ...(id === 'ses_cursor' ? { parentID: 'ses_root', agent: 'explorer', model: { providerID: 'cursor-acp', id: 'haiku', variant: 'medium' } } : {}) }),
    verifyManagedTaskDispatch: async () => ({ ...task }), authorizeOperation: async () => { throw Error('public authority forbidden'); } });
  const metadata = { devryan: { providerID: 'cursor-acp', modelID: 'haiku', agent: 'explorer' } };
  let captured;
  try {
    await owner.withManagedTaskDispatch(dispatch, () => owner.withAcceptedOperation({ sessionID: 'ses_cursor', messageID: 'msg_user', fingerprint: 'a'.repeat(64), metadata, request: { id: 'msg_user', text: 'Inspect', metadata } }, async () => {
      captured = await owner.captureCursorAuthorization({ directory: '/fixture', sessionID: 'ses_cursor', userMessageID: 'msg_user', assistantMessageID: 'msg_assistant', agent: 'explorer', modelID: 'haiku', variant: 'medium' });
    }));
    expect(captured.readOnly).toBe(true); await captured.recheck();
    task.readOnly = false;
    await expect(captured.recheck()).rejects.toMatchObject({ code: 'native_cursor_scope_revoked' });
  } finally { owner.dispose(); }
});

it('binds initial catalog discovery to the exact native task call and its active permit', async () => {
  let allowed = true;
  const owner = createNativeAdmissionOwner({ directory: '/fixture', ownerID: 'fixture',
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ revision: 0, held: false }) },
    getSession: async id => ({ id, directory: '/fixture' }), authorizeOperation: async () => { if (!allowed) throw Error('call revoked'); } });
  const authorization = { operation: 'tool.execute', sessionID: 'ses_root', messageID: 'msg_assistant', input: { toolID: 'devryan_task', callID: 'call_task', input: { action: 'start', agent: 'explorer', prompt: 'Inspect' } } };
  const permit = await owner.handleRpc('native.admission.authorize', authorization);
  const invocation = { directory: '/fixture', sessionID: 'ses_root', messageID: 'msg_assistant', callID: 'call_task', tool: 'devryan_task', input: authorization.input.input, authorization, permit };
  const initial = { ...scope, taskId: undefined, autoResumeGeneration: undefined };
  let recheck;
  try {
    await owner.withManagedTaskCatalogInvocation(invocation, async () => {
      recheck = await owner.captureManagedCursorCatalogAuthorization(initial); await recheck();
      await expect(owner.captureManagedCursorCatalogAuthorization({ ...initial, rootSessionId: 'ses_other' })).rejects.toMatchObject({ code: 'native_cursor_catalog_scope_invalid' });
    });
    await expect(owner.captureManagedCursorCatalogAuthorization(initial)).rejects.toMatchObject({ code: 'native_cursor_catalog_owner_required' });
    allowed = false; await expect(recheck()).rejects.toThrow('call revoked'); allowed = true;
    await owner.handleRpc('native.admission.release', permit);
    await expect(recheck()).rejects.toMatchObject({ code: 'native_permit_invalid' });
  } finally { owner.dispose(); }
});

it('allows manual recovery catalog only under the original browser grant, never as detached fallback', async () => {
  let principal = true, active = true;
  const captureWebAuthorization = vi.fn(async () => {
    if (!principal) throw Object.assign(Error('browser required'), { code: 'native_web_principal_required' });
    return async () => { if (!active) throw Object.assign(Error('browser revoked'), { code: 'native_web_principal_denied' }); };
  });
  const verifyManagedTaskCatalog = vi.fn(async () => { throw Object.assign(Error('generation revoked'), { code: 'native_managed_task_catalog_invalid' }); });
  const owner = createNativeAdmissionOwner({ directory: '/fixture', ownerID: 'fixture',
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ revision: 0, held: false }) },
    getSession: async id => ({ id, directory: '/fixture' }), authorizeOperation: async () => { throw Error('generic authority forbidden'); },
    captureWebAuthorization, captureManagedCatalogAuthorization: async () => async () => {}, verifyManagedTaskCatalog });
  const manual = { ...scope, autoResumeGeneration: undefined };
  try {
    const recheck = await owner.captureManagedCursorCatalogAuthorization(manual); await recheck();
    expect(captureWebAuthorization).toHaveBeenLastCalledWith({ operation: 'cursor.readonly', sessionID: 'ses_root', directory: '/fixture' }, { id: 'ses_root', directory: '/fixture' });
    active = false; await expect(recheck()).rejects.toMatchObject({ code: 'native_web_principal_denied' }); active = true;
    principal = false;
    await expect(owner.captureManagedCursorCatalogAuthorization(manual)).rejects.toMatchObject({ code: 'native_web_principal_required' });
    principal = true; captureWebAuthorization.mockClear();
    await expect(owner.captureManagedCursorCatalogAuthorization(scope)).rejects.toMatchObject({ code: 'native_managed_task_catalog_invalid' });
    await expect(owner.captureManagedCursorCatalogAuthorization({ ...scope, autoResumeGeneration: null })).rejects.toMatchObject({ code: 'native_cursor_catalog_owner_required' });
    expect(captureWebAuthorization).not.toHaveBeenCalled();
  } finally { owner.dispose(); }
});
