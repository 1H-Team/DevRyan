import { expect, it } from 'vitest';
import { createNativePlanSettlementVerifier } from './native-plan-settlement.js';
const fixture = (overrides = {}) => {
  const input = { sessionID: 'ses_plan', directory: '/fixture', sourceIdentity: { rootUserMessageID: 'msg_user', currentSourceMessageID: 'msg_plan' }, providerID: 'fixture' };
  const deps = { readControllerPin: () => ({ instanceID: 'controller', configurationDigest: 'a'.repeat(64) }),
    readPrimaryRecord: async () => ({ sessionID: 'ses_plan', directory: '/fixture', anchorID: 'msg_user', stepID: 'msg_plan', cancellationGeneration: 0, state: 'completed' }),
    readStatus: async () => ({}), readManagedState: async () => ({ tasks: [], envelopes: [] }), readManagedBarrier: async () => ({ state: 'clear' }), activeLeases: async () => [], ...overrides };
  return { input, verify: createNativePlanSettlementVerifier(deps) };
};
it('requires native status, physical leases and managed barriers to settle after a completion stamp', async () => {
  for (const overrides of [ { readStatus: async () => ({ ses_plan: { type: 'busy' } }) }, { activeLeases: async () => [{}] },
    { readManagedState: async () => ({ tasks: [{ childSessionId: 'ses_child', status: 'running' }], envelopes: [] }) },
    { readManagedBarrier: async () => ({ state: 'awaiting_acknowledgement' }) }, { readStatus: async () => null } ]) {
    const f = fixture(overrides); await expect(f.verify(f.input)).rejects.toMatchObject({ code: 'plan_source_unsettled' });
  }
  const f = fixture(); await expect(f.verify(f.input)).resolves.toBeUndefined();
});
it('checks child busy state and cannot cross a controller/configuration or objective change', async () => {
  for (const overrides of [ { readStatus: async () => ({ ses_child: { type: 'retry' } }), readManagedState: async () => ({ tasks: [{ childSessionId: 'ses_child', status: 'completed' }], envelopes: [] }) },
    { readPrimaryRecord: async () => ({ sessionID: 'ses_plan', directory: '/fixture', anchorID: 'msg_later', stepID: 'msg_plan', cancellationGeneration: 0 }) } ]) {
    const f = fixture(overrides); await expect(f.verify(f.input)).rejects.toMatchObject({ code: 'plan_source_unsettled' });
  }
  let calls = 0;
  const f = fixture({ readControllerPin: () => ({ instanceID: calls++ ? 'replacement' : 'original', configurationDigest: 'a'.repeat(64) }) });
  await expect(f.verify(f.input)).rejects.toMatchObject({ code: 'plan_source_unsettled' });
});
it('Cursor has no native Step witness and still requires its own physical settlement', async () => {
  const f = fixture({ readPrimaryRecord: async () => ({ sessionID: 'ses_plan', directory: '/fixture', anchorID: 'msg_user', cancellationGeneration: 0, state: 'completed' }) });
  await expect(f.verify({ ...f.input, providerID: 'cursor-acp' })).resolves.toBeUndefined();
  await expect(f.verify(f.input)).rejects.toMatchObject({ code: 'plan_source_unsettled' });
});
it('an unfinished native retry stub keeps Implement disabled despite an earlier successful completion stamp',async()=>{
 const f=fixture({readStatus:async()=>({ses_plan:{type:'retry'}})});
 await expect(f.verify(f.input)).rejects.toMatchObject({code:'plan_source_unsettled'});
});
it('names why a source is unsettled: transient reasons are waited out, terminal ones are final', async () => {
  const primary = (fields) => async () => ({ sessionID: 'ses_plan', directory: '/fixture', anchorID: 'msg_user', stepID: 'msg_plan', cancellationGeneration: 0, state: 'completed', ...fields });
  const cases = [
    [{ readManagedBarrier: async () => ({ state: 'awaiting_acknowledgement' }) }, 'barrier_pending'],
    [{ readManagedState: async () => ({ tasks: [{ childSessionId: 'ses_child', status: 'running' }], envelopes: [] }) }, 'tasks_active'],
    [{ readStatus: async () => ({ ses_plan: { type: 'busy' } }) }, 'sessions_busy'],
    [{ activeLeases: async () => [{}] }, 'leases_active'],
    [{ readPrimaryRecord: primary({ state: 'recovering' }) }, 'primary_busy'],
    [{ readPrimaryRecord: primary({ recoveryID: 'recovery_1' }) }, 'primary_busy'],
    [{ readPrimaryRecord: primary({ anchorID: 'msg_later' }) }, 'source_changed'],
    [{ readPrimaryRecord: primary({ stepID: 'msg_later' }) }, 'source_changed'],
    [{ readPrimaryRecord: primary({ state: 'superseded' }) }, 'superseded'],
    [{ readPrimaryRecord: primary({ state: 'cancelled' }) }, 'cancelled'],
    [{ readPrimaryRecord: primary({ state: 'needs_attention' }) }, 'needs_attention'],
    [{ readStatus: async () => null }, 'invalid_state'],
    [{ readPrimaryRecord: primary({ directory: '/elsewhere' }) }, 'invalid_state'],
  ];
  for (const [overrides, reason] of cases) {
    const f = fixture(overrides);
    await expect(f.verify(f.input)).rejects.toMatchObject({ code: 'plan_source_unsettled', statusCode: 409, reason });
  }
  let calls = 0;
  const pinned = fixture({ readControllerPin: () => ({ instanceID: calls++ ? 'replacement' : 'original', configurationDigest: 'a'.repeat(64) }) });
  await expect(pinned.verify(pinned.input)).rejects.toMatchObject({ reason: 'pin_changed' });
});
