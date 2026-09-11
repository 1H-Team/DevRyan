import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { comparePairedReports } from './paired.mjs';

const report = (enabled, amount = enabled ? 80 : 100) => ({ executionMode: 'live', fixtureHash: 'a'.repeat(64), environmentHash: 'b'.repeat(64),
  selection: { providerId: 'openai', modelId: 'gpt-6-astra', variant: 'medium', agent: 'orchestrator' },
  cleanup: { restored: true }, runs: [{ caseId: 'inspect', status: 'passed', harness: {
    finishFingerprint: { runtimeVersion: '1.18.30', selection: { modelId: 'gpt-6-astra', variant: 'medium' },
      role: { contentHash: 'c'.repeat(64) }, catalog: { contentHash: 'd'.repeat(64) },
      plugins: { observed: [{ name: 'owner', contentHash: 'e'.repeat(64) }] }, policies: { readOverlap: enabled, waitAny: false } },
    evidence: { incomplete: false, roots: [{ usage: { input: { observed: 1, unknown: 0, total: amount } } }] },
  } }] });
const input = () => ({ factor: 'readOverlap', targetMetric: 'input', requiredPairs: 3, pairs: Array.from({ length: 3 }, (_, index) => ({
  index: index + 1, order: index % 2 ? 'candidate-then-baseline' : 'baseline-then-candidate', baseline: report(false), candidate: report(true),
})) });

describe('matched alternating canary comparison', () => {
  test('requires measured waste reduction across matched task, environment, model and nonexperimental policy hashes', () => {
    const result = comparePairedReports(input());
    assert.equal(result.verdict, 'canary-eligible');
    assert.equal(result.cases.length, 3); assert.ok(result.cases.every((entry) => entry.matched && entry.delta === -20));
  });
  test('does not infer improvement from absent usage, unmatched configuration, or unchanged factors', () => {
    for (const change of ['missing', 'model', 'policy', 'unchanged', 'worse']) {
      const value = input(), changed = value.pairs[0].candidate.runs[0];
      if (change === 'missing') changed.harness.evidence = null;
      if (change === 'model') changed.harness.finishFingerprint.selection.variant = 'high';
      if (change === 'policy') changed.harness.finishFingerprint.policies.waitAny = true;
      if (change === 'unchanged') changed.harness.finishFingerprint.policies.readOverlap = false;
      if (change === 'worse') for (const pair of value.pairs) pair.candidate.runs[0].harness.evidence.roots[0].usage.input.total = 120;
      assert.equal(comparePairedReports(value).verdict, 'inconclusive', change);
    }
  });
  test('keeps outcome disagreements and requires ten pairs before promotion', () => {
    const value = input(); value.pairs[1].candidate.runs[0].status = 'failed';
    const result = comparePairedReports(value);
    assert.equal(result.verdict, 'inconclusive'); assert.equal(result.expansionRequired, true); assert.equal(result.nextRequiredPairs, 10);
    assert.equal(result.cases[1].candidateStatus, 'failed');
  });
  test('reports unavailable models without converting the trial into success', () => {
    const value = input(); value.pairs[0].baseline.runs[0].errorCode = 'evaluation_model_unavailable';
    value.pairs[0].baseline.runs[0].status = 'failed';
    assert.equal(comparePairedReports(value).verdict, 'unavailable');
  });
});
