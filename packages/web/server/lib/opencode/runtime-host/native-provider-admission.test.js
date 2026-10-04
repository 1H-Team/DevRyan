import { expect, test } from 'vitest';
import { createNativeAdmissionOwner } from './native-admission-owner.js';

test.each(['withProviderAttempt', 'withProviderResolution'])('%s requires the original live session permit before and after async work', async method => {
  let state = { revision: 0, held: false }, allowed = true;
  const directory = '/fixture/provider';
  const owner = createNativeAdmissionOwner({ directory, ownerID: 'fixture',
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => state },
    getSession: async id => ({ id, directory }), withSessionLock: (_id, action) => action(),
    authorizeOperation: async () => { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'revoked' }); },
  });
  const permit = await owner.handleRpc('native.admission.authorize', { operation: 'runner.drain', sessionID: 'ses_provider' });
  const input = { directory, sessionID: 'ses_provider', ...(method === 'withProviderAttempt' ? { kind: 'primary' } : {}), permit };
  const run = (input, action) => owner[method](input, action);
  await expect(run(input, async () => 'fresh')).resolves.toBe('fresh');
  if (method === 'withProviderResolution') {
    for (const extra of [{ kind: 'generate' }, { controllerInstanceID: 'unverified' }])
      await expect(run({ ...input, ...extra }, async () => 'secret')).rejects.toMatchObject({ code: 'native_provider_resolution_invalid' });
    let retained;
    await run(input, async recheck => { retained = recheck; await recheck(); });
    await expect(retained()).rejects.toMatchObject({ code: 'native_provider_resolution_expired' });
    await expect(run(input, async recheck => { allowed = false; await recheck(); })).rejects.toMatchObject({ code: 'revoked' });
    allowed = true;
    const tool = await owner.handleRpc('native.admission.authorize', { operation: 'tool.execute', sessionID: input.sessionID,
      messageID: 'msg_tool', input: { toolID: 'read', callID: 'call_read', input: {} } });
    await expect(run({ ...input, permit: tool }, async () => 'secret')).rejects.toMatchObject({ code: 'native_provider_resolution_scope_invalid' });
    await owner.handleRpc('native.admission.release', tool);
  }
  await expect(run({ ...input, sessionID: 'ses_other' }, async () => 'secret')).rejects.toMatchObject({ code: method === 'withProviderAttempt' ? 'native_provider_attempt_scope_invalid' : 'native_provider_resolution_scope_invalid' });
  await expect(run({ ...input, permit: { ...permit, token: 'copied' } }, async () => 'secret')).rejects.toMatchObject({ code: 'native_permit_invalid' });
  await expect(run(input, async () => { state = { revision: 1, held: true }; return 'secret'; })).rejects.toMatchObject({ code: 'native_permit_revoked' });
  state = { revision: 0, held: false };
  await expect(run(input, async () => { allowed = false; return 'secret'; })).rejects.toMatchObject({ code: 'revoked' });
  allowed = true;
  await owner.handleRpc('native.admission.release', permit);
  await expect(run(input, async () => 'secret')).rejects.toMatchObject({ code: 'native_permit_invalid' });
  const next = await owner.handleRpc('native.admission.authorize', { operation: 'runner.drain', sessionID: input.sessionID });
  await expect(run({ ...input, permit: next }, async () => { await owner.invalidateController(); return 'secret'; }))
    .rejects.toMatchObject({ code: 'native_permit_revoked' });
  owner.dispose();
});
