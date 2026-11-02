import assert from 'node:assert/strict';
import test from 'node:test';
import { assertQaDisplaySummary } from './session-changes.mjs';

test('session-change QA accepts cached history without treating it as fresh restore authority', () => {
  const summary = { projectionState: 'ready', files: [{ path: 'owned.txt' }],
    restoreEligibility: { state: 'candidate', action: 'undo' }, restoreAvailable: false };
  assert.equal(assertQaDisplaySummary(summary), summary);
  for (const extra of [
    { projectionState: 'refreshing' }, { restoreProof: { version: 1, digest: 'a'.repeat(64) } },
    { current: { state: 'verified' } }, { files: [{ path: 'owned.txt', verification: { state: 'verified' } }] },
  ]) assert.throws(() => assertQaDisplaySummary({ ...summary, ...extra }), assert.AssertionError);
});
