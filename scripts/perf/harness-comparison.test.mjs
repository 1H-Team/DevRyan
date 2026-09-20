import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHarnessComparison, compareMetrics, projectAgentMetrics } from './harness-comparison.mjs';

const fixture = () => ({ schemaVersion: 1, fixtureHash: 'a'.repeat(64), protocolHash: 'b'.repeat(64), runtime: 'c'.repeat(64),
  cases: [{ id: 'ledger', passed: true, metrics: { latencyMs: 10, cpuMs: 5 }, operations: { serializations: 2 } }] });

test('local comparisons preserve unknown native metrics and cannot promote policies', () => {
  const result = buildHarnessComparison({ baseline: fixture(), candidate: fixture() });
  assert.equal(result.passed, true);
  assert.equal(result.nativePromotionEligible, false);
  assert.deepEqual(result.agent.metrics.inputTokens, { baseline: null, candidate: null, delta: null, availability: 'unavailable' });
  assert.equal(compareMetrics({ cpuMs: 10 }, { cpuMs: 5 }).cpuMs.delta, -5);
});

test('failed cases, mismatched protocols, missing cases and empty comparisons fail', () => {
  for (const candidate of [{ ...fixture(), protocolHash: 'changed' }, { ...fixture(), cases: [] },
    { ...fixture(), cases: [{ ...fixture().cases[0], passed: false }] },
    { ...fixture(), cases: [{ ...fixture().cases[0], id: 'different' }] }]) {
    assert.equal(buildHarnessComparison({ baseline: fixture(), candidate }).passed, false);
  }
  assert.equal(buildHarnessComparison({ baseline: { ...fixture(), cases: [] }, candidate: { ...fixture(), cases: [] } }).passed, false);
});

test('partial agent evidence is not converted to zero cost or complete success', () => {
  const result = projectAgentMetrics({ runs: [{ status: 'passed', harness: { evidence: { incomplete: true } } }],
    execution: { plannedRuns: 2, completedRuns: 1 } });
  assert.equal(result.successRate, null);
  assert.equal(result.inputTokens, null);
  assert.equal(result.retries, null);
  assert.throws(() => buildHarnessComparison({ baseline: fixture(), candidate: fixture(), agentPairs: [] }), /pairing_invalid/);
});
