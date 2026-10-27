import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareReducerReports as compareAll, median, medianAbsoluteDeviation, parseReducerComparisonArgs } from './reducer-comparison.mjs';

const report = (p95Ms, overrides = {}) => ({ schemaVersion: 1, revision: 'r', reducerSha256: 's', runtime: '1.3.0',
  scenarios: [{ sessionCount: 1, historySize: 50, kind: 'delta', p95Ms }], ...overrides });
const reports = (values, overrides) => values.map(value => report(value, overrides));
const compareReducerReports = (baseline, candidate) => compareAll(baseline, candidate, { requiredPairs: 2 });

test('median and median absolute deviation', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(medianAbsoluteDeviation([1, 2, 3, 4, 100]), 1);
});

test('a candidate inside max(5% of B, 3 x MAD) passes and one above it regresses', () => {
  const baseline = reports([1, 1, 1, 1, 1]);
  assert.equal(compareReducerReports(baseline, reports([1.04, 1.04, 1.04, 1.04, 1.04], { revision: 'c' })).verdict, 'passed');
  const regressed = compareReducerReports(baseline, reports([1.06, 1.06, 1.06, 1.06, 1.06], { revision: 'c' }));
  assert.equal(regressed.verdict, 'regressed');
  assert.ok(Math.abs(regressed.scenarios[0].allowanceMs - 0.05) < 1e-12);
});

test('noise widens the allowance up to the ceiling, then the run is unqualified', () => {
  // MAD 0.03 -> allowance 0.09 (9% of B): a 7% slower candidate still passes.
  assert.equal(compareReducerReports(reports([0.97, 1, 1.03, 0.97, 1.03]), reports([1.07, 1.07, 1.07, 1.07, 1.07])).verdict, 'passed');
  // MAD 0.06 -> allowance 0.18 (above 15% of B): too noisy to qualify either way.
  const noisy = compareReducerReports(reports([0.94, 1, 1.06, 0.94, 1.06]), reports([1, 1, 1, 1, 1]));
  assert.equal(noisy.verdict, 'unqualified');
  assert.equal(noisy.scenarios[0].verdict, 'too-noisy');
});

test('comparisons require paired, consistent reports on one runtime and one scenario set', () => {
  const baseline = reports([1, 1]);
  assert.throws(() => compareReducerReports(baseline, reports([1])), /runs_required/);
  assert.throws(() => compareReducerReports(baseline, reports([1, 1, 1])), /unpaired/);
  assert.throws(() => compareReducerReports(baseline, reports([1, 1], { runtime: '1.2.0' })), /runtime_mismatch/);
  assert.throws(() => compareReducerReports([report(1), report(1, { revision: 'x' })], reports([1, 1])), /revision_changed/);
  assert.throws(() => compareReducerReports(baseline, reports([1, 1], { scenarios: [{ sessionCount: 4, historySize: 50, kind: 'delta', p95Ms: 1 }] })), /scenarios_mismatch/);
  assert.throws(() => compareReducerReports(baseline, reports([NaN, 1])), /timing_invalid/);
});

test('fewer than ten pairs never qualify, even when every scenario passes', () => {
  const smoke = compareAll(reports([1, 1]), reports([1, 1]));
  assert.equal(smoke.scenarios[0].verdict, 'passed');
  assert.deepEqual([smoke.verdict, smoke.requiredPairs], ['unqualified', 10]);
  assert.equal(compareAll(reports(Array(10).fill(1)), reports(Array(10).fill(1))).verdict, 'passed');
});

test('the CLI requires a distinct baseline checkout that contains the benchmark', () => {
  assert.throws(() => parseReducerComparisonArgs([]), /Usage/);
  assert.throws(() => parseReducerComparisonArgs(['--baseline', '/nonexistent-devryan-baseline']), /No reducer benchmark/);
  assert.throws(() => parseReducerComparisonArgs(['--baseline', '.', '--pairs', '1']), /Unexpected option/);
});
