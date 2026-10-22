import { expect, test } from 'bun:test';

import { resolveHarnessPolicies } from './harness-policies.js';

test('waitAny and compactResults are on by default with 0 kill switches; other policies stay opt-in', () => {
  expect(resolveHarnessPolicies({})).toEqual({ readOverlap: false, waitAny: true, compactResults: true, contextProjection: false, duplicateOutputs: false });
  expect(resolveHarnessPolicies({ DEVRYAN_MANAGED_WAIT_ANY: '0', DEVRYAN_COMPACT_MANAGED_RESULTS: '0' })).toMatchObject({ waitAny: false, compactResults: false });
  expect(resolveHarnessPolicies({ DEVRYAN_MANAGED_READ_OVERLAP: '1', DEVRYAN_TASK_CONTEXT_PROJECTION: '1', DEVRYAN_DUPLICATE_OUTPUTS: '1' }))
    .toMatchObject({ readOverlap: true, contextProjection: true, duplicateOutputs: true });
});
