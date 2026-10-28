import { describe, expect, test } from 'bun:test';

import { planSettlementWait } from './planSettlement';

describe('planSettlementWait', () => {
  const unsettled = (reason?: string) => Object.assign(new Error('plan_source_unsettled'), { code: 'plan_source_unsettled', ...(reason === undefined ? {} : { reason }) });
  test('waits out transient reasons and refusals that name none', () => {
    for (const reason of ['barrier_pending', 'tasks_active', 'sessions_busy', 'leases_active', 'primary_busy']) {
      expect(planSettlementWait(unsettled(reason))).toEqual({ reason });
    }
    expect(planSettlementWait(unsettled())).toEqual({ reason: null });
    // An older client error carries only the message.
    expect(planSettlementWait(new Error('plan_source_unsettled'))).toEqual({ reason: null });
  });
  test('treats terminal reasons and other failures as failures', () => {
    for (const reason of ['source_changed', 'superseded', 'cancelled', 'needs_attention', 'pin_changed', 'invalid_state']) {
      expect(planSettlementWait(unsettled(reason))).toBeNull();
    }
    expect(planSettlementWait(new Error('disk full'))).toBeNull();
    expect(planSettlementWait('plan_source_unsettled')).toBeNull();
    expect(planSettlementWait(null)).toBeNull();
  });
});
