import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { FACTOR_CAPABILITY_SCHEMA_DELTAS, comparePairedReports, pairedSuccessVerdict, runPairedEvaluation } from './paired.mjs';

// Temporary fixtures live under os.tmpdir(), which may be repository-local; remove them afterwards.
const tempRoots = [];
const trackTemp = directory => { tempRoots.push(directory); return directory; };
after(() => { for (const directory of tempRoots) rmSync(directory, { recursive: true, force: true }); });

// One arm of the same candidate artifact. The fixture carries complete
// derivation evidence: template and renderer hashes, the host-attested render,
// runtime bytes, configured plugins, switches at start and finish, and a
// trace naming the evaluated root with complete helper attribution.
const switches = (overrides = {}) => ({ DEVRYAN_LEDGER_PACK: 'unset', DEVRYAN_VIEW_CLONE: 'unset', DEVRYAN_PREPARED_BASELINE_REUSE: 'unset', ...overrides });
const fingerprint = (enabled) => ({ runtimeVersion: '1.18.30', runtimeHash: '7'.repeat(64), selection: { modelId: 'gpt-6-astra', variant: 'medium' },
  role: { contentHash: 'c'.repeat(64), templateHash: '1'.repeat(64), rendererHash: '2'.repeat(64), attestedContentHash: 'c'.repeat(64) },
  catalog: { contentHash: 'd'.repeat(64), idsHash: '3'.repeat(64), tools: [{ id: 'devryan_task', contentHash: '4'.repeat(64) }, { id: 'read', contentHash: '5'.repeat(64) }] },
  plugins: { configured: [{ name: 'owner.mjs', sourceHash: '6'.repeat(64) }], observed: [{ name: 'owner', contentHash: 'e'.repeat(64) }] },
  policies: { readOverlap: enabled, waitAny: false }, policySource: 'runtime-projection', switches: switches() });
const report = (enabled, amount = enabled ? 80 : 100, { duration = enabled ? 900 : 1000, output = enabled ? 40 : 50 } = {}) => ({ executionMode: 'live', fixtureHash: 'a'.repeat(64), environmentHash: 'b'.repeat(64),
  selection: { providerId: 'openai', modelId: 'gpt-6-astra', variant: 'medium', agent: 'orchestrator' },
  cleanup: { restored: true }, runs: [{ caseId: 'inspect', status: 'passed', harness: {
    startFingerprint: fingerprint(enabled), finishFingerprint: fingerprint(enabled),
    evidence: { incomplete: false, rootSessionId: 'ses_root', attribution: { unattributedHelperUsage: 0 }, roots: [{ rootSessionId: 'ses_root',
      objectiveDurationMs: duration, attribution: { unattributedHelperCalls: 0 },
      usage: { input: { observed: 1, unknown: 0, total: amount }, output: { observed: 1, unknown: 0, total: output } } }] },
  } }] });
const input = () => ({ factor: 'readOverlap', targetMetric: 'input', requiredPairs: 3, pairs: Array.from({ length: 3 }, (_, index) => ({
  index: index + 1, order: index % 2 ? 'candidate-then-baseline' : 'baseline-then-candidate', baseline: report(false), candidate: report(true),
})) });
const eachRun = (value, side, change) => { for (const pair of value.pairs) change(pair[side].runs[0].harness); return value; };

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
  test('holds a pair whose run was held for an unattested delegation arm, without counting a disagreement', () => {
    for (const side of ['baseline', 'candidate']) {
      const value = input(); value.pairs[1][side].runs[0].status = 'held';
      value.pairs[1][side].runs[0].errorCode = 'evaluation_arm_unattested';
      const result = comparePairedReports(value);
      assert.equal(result.verdict, 'inconclusive', side);
      assert.equal(result.balanced.status, 'held', side);
      assert.ok(result.reasons.includes('arm_unattested'), side);
      assert.equal(result.reasons.includes('outcome_disagreement'), false, side);
      assert.equal(result.reasons.includes('outcome_failed'), false, side);
      assert.equal(result.expansionRequired, false, side);
    }
  });
  test('reports unavailable models without converting the trial into success', () => {
    const value = input(); value.pairs[0].baseline.runs[0].errorCode = 'evaluation_model_unavailable';
    value.pairs[0].baseline.runs[0].status = 'failed';
    assert.equal(comparePairedReports(value).verdict, 'unavailable');
  });
});

describe('Balanced gate for harness policy factors', () => {
  test('passes only when both arms are correct, duration is lower and input and output tokens are no higher', () => {
    const result = comparePairedReports(input());
    assert.equal(result.verdict, 'canary-eligible');
    assert.deepEqual(result.balanced, { name: 'balanced', required: true, status: 'passed', reasons: [],
      outcomes: { cases: 3, baselinePassed: 3, candidatePassed: 3, disagreements: 0 },
      metrics: {
        objectiveDurationMs: { rule: 'candidate < baseline', baselineTotal: 3000, candidateTotal: 2700, delta: -300, ratio: 0.9, passed: true },
        input: { rule: 'candidate <= baseline', baselineTotal: 300, candidateTotal: 240, delta: -60, ratio: 0.8, passed: true },
        output: { rule: 'candidate <= baseline', baselineTotal: 150, candidateTotal: 120, delta: -30, ratio: 0.8, passed: true },
      } });
    assert.deepEqual(result.cases[0].balanced, { objectiveDurationMs: { baseline: 1000, candidate: 900 }, input: { baseline: 100, candidate: 80 },
      output: { baseline: 50, candidate: 40 } });
    // Equal tokens pass; equal duration does not.
    const equalTokens = input();
    for (const pair of equalTokens.pairs) pair.candidate = report(true, 99, { output: 50 });
    assert.equal(comparePairedReports(equalTokens).balanced.status, 'passed');
    const output = comparePairedReports({ ...input(), targetMetric: 'output' });
    assert.equal(output.verdict, 'canary-eligible'); assert.equal(output.cases[0].delta, -10);
  });
  test('fails a clean comparison that misses any criterion, even when the target metric improved', () => {
    for (const [change, reason] of [[{ duration: 1000 }, 'duration_not_lower'], [{ output: 51 }, 'output_tokens_higher']]) {
      const value = input();
      for (const pair of value.pairs) pair.candidate = report(true, 80, change);
      const result = comparePairedReports(value);
      assert.equal(result.verdict, 'inconclusive', reason);
      assert.equal(result.balanced.status, 'failed', reason);
      assert.deepEqual(result.balanced.reasons, [reason]);
      assert.ok(result.reasons.includes(reason));
    }
    const higherInput = comparePairedReports({ ...input(), targetMetric: 'objectiveDurationMs',
      pairs: input().pairs.map(pair => ({ ...pair, candidate: report(true, 101) })) });
    assert.equal(higherInput.balanced.status, 'failed'); assert.deepEqual(higherInput.balanced.reasons, ['input_tokens_higher']);
    const failedBoth = input();
    for (const pair of failedBoth.pairs) { pair.baseline.runs[0].status = 'failed'; pair.candidate.runs[0].status = 'failed'; }
    assert.equal(comparePairedReports(failedBoth).balanced.status, 'failed');
    assert.deepEqual(comparePairedReports(failedBoth).balanced.reasons, ['outcome_failed']);
  });
  test('holds promotion on a missing measurement, prerequisite or cleanup proof and on a disagreement before ten pairs', () => {
    const missingOutput = eachRun(input(), 'candidate', harness => { delete harness.evidence.roots[0].usage.output; });
    for (const [value, reason] of [
      [missingOutput, 'measurement_unavailable'],
      [eachRun(input(), 'baseline', harness => { harness.evidence.roots[0].objectiveDurationMs = null; }), 'measurement_unavailable'],
      [(() => { const value = input(); value.pairs[0].candidate.runs[0].errorCode = 'evaluation_managed_unavailable'; return value; })(), 'prerequisite_unavailable'],
      [(() => { const value = input(); value.pairs[2].candidate.cleanup.restored = false; return value; })(), 'cleanup_incomplete'],
      [(() => { const value = input(); value.pairs.pop(); return value; })(), 'insufficient_pairs'],
    ]) {
      const result = comparePairedReports(value);
      assert.equal(result.verdict, 'inconclusive', reason);
      assert.equal(result.balanced.status, 'held', reason);
      assert.ok(result.balanced.reasons.includes(reason), reason);
    }
    assert.equal(comparePairedReports(missingOutput).balanced.metrics.output.baselineTotal, null);
    const disagreement = input(); disagreement.pairs[1].candidate.runs[0].status = 'failed';
    const held = comparePairedReports(disagreement);
    assert.equal(held.balanced.status, 'held'); assert.ok(held.balanced.reasons.includes('expansion_required'));
    assert.equal(held.expansionRequired, true); assert.equal(held.nextRequiredPairs, 10);
    // At ten pairs a remaining disagreement is a failed outcome, not a hold.
    const expanded = { ...input(), requiredPairs: 10, pairs: Array.from({ length: 10 }, (_, index) => ({ index: index + 1,
      order: index % 2 ? 'candidate-then-baseline' : 'baseline-then-candidate', baseline: report(false), candidate: report(true) })) };
    expanded.pairs[4].candidate.runs[0].status = 'failed';
    const final = comparePairedReports(expanded);
    assert.equal(final.expansionRequired, false);
    assert.equal(final.balanced.status, 'failed'); assert.deepEqual(final.balanced.reasons, ['outcome_failed']);
  });
  test('holds a pair whose usage cannot be attributed to the evaluated root instead of dropping it', () => {
    const changes = {
      'extra spending root': harness => harness.evidence.roots.push({ rootSessionId: 'ses_helper',
        usage: { input: { observed: 1, unknown: 0, total: 5 } } }),
      'unrecorded helper call': harness => { harness.evidence.roots[0].attribution.unattributedHelperCalls = 1; },
      'rootless helper usage': harness => { harness.evidence.attribution.unattributedHelperUsage = 2; },
      'attribution unavailable': harness => { harness.evidence.attribution = null; },
      'root not named': harness => { harness.evidence.rootSessionId = 'ses_other'; harness.evidence.roots.push({ rootSessionId: 'ses_root_2' }); },
    };
    for (const [name, change] of Object.entries(changes)) {
      const result = comparePairedReports(eachRun(input(), 'candidate', change));
      assert.equal(result.verdict, 'inconclusive', name);
      assert.ok(result.reasons.includes('usage_unattributable'), name);
      assert.equal(result.balanced.status, 'held', name);
    }
    // An observation-only root with no usage is not spending.
    const quiet = eachRun(input(), 'candidate', harness => harness.evidence.roots.push({ rootSessionId: 'runtime', usage: {} }));
    assert.equal(comparePairedReports(quiet).verdict, 'canary-eligible');
  });
  test('accepts a rendered role change only through per-arm attestation of one template and renderer', () => {
    // The factor changes the rendered prompt; each arm attests its own render.
    const rendered = eachRun(input(), 'candidate', harness => { for (const value of [harness.startFingerprint, harness.finishFingerprint]) {
      value.role.contentHash = '8'.repeat(64); value.role.attestedContentHash = '8'.repeat(64);
    } });
    assert.equal(comparePairedReports(rendered).verdict, 'canary-eligible');
    const cases = {
      'unattested render': [value => { value.role.contentHash = '8'.repeat(64); }, 'role_attestation_mismatch'],
      'template': [value => { value.role.templateHash = '9'.repeat(64); }, 'configuration_mismatch'],
      'renderer': [value => { value.role.rendererHash = '9'.repeat(64); }, 'configuration_mismatch'],
      'missing template': [value => { value.role.templateHash = null; }, 'fingerprint_unavailable'],
      'runtime bytes': [value => { value.runtimeHash = '9'.repeat(64); }, 'configuration_mismatch'],
      'missing runtime bytes': [value => { value.runtimeHash = null; }, 'fingerprint_unavailable'],
      'configured plugins': [value => { value.plugins.configured.push({ name: 'extra.mjs', sourceHash: '6'.repeat(64) }); }, 'configuration_mismatch'],
      'policy source': [value => { value.policySource = 'environment'; }, 'policy_source_unattested'],
      'switch value': [value => { value.switches.DEVRYAN_LEDGER_PACK = '0'; }, 'configuration_mismatch'],
      'catalog': [value => { value.catalog.contentHash = '9'.repeat(64); }, 'configuration_mismatch'],
    };
    for (const [name, [change, reason]] of Object.entries(cases)) {
      const value = eachRun(input(), 'candidate', harness => { change(harness.startFingerprint); change(harness.finishFingerprint); });
      const result = comparePairedReports(value);
      assert.equal(result.verdict, 'inconclusive', name);
      assert.ok(result.reasons.includes(reason), `${name}: ${result.reasons}`);
      assert.equal(result.balanced.status, 'held', name);
    }
    // Configured plugin source paths are host-local and are not compared.
    const relocated = eachRun(input(), 'candidate', harness => { harness.finishFingerprint.plugins.configured[0].sourceHash = '9'.repeat(64); });
    assert.equal(comparePairedReports(relocated).verdict, 'canary-eligible');
  });
  test('requires switches captured at start and finish of each run, unchanged and equal across arms', () => {
    for (const [name, change, reason] of [
      ['changed during run', harness => { harness.finishFingerprint.switches.DEVRYAN_VIEW_CLONE = '0'; }, 'switches_changed_during_run'],
      ['missing at start', harness => { harness.startFingerprint.switches = null; }, 'switches_unavailable'],
      ['raw value', harness => { harness.finishFingerprint.switches.DEVRYAN_VIEW_CLONE = 'sk-private'; }, 'fingerprint_unavailable'],
    ]) {
      const result = comparePairedReports(eachRun(input(), 'baseline', change));
      assert.equal(result.verdict, 'inconclusive', name);
      assert.ok(result.reasons.includes(reason), `${name}: ${result.reasons}`);
    }
  });
  test('allows catalog differences only inside the factor\'s declared capability-schema delta', () => {
    const waitAny = () => {
      const value = input(); value.factor = 'waitAny';
      for (const pair of value.pairs) for (const [side, enabled] of [['baseline', false], ['candidate', true]]) {
        for (const fingerprint of [pair[side].runs[0].harness.startFingerprint, pair[side].runs[0].harness.finishFingerprint]) {
          fingerprint.policies = { readOverlap: false, waitAny: enabled };
          if (enabled) { fingerprint.catalog.contentHash = '9'.repeat(64); fingerprint.catalog.tools[0].contentHash = '9'.repeat(64); }
        }
      }
      return value;
    };
    assert.deepEqual(FACTOR_CAPABILITY_SCHEMA_DELTAS.waitAny, ['devryan_task']);
    assert.equal(comparePairedReports(waitAny()).verdict, 'canary-eligible');
    const undeclared = eachRun(waitAny(), 'candidate', harness => { harness.finishFingerprint.catalog.tools[1].contentHash = '9'.repeat(64); });
    assert.ok(comparePairedReports(undeclared).reasons.includes('configuration_mismatch'));
    const withoutTools = eachRun(waitAny(), 'candidate', harness => { harness.finishFingerprint.catalog.tools = null; });
    assert.ok(comparePairedReports(withoutTools).reasons.includes('fingerprint_unavailable'));
    // readOverlap declares no schema delta: the whole catalog must match.
    const readOverlap = eachRun(input(), 'candidate', harness => { harness.finishFingerprint.catalog.tools[0].contentHash = '9'.repeat(64);
      harness.finishFingerprint.catalog.contentHash = '9'.repeat(64); });
    assert.ok(comparePairedReports(readOverlap).reasons.includes('configuration_mismatch'));
  });
  test('reports the Balanced gate for the role factor without requiring it', () => {
    const value = input(); value.factor = 'role';
    for (const pair of value.pairs) for (const fingerprint of [pair.candidate.runs[0].harness.startFingerprint, pair.candidate.runs[0].harness.finishFingerprint]) {
      fingerprint.role.contentHash = '8'.repeat(64); fingerprint.policies.readOverlap = false;
    }
    for (const pair of value.pairs) pair.candidate.runs[0].harness.evidence.roots[0].objectiveDurationMs = 1000;
    const result = comparePairedReports(value);
    assert.equal(result.verdict, 'canary-eligible');
    assert.equal(result.balanced.required, false); assert.equal(result.balanced.status, 'failed');
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
