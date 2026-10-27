import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { comparePairedReports, pairedSuccessVerdict, runPairedEvaluation } from './paired.mjs';

// Temporary fixtures live under os.tmpdir(), which may be repository-local; remove them afterwards.
const tempRoots = [];
const trackTemp = directory => { tempRoots.push(directory); return directory; };
after(() => { for (const directory of tempRoots) rmSync(directory, { recursive: true, force: true }); });

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
  test('keeps plugin content hashes in the matched configuration for waste-reduction factors', () => {
    const value = input(); value.pairs[0].candidate.runs[0].harness.finishFingerprint.plugins.observed[0].contentHash = 'f'.repeat(64);
    const result = comparePairedReports(value);
    assert.equal(result.verdict, 'inconclusive'); assert.ok(result.reasons.includes('configuration_mismatch'));
    assert.equal('margin' in result, false);
  });
  test('reports unavailable models without converting the trial into success', () => {
    const value = input(); value.pairs[0].baseline.runs[0].errorCode = 'evaluation_model_unavailable';
    value.pairs[0].baseline.runs[0].status = 'failed';
    assert.equal(comparePairedReports(value).verdict, 'unavailable');
  });
});

const runtimeReport = (runtimeVersion, { amount = 100, pluginHash = 'e', status = 'passed' } = {}) => {
  const value = report(false, amount), run = value.runs[0];
  run.status = status;
  run.harness.finishFingerprint.runtimeVersion = runtimeVersion;
  run.harness.finishFingerprint.plugins.observed = [{ name: 'owner', contentHash: pluginHash.repeat(64) }];
  return value;
};
const pluginMigrations = [{ name: 'owner', baselineHash: 'e'.repeat(64), candidateHash: 'f'.repeat(64) }];
const runtimeInput = ({ candidateAmount = 105, margin } = {}) => ({ factor: 'runtime', targetMetric: 'input', requiredPairs: 3,
  runtimePluginMigrations: structuredClone(pluginMigrations),
  ...(margin === undefined ? {} : { nonInferiorityMargin: margin }),
  pairs: Array.from({ length: 3 }, (_, index) => ({
    index: index + 1, order: index % 2 ? 'candidate-then-baseline' : 'baseline-then-candidate',
    baseline: runtimeReport('1.18.33'), candidate: runtimeReport('2.0.20', { amount: candidateAmount, pluginHash: 'f' }),
  })) });

describe('runtime non-inferiority comparison', () => {
  test('matches exact declared plugin migration hashes and accepts a candidate within the margin', () => {
    const result = comparePairedReports(runtimeInput());
    assert.equal(result.verdict, 'non-inferior');
    assert.deepEqual(result.reasons, []);
    assert.equal(result.margin, 0.1);
    assert.equal(result.baselineTotal, 300); assert.equal(result.candidateTotal, 315); assert.equal(result.ratio, 1.05);
    assert.ok(result.cases.every((entry) => entry.matched && entry.baselineFactor === '1.18.33' && entry.candidateFactor === '2.0.20'));
    assert.equal(pairedSuccessVerdict('runtime'), 'non-inferior');
    assert.equal(pairedSuccessVerdict('readOverlap'), 'canary-eligible');
    assert.deepEqual(result.runtimePluginMigrations, pluginMigrations);
  });
  test('undeclared, stale, reversed or partially declared plugin changes cannot qualify a runtime', () => {
    for (const change of ['undeclared', 'baseline-hash', 'candidate-hash', 'reversed', 'missing-plugin', 'partial', 'stale-both']) {
      const value = runtimeInput();
      if (change === 'undeclared') delete value.runtimePluginMigrations;
      if (change === 'baseline-hash') value.runtimePluginMigrations[0].baselineHash = '1'.repeat(64);
      if (change === 'candidate-hash') value.runtimePluginMigrations[0].candidateHash = '1'.repeat(64);
      if (change === 'reversed') [value.runtimePluginMigrations[0].baselineHash, value.runtimePluginMigrations[0].candidateHash]
        = [value.runtimePluginMigrations[0].candidateHash, value.runtimePluginMigrations[0].baselineHash];
      if (change === 'missing-plugin') value.runtimePluginMigrations.push({ ...pluginMigrations[0], name: 'missing' });
      if (change === 'partial') {
        value.pairs[0].baseline.runs[0].harness.finishFingerprint.plugins.observed.push({ name: 'custom', contentHash: '1'.repeat(64) });
        value.pairs[0].candidate.runs[0].harness.finishFingerprint.plugins.observed.push({ name: 'custom', contentHash: '2'.repeat(64) });
      }
      if (change === 'stale-both') for (const pair of value.pairs) for (const side of ['baseline', 'candidate']) {
        pair[side].runs[0].harness.finishFingerprint.plugins.observed[0].contentHash = '3'.repeat(64);
      }
      const result = comparePairedReports(value);
      assert.equal(result.verdict, 'inconclusive', change);
      assert.ok(result.reasons.includes('configuration_mismatch'), change);
    }
    const unchanged = runtimeInput();
    delete unchanged.runtimePluginMigrations;
    for (const pair of unchanged.pairs) pair.candidate.runs[0].harness.finishFingerprint.plugins.observed[0].contentHash = 'e'.repeat(64);
    assert.equal(comparePairedReports(unchanged).verdict, 'non-inferior');
    assert.throws(() => comparePairedReports({ ...input(), runtimePluginMigrations: pluginMigrations }), /only valid with factor runtime/);
  });
  test('reports a candidate total beyond the margin as inferior without a waste-reduction reason', () => {
    const result = comparePairedReports(runtimeInput({ candidateAmount: 111 }));
    assert.equal(result.verdict, 'inferior');
    assert.deepEqual(result.reasons, ['candidate_metric_worse']);
    assert.equal(result.candidateTotal, 333);
    const tightened = comparePairedReports(runtimeInput({ margin: 0 }));
    assert.equal(tightened.verdict, 'inferior'); assert.equal(tightened.margin, 0);
    assert.equal(comparePairedReports(runtimeInput({ candidateAmount: 111, margin: 0.2 })).verdict, 'non-inferior');
  });
  test('reports a candidate failure where the baseline passed as inferior', () => {
    const value = runtimeInput(); value.pairs[1].candidate.runs[0].status = 'failed';
    const result = comparePairedReports(value);
    assert.equal(result.verdict, 'inferior');
    assert.ok(result.reasons.includes('outcome_disagreement'));
    assert.equal(result.expansionRequired, true); assert.equal(result.nextRequiredPairs, 10);
    const reversed = runtimeInput(); reversed.pairs[1].baseline.runs[0].status = 'failed';
    assert.equal(comparePairedReports(reversed).verdict, 'inconclusive');
  });
  test('a confounded pair never records a regression as inferior', () => {
    // Worse metric and a failed candidate, but the role differs: the comparison is not clean.
    const value = runtimeInput({ candidateAmount: 150 });
    value.pairs[0].candidate.runs[0].harness.finishFingerprint.role.contentHash = '9'.repeat(64);
    value.pairs[1].candidate.runs[0].status = 'failed';
    const result = comparePairedReports(value);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(result.reasons.includes('configuration_mismatch'));
    assert.ok(result.reasons.includes('candidate_metric_worse'));
    assert.ok(result.reasons.includes('outcome_disagreement'));
  });
  test('still requires matching role, catalog, selection and policies', () => {
    for (const change of ['role', 'catalog', 'selection', 'policy', 'plugin-name', 'same-runtime']) {
      const value = runtimeInput(), fingerprint = value.pairs[0].candidate.runs[0].harness.finishFingerprint;
      if (change === 'role') fingerprint.role.contentHash = '9'.repeat(64);
      if (change === 'catalog') fingerprint.catalog.contentHash = '9'.repeat(64);
      if (change === 'selection') fingerprint.selection.variant = 'high';
      if (change === 'policy') fingerprint.policies.waitAny = true;
      if (change === 'plugin-name') fingerprint.plugins.observed[0].name = 'renamed';
      if (change === 'same-runtime') fingerprint.runtimeVersion = '1.18.33';
      const result = comparePairedReports(value);
      assert.equal(result.verdict, 'inconclusive', change);
      assert.ok(result.reasons.includes(change === 'same-runtime' ? 'experimental_factor_unchanged' : 'configuration_mismatch'), change);
    }
  });
  test('treats an unknown runtime version on either side as an unavailable fingerprint', () => {
    for (const side of ['baseline', 'candidate']) {
      const value = runtimeInput(); value.pairs[0][side].runs[0].harness.finishFingerprint.runtimeVersion = 'unknown';
      const result = comparePairedReports(value);
      assert.equal(result.verdict, 'inconclusive', side);
      assert.ok(result.reasons.includes('fingerprint_unavailable'), side);
      assert.equal(result.cases[0].matched, false, side);
    }
  });
  test('keeps model unavailability and missing measurements out of a non-inferior verdict', () => {
    const unavailable = runtimeInput(); unavailable.pairs[0].candidate.runs[0].errorCode = 'evaluation_model_unavailable';
    assert.equal(comparePairedReports(unavailable).verdict, 'unavailable');
    const missing = runtimeInput(); missing.pairs[0].candidate.runs[0].harness.evidence = null;
    const result = comparePairedReports(missing);
    assert.equal(result.verdict, 'inconclusive'); assert.ok(result.reasons.includes('measurement_unavailable'));
    assert.equal(result.baselineTotal, 200);
  });
  test('rejects an out-of-range margin in the comparator', () => {
    for (const margin of [-0.1, 1.5, Number.NaN, '0.1']) {
      assert.throws(() => comparePairedReports(runtimeInput({ margin })), /margin/, String(margin));
    }
  });
});

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const makeFixture = (root, name) => {
  const fixtureRoot = path.join(root, name);
  mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
  git(fixtureRoot, ['init', '--quiet']);
  git(fixtureRoot, ['config', 'user.email', 'eval@example.test']);
  git(fixtureRoot, ['config', 'user.name', 'DevRyan Eval']);
  writeFileSync(path.join(fixtureRoot, 'src', 'existing.ts'), 'export const existing = true;\n');
  git(fixtureRoot, ['add', 'src/existing.ts']);
  git(fixtureRoot, ['commit', '--quiet', '-m', 'fixture']);
  return fixtureRoot;
};

describe('paired runtime evaluation execution status', () => {
  const runWith = async (candidateAmount) => {
    const root = trackTemp(mkdtempSync(path.join(os.tmpdir(), 'devryan-agent-eval-paired-')));
    const common = { providerId: 'openai', modelId: 'gpt-6-astra', agent: 'orchestrator', variant: 'medium',
      caseIds: ['inspect'], timeoutMs: 120_000, repetitions: 1, reportDirectory: path.join(root, 'reports') };
    const baseline = { ...common, fixtureRoot: makeFixture(root, 'baseline'), devRyanBaseUrl: 'http://127.0.0.1:4310' };
    const candidate = { ...common, fixtureRoot: makeFixture(root, 'candidate'), devRyanBaseUrl: 'http://127.0.0.1:4311',
      pairing: { pairs: 3, factor: 'runtime', targetMetric: 'input', nonInferiorityMargin: 0.1, runtimePluginMigrations: pluginMigrations, baseline } };
    let counter = 0;
    const runSingle = async (config) => {
      counter++;
      const value = config.devRyanBaseUrl === baseline.devRyanBaseUrl
        ? runtimeReport('1.18.33') : runtimeReport('2.0.20', { amount: candidateAmount, pluginHash: 'f' });
      return { report: { ...value, runId: `trial-${counter}`, aggregates: { status: 'passed' },
        cleanup: { restored: true, manifestMatch: true, sessionComplete: true, sessionDiscoveryComplete: true } } };
    };
    const { report: result, reportPath } = await runPairedEvaluation(candidate, { runSingle, createRunId: () => `eval-paired-${candidateAmount}` });
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).comparison.verdict, result.comparison.verdict);
    return result;
  };
  test('passes only on a non-inferior runtime verdict', async () => {
    const accepted = await runWith(105);
    assert.equal(accepted.comparison.verdict, 'non-inferior');
    assert.equal(accepted.execution.status, 'passed'); assert.equal(accepted.aggregates.status, 'passed');
    const rejected = await runWith(150);
    assert.equal(rejected.comparison.verdict, 'inferior');
    assert.equal(rejected.execution.status, 'failed'); assert.equal(rejected.aggregates.status, 'failed');
  });
});
