import { expect, test } from 'bun:test';

import { resolveHarnessPolicies, resolveNativeHarnessPolicies } from './harness-policies.js';

test('waitAny and compactResults are on by default with 0 kill switches; other policies stay opt-in', () => {
  expect(resolveHarnessPolicies({})).toEqual({ readOverlap: false, waitAny: true, compactResults: true, contextProjection: false, duplicateOutputs: false, adaptiveDelegation: false });
  expect(resolveHarnessPolicies({ DEVRYAN_MANAGED_WAIT_ANY: '0', DEVRYAN_COMPACT_MANAGED_RESULTS: '0' })).toMatchObject({ waitAny: false, compactResults: false });
  expect(resolveHarnessPolicies({ DEVRYAN_MANAGED_READ_OVERLAP: '1', DEVRYAN_TASK_CONTEXT_PROJECTION: '1', DEVRYAN_DUPLICATE_OUTPUTS: '1', DEVRYAN_ADAPTIVE_DELEGATION: '1' }))
    .toMatchObject({ readOverlap: true, contextProjection: true, duplicateOutputs: true, adaptiveDelegation: true });
});

test('native scoped overlap is advertised from admission capability, independently of legacy rollout flags', () => {
  expect(resolveHarnessPolicies({ DEVRYAN_MANAGED_READ_OVERLAP: '0' }).readOverlap).toBe(false);
  expect(resolveNativeHarnessPolicies({ DEVRYAN_MANAGED_READ_OVERLAP: '0' }).readOverlap).toBe(true);
  expect(resolveNativeHarnessPolicies({ DEVRYAN_MANAGED_READ_OVERLAP: '1' }).readOverlap).toBe(true);
});
