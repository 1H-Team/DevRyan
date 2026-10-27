import { expect, it } from 'vitest';
import { createNativeAdmissionOwner } from './native-admission-owner.js';

const origin = { kind: 'plugin', id: 'devryan.managed-task', manifestDigest: 'a'.repeat(64), capabilities: ['managed-task'] };
function fixture() {
  let held = false, revision = 0, locks = 0;
  const owner = createNativeAdmissionOwner({ directory: '/fixture', ownerID: 'fixture',
    getSession: async id => ({ id, directory: '/fixture' }), authorizeOperation: async () => {},
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ held, revision }),
      holdNativeAdmission: async () => { held = true; revision++; } },
    withSessionLock: async (_id, action) => { locks++; return action(); },
  });
  const invocation = async (action, provenance = origin) => {
    const authorization = { operation: 'tool.execute', sessionID: 'ses_root', messageID: 'msg_assistant',
      input: { toolID: 'devryan_task', callID: 'call_read', provenance, input: { action, task_id: 'dvr_task_one' } } };
    const permit = await owner.handleRpc('native.admission.authorize', authorization);
    return { sessionID: 'ses_root', directory: '/fixture', messageID: 'msg_assistant', callID: 'call_read',
      tool: 'devryan_task', authorization, permit };
  };
  return { owner, invocation, locks: () => locks };
}

it('an owned result read leaves the parent lock available and rejects data after a Stop hold', async () => {
  const f = fixture(), started = Promise.withResolvers(), release = Promise.withResolvers();
  try {
    const input = await f.invocation('wait');
    const read = f.owner.withManagedResultRead(input, async () => { started.resolve(); await release.promise; return 'stale result'; });
    const rejected = expect(read).rejects.toMatchObject({ code: 'native_permit_revoked' });
    await started.promise;
    expect(f.locks()).toBe(0);
    await f.owner.handleRpc('native.admission.hold', { sessionID: 'ses_root' });
    expect(f.locks()).toBe(1);
    release.resolve(); await rejected;
  } finally { release.resolve(); f.owner.dispose(); }
});

it.each(['start', 'continue', 'cancel', 'remember_decision'])('%s cannot enter the read-only result scope', async action => {
  const f = fixture();
  try { await expect(f.owner.withManagedResultRead(await f.invocation(action), async () => 'forbidden'))
    .rejects.toMatchObject({ code: 'native_managed_result_read_required' }); }
  finally { f.owner.dispose(); }
});

it('a callback cannot replace the current permit with another tool origin', async () => {
  const f = fixture();
  try {
    const input = await f.invocation('status', { ...origin, id: 'another.plugin' });
    await expect(f.owner.withManagedResultRead(input, async () => 'forbidden')).rejects.toMatchObject({ code: 'native_managed_result_read_required' });
  } finally { f.owner.dispose(); }
});
