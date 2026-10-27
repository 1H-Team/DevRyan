import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { compareRuntimeUpgradeSummaries, runtimeUpgradeScenarios, freezeRuntimeUpgradePolicy, gradeRuntimeUpgradePolicy } from './runtime-upgrade-comparison.mjs';

const hash = number => String(number).repeat(64);
const migration = { name: 'managed-task', baselineHash: hash(4), candidateHash: hash(5) };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report = generation => {
const result = ({ fixtureGeneration: 2, semanticFixtureSha256: hash(1), upgradeProtocolSha256: hash(2),
  environmentSha256: hash(3), startupMode: 'foreground', runsPerScenario: 3, warmupMs: 5000, measureMs: 30000, sampleIntervalMs: 500,
  runtimeFingerprint: { runtimeVersion: '2.0.20',
    role: { contentHash: hash(6) }, catalog: { contentHash: hash(7) }, selection: { providerId: 'fixture', modelId: 'fixture-model' },
    policies: { recovery: true }, plugins: { observed: [{ name: 'managed-task', contentHash: generation === 1 ? hash(4) : hash(5) },
      { name: 'unchanged', contentHash: hash(8) }] } },
  scenarios: Object.fromEntries(runtimeUpgradeScenarios.map(name => [name, { chromium: { product: 'Chrome/synthetic' }, display: { visibilityState: 'visible', innerWidth: 1280, innerHeight: 800 },
    runs: Array.from({length:3}, () => ({completedOperations:100,completedOperationReceiptsSha256:hash(9)})), startup: { totalRuns: 3, successfulRuns: 3, medianUiReadyMs: generation === 1 ? 1000 : 900 },
    aggregate: { medianTabCpu: generation === 1 ? 10 : 9 } }])) });
result.scenarios.idle.kind = 'idle-observation';
result.scenarios.idle.runs = Array.from({length:3}, () => ({completedOperations:0,submittedOperations:0,durationMs:30000,sampleCount:60,observationSha256:hash(9)}));
result.environmentEvidence = {platform:'unit-fixture',arch:'unit-fixture',node:'unit-fixture',cpu:'unit-fixture'};
result.environmentSha256 = digest(result.environmentEvidence);
result.executionEvidence = {kind:'native-runtime',generation:2,artifactSha256:hash(1),sourceSha256:hash(2),
  observationsSha256:hash(3),runtimeFingerprintSha256:digest(result.runtimeFingerprint)};
result.executionSha256 = digest(result.executionEvidence);
result.comparisonArm = {id:generation === 1 ? 'baseline' : 'candidate',configurationSha256:digest(result.runtimeFingerprint)};
return result;
};

test('v2 arm comparison preserves declared exact plugin migrations and describes deltas without an acceptance verdict', () => {
  const result = compareRuntimeUpgradeSummaries(report(1), report(2), { runtimePluginMigrations: [migration] });
  assert.equal(result.status, 'compared');
  assert.equal(result.passed, undefined);
  assert.equal(result.changes['one-stream'].metrics.medianTabCpu.delta, -1);
  assert.equal(result.changes['one-stream'].startupMs, -100);
  assert.match(result.scope, /descriptive fixture/);
});

test('matching subsets and explicitly diagnostic full matrices cannot qualify Stage E', () => {
  for (const missing of runtimeUpgradeScenarios) {
    const baseline=report(1),candidate=report(2);
    delete baseline.scenarios[missing];delete candidate.scenarios[missing];
    const result=compareRuntimeUpgradeSummaries(baseline,candidate,{runtimePluginMigrations:[migration]});
    assert.equal(result.status,'diagnostic');
    assert.deepEqual(result.missingScenarios,[missing]);
    assert.deepEqual(result.reasons,['incomplete_scenario_matrix']);
    assert.equal(result.changes,undefined);
    candidate.scenarios['one-stream'===missing?'four-streams':'one-stream'].runs[0].completedOperations=99;
    assert.throws(()=>compareRuntimeUpgradeSummaries(baseline,candidate,{runtimePluginMigrations:[migration]}),/100 receipt-backed/);
  }
  const candidate=report(2);candidate.diagnostic=true;
  const result=compareRuntimeUpgradeSummaries(report(1),candidate,{runtimePluginMigrations:[migration]});
  assert.equal(result.status,'diagnostic');assert.deepEqual(result.reasons,['diagnostic_run']);
  assert.equal(result.changes,undefined);
  const baseline=report(1),foreign=report(2);
  for(const value of [baseline,foreign])value.scenarios.foreign=structuredClone(value.scenarios['one-stream']);
  assert.throws(()=>compareRuntimeUpgradeSummaries(baseline,foreign,{runtimePluginMigrations:[migration]}),/Unknown runtime upgrade scenario/);
});

test('runtime labels or missing native observations cannot become comparable evidence', () => {
  for (const key of ['runtimeFingerprint', 'semanticFixtureSha256', 'upgradeProtocolSha256', 'environmentSha256']) {
    const candidate = report(2); delete candidate[key];
    assert.equal(compareRuntimeUpgradeSummaries(report(1), candidate, { runtimePluginMigrations: [migration] }).status, 'unavailable');
  }
  const candidate = report(2); delete candidate.runtimeFingerprint.policies;
  assert.equal(compareRuntimeUpgradeSummaries(report(1), candidate).status, 'unavailable');
});

test('migrations never excuse other plugin, role, catalog, policy, model or protocol differences', () => {
  for (const mutate of [
    value => { value.runtimeFingerprint.plugins.observed[1].contentHash = hash(9); },
    value => { value.runtimeFingerprint.role.contentHash = hash(9); },
    value => { value.runtimeFingerprint.catalog.contentHash = hash(9); },
    value => { value.runtimeFingerprint.policies.recovery = false; },
    value => { value.runtimeFingerprint.selection.modelId = 'different'; },
    value => { value.runtimeFingerprint.runtimeVersion = '1.18.33'; },
    value => { value.semanticFixtureSha256 = hash(9); },
    value => { value.environmentSha256 = hash(9); },
    value => { value.upgradeProtocolSha256 = hash(9); },
  ]) {
    const candidate = report(2); mutate(candidate);
    assert.throws(() => compareRuntimeUpgradeSummaries(report(1), candidate, { runtimePluginMigrations: [migration] }), /mismatch|matching|comparison arms/);
  }
  for (const declarations of [[], [{ ...migration, candidateHash: hash(9) }], [{ ...migration, name: 'missing' }]]) {
    assert.throws(() => compareRuntimeUpgradeSummaries(report(1), report(2), { runtimePluginMigrations: declarations }), /configuration mismatch|comparison arms/);
  }
});

test('v2 arm comparison rejects partial launches, changed workloads and invisible windows', () => {
  for (const mutate of [
    value => { value.scenarios['one-stream'].runs.pop(); }, value => { value.scenarios['one-stream'].runs[0].error = 'failed'; },
    value => { value.scenarios['one-stream'].startup.successfulRuns = 2; },
    value => { value.measureMs = 1000; }, value => { value.scenarios.other = structuredClone(value.scenarios['one-stream']); },
    value => { value.scenarios['one-stream'].display.visibilityState = 'hidden'; },
    value => { value.scenarios['one-stream'].chromium.product = 'different'; },
  ]) {
    const candidate = report(2); mutate(candidate);
    assert.throws(() => compareRuntimeUpgradeSummaries(report(1), candidate, { runtimePluginMigrations: [migration] }));
  }
  const retired = report(1); retired.fixtureGeneration = 1;
  assert.throws(() => compareRuntimeUpgradeSummaries(retired, report(2)), /generation 2 arms/);
});

test('receipt count belongs to each launch and fixture wire labels cannot imply native execution', () => {
  for (const mutate of [
    value => { delete value.scenarios['one-stream'].runs[1].completedOperations; },
    value => { value.scenarios['one-stream'].runs[1].completedOperations = 99; },
    value => { value.scenarios['one-stream'].runs[0].completedOperations = 300; value.scenarios['one-stream'].runs[1].completedOperations = 0; },
    value => { delete value.scenarios['one-stream'].runs[1].completedOperationReceiptsSha256; },
  ]) {
    const candidate=report(2);mutate(candidate);
    assert.throws(()=>compareRuntimeUpgradeSummaries(report(1),candidate,{runtimePluginMigrations:[migration]}),/100 receipt-backed/);
  }
  for (const mutate of [
    value => { delete value.executionEvidence; },
    value => { value.executionEvidence.kind='rest-sse-fixture'; },
    value => { delete value.environmentEvidence.cpu; },
  ]) {
    const candidate=report(2);mutate(candidate);
    assert.equal(compareRuntimeUpgradeSummaries(report(1),candidate,{runtimePluginMigrations:[migration]}).status,'unavailable');
  }
  for(const mutate of [value=>{value.executionSha256=hash(9);},value=>{value.environmentEvidence.cpu='changed';}]) {
    const candidate=report(2);mutate(candidate);
    assert.throws(()=>compareRuntimeUpgradeSummaries(report(1),candidate,{runtimePluginMigrations:[migration]}),/evidence hash mismatch/);
  }
});

test('headless owned-process arms compare separately and idle cannot invent completed work', () => {
  const nativeReport = generation => {
    const value=report(generation);value.measurementKind='native-process-tree';
    for (const scenario of Object.values(value.scenarios)) {
      delete scenario.chromium;delete scenario.display;
      scenario.processConditions={kind:'owned-process-tree',ui:'none'};
      scenario.startup.medianRuntimeReadyMs=scenario.startup.medianUiReadyMs;
      delete scenario.startup.medianUiReadyMs;
      scenario.runs.forEach(run=>{run.resource={failures:[]};run.sampleCount=60;});
    }
    return value;
  };
  assert.equal(compareRuntimeUpgradeSummaries(nativeReport(1),nativeReport(2),{runtimePluginMigrations:[migration]}).status,'compared');
  for(const mutate of [
    value=>{value.scenarios.idle.runs[0].completedOperations=100;},
    value=>{value.scenarios.idle.runs[0].submittedOperations=1;},
    value=>{value.scenarios.idle.runs[0].sampleCount=0;},
    value=>{delete value.scenarios.idle.runs[0].observationSha256;},
    value=>{delete value.scenarios.idle.kind;},
    value=>{value.scenarios['one-stream'].processConditions.ui='other';},
    value=>{delete value.scenarios['one-stream'].runs[0].resource;},
    value=>{value.scenarios['one-stream'].runs[0].resource.failures.push({code:'lost'});},
  ]){const value=nativeReport(2);mutate(value);assert.throws(()=>compareRuntimeUpgradeSummaries(nativeReport(1),value,{runtimePluginMigrations:[migration]}));}
});

// Synthetic summaries exercise grading contracts; none are benchmark evidence.
const policyFixture = () => {
  const make = generation => {
    const value = report(generation); value.measurementKind = 'native-process-tree';
    value.environmentEvidence.platform = 'darwin'; value.environmentSha256 = digest(value.environmentEvidence);
    for (const [name, scenario] of Object.entries(value.scenarios)) {
      delete scenario.chromium; delete scenario.display;
      scenario.kind = name === 'idle' ? 'idle-observation' : 'completed-operations';
      scenario.processConditions = { kind: 'owned-process-tree', ui: 'none' };
      scenario.startup.medianRuntimeReadyMs = 1000;
      scenario.runs = Array.from({ length: 3 }, (_, index) => {
        const processes = [{ pid: 100, startIdentity: 'owned-worker-one', cpuMs: 100, rssMiB: 20 },
          { pid: 101, startIdentity: 'owned-worker-two', cpuMs: 100, rssMiB: 20 }];
        const receipts = name === 'idle' ? [] : Array.from({ length: 100 }, (_, operation) => ({
          id: `${name}-${index}-${operation}`, toolProofs: name === 'eight-call-bursts' ? Array.from({ length: 8 }, (_, call) => ({
            state: { time: { start: operation * 1000 + call, end: operation * 1000 + 100 } },
            ledger: { token: `lease-${operation}-${call}`, receipt: { terminated: true, confined: true } },
          })) : [],
        }));
        const writerIdentities = receipts.flatMap(receipt => receipt.toolProofs.map(tool => {
          const pid = 1000 + processes.length;
          const row = { pid, startIdentity: `owned-writer-${index}-${pid}`, cpuMs: 100, rssMiB: 0 };
          processes.push(row); return { ...row, receiptToken: tool.ledger.token };
        }));
        return { status: 'completed', generation: 2, scenario: name, completedOperations: receipts.length, submittedOperations: receipts.length,
          completedOperationReceiptsSha256: digest(receipts), observationSha256: digest({ generation, name, index }), receipts,
          durationMs: 1000, sampleCount: 1, startupMs: 1000, sourceCohort: { valid: true }, cleanup: { cleanupFailures: [] },
          metrics: { operationP95Ms: 100, completedOperationsPerSecond: name === 'idle' ? 0 : 100,
            hostCpuMs: name === 'idle' ? 10 : 1000, sampledDescendantCpuMs: name === 'idle' ? 10 : name === 'eight-call-bursts' ? 1_000_000 : 10000,
            peakHostRssMiB: 100, settledHostRssMiB: 90, peakDescendantRssMiB: 100, settledDescendantRssMiB: 90,
            peakTreeRssMiB: 200, settledTreeRssMiB: 200,
            hostLoopP95Ms: name === 'idle' ? 10 : 100, sampledProcessIdentities: processes.length },
          resource: { failures: [], exitedBeforeSample: [], samples: [{ hostRssMiB: 100, descendantRssMiB: 100, processes }],
            processOwnership: { observedProcesses: processes }, receiptProcessIdentities: { status: 'observed',
              required: writerIdentities.length, observed: writerIdentities.length, unavailable: [], identities: writerIdentities } },
        };
      });
    }
    return value;
  };
  const calibration = make(1), baseline = make(1), candidate = make(2);
  const time = offset => new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();
  let offset = 0;
  for (const name of runtimeUpgradeScenarios) for (const run of calibration.scenarios[name].runs) {
    run.hostConditions = { before: { observedAt: time(offset++) }, after: { observedAt: time(offset++) } };
  }
  offset = 100;
  for (let index = 0; index < 3; index++) for (const name of runtimeUpgradeScenarios) {
    for (const value of index === 1 ? [candidate, baseline] : [baseline, candidate]) {
      value.scenarios[name].runs[index].hostConditions = { before: { observedAt: time(offset++) }, after: { observedAt: time(offset++) } };
    }
  }
  const frozenInputs = { configurationSha256: hash(1), policySourceSha256: hash(8),
    baselineSourceSha256: calibration.executionEvidence.sourceSha256, candidateSourceSha256: candidate.executionEvidence.sourceSha256,
    candidateArtifactSha256: candidate.executionEvidence.artifactSha256,
    baselineArmID:'baseline',candidateArmID:'candidate',
    baselineConfigurationSha256:calibration.comparisonArm.configurationSha256,candidateConfigurationSha256:candidate.comparisonArm.configurationSha256,
    comparisonDeclarationSha256:digest({configurationDelta:[],runtimePluginMigrations:[migration]}),
    upgradeProtocolSha256: calibration.upgradeProtocolSha256, environmentSha256: calibration.environmentSha256 };
  const options = { frozenAt: time(60), frozenInputs, monotonicPrecisionMs: .001, runtimePluginMigrations:[migration] };
  const policy = freezeRuntimeUpgradePolicy(calibration, options);
  return { calibration, baseline, candidate, options, policy, gradeOptions: { frozenInputs, runtimePluginMigrations: [migration] } };
};

test('independent calibration freezes exact seven-scenario bands before three AB/BA/AB pairs', () => {
  const input = policyFixture();
  assert.equal(input.policy.status, 'frozen');
  assert.equal(input.policy.calibrationRunSha256.length, 21);
  assert.equal(input.policy.bands['one-stream'].metrics.startupMs.allowance, 50);
  assert.equal(input.policy.bands['one-stream'].metrics.sampledDescendantCpuMs.quantum, 20);
  assert.equal(input.policy.bands.idle.metrics.hostCpuMs.allowance, 20);
  assert.equal(input.policy.bands.idle.metrics.sampledDescendantCpuMs.allowance, 40);
  const result = gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions);
  assert.equal(result.status, 'nonregressing');
  assert.ok(result.measured.some(row => row.metric === 'throughputCostMs'));
  assert.ok(result.measured.some(row => row.metric === 'burstMedianMs'));
  assert.ok(!result.measured.some(row => row.metric.startsWith('terminal')));
});

test('calibration rejects unresolved relative bands and noisy idle absolute budgets without widening', () => {
  for (const [key, values] of [['operationP95Ms', [100, 100, 111]], ['hostCpuMs', [0, 0, 11]]]) {
    const input = policyFixture(), name = key === 'hostCpuMs' ? 'idle' : 'one-stream';
    input.calibration.scenarios[name].runs.forEach((run, index) => { run.metrics[key] = values[index]; });
    const result = freezeRuntimeUpgradePolicy(input.calibration, input.options);
    assert.equal(result.status, 'inconclusive'); assert.match(result.reasons.join(), /calibration_too_noisy/);
  }
  const input = policyFixture();
  input.calibration.scenarios['one-stream'].runs.forEach(run => { run.metrics.operationP95Ms = .01; });
  assert.equal(freezeRuntimeUpgradePolicy(input.calibration, { ...input.options, monotonicPrecisionMs: 1 }).status, 'inconclusive');
});

test('frozen grading checks every adjacent delta and every paired baseline independently', () => {
  const input = policyFixture();
  input.candidate.scenarios['one-stream'].runs[0].metrics.operationP95Ms = 105;
  assert.equal(gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions).status, 'nonregressing');
  input.candidate.scenarios['one-stream'].runs[0].metrics.operationP95Ms = 105.001;
  assert.equal(gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions).status, 'regressed');
  input.baseline.scenarios['one-stream'].runs[0].metrics.operationP95Ms = 100.003;
  const drift = gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions);
  assert.equal(drift.status, 'inconclusive'); assert.match(drift.reasons.join(), /baseline_drift/);
});

test('mandatory missing, nonfinite, negative or unknown sampling values never pass', () => {
  for (const mutate of [
    value => { delete value.scenarios['one-stream'].runs[0].metrics.operationP95Ms; },
    value => { value.scenarios['one-stream'].runs[0].metrics.hostCpuMs = Infinity; },
    value => { value.scenarios['one-stream'].runs[0].metrics.peakTreeRssMiB = -1; },
    value => { value.scenarios['one-stream'].runs[0].metrics.completedOperationsPerSecond = 0; },
    value => { delete value.scenarios['eight-call-bursts'].runs[0].receipts[0].toolProofs[0].state.time; },
    value => { delete value.scenarios['one-stream'].runs[0].resource.exitedBeforeSample; },
    value => { delete value.scenarios['eight-call-bursts'].runs[0].resource.receiptProcessIdentities; },
    value => { value.scenarios['eight-call-bursts'].runs[0].resource.receiptProcessIdentities.identities[0].startIdentity = 'unsampled'; },
    value => { value.scenarios['eight-call-bursts'].runs[0].resource.receiptProcessIdentities.required--; },
    value => { value.scenarios['eight-call-bursts'].runs[0].resource.receiptProcessIdentities.observed--; },
    value => {
      const rows = value.scenarios['eight-call-bursts'].runs[0].resource.receiptProcessIdentities.identities;
      rows[1].pid = rows[0].pid; rows[1].startIdentity = rows[0].startIdentity;
    },
  ]) {
    const input = policyFixture(); mutate(input.candidate);
    assert.equal(gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions).status, 'inconclusive');
  }
});

test('counter identity ceiling, independent chronology and frozen hashes cannot change during pairs', () => {
  for (const mutate of [
    input => { input.candidate.scenarios['one-stream'].runs[0].metrics.sampledProcessIdentities = 3;
      input.candidate.scenarios['one-stream'].runs[0].resource.samples[0].processes.push({ pid: 102, startIdentity: 'new', cpuMs: 1, rssMiB: 1 }); },
    input => { input.candidate.scenarios['one-stream'].runs[0].hostConditions = input.baseline.scenarios['one-stream'].runs[0].hostConditions; },
    input => { input.policy.bands['one-stream'].metrics.operationP95Ms.allowance = 1000; },
    input => { input.gradeOptions.frozenInputs = { ...input.options.frozenInputs, configurationSha256: hash(9) }; },
    input => { input.baseline.scenarios['one-stream'].runs[0].hostConditions.before.observedAt = input.options.frozenAt; },
  ]) {
    const input = policyFixture(); mutate(input);
    assert.equal(gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions).status, 'inconclusive');
  }
});

test('candidate median uses the frozen calibration rather than adding permitted baseline drift', () => {
  const input = policyFixture();
  for (const run of input.baseline.scenarios['one-stream'].runs) run.metrics.operationP95Ms = 100.001;
  for (const run of input.candidate.scenarios['one-stream'].runs) run.metrics.operationP95Ms = 105;
  assert.equal(gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions).status, 'nonregressing');
  for (const run of input.candidate.scenarios['one-stream'].runs) run.metrics.operationP95Ms = 105.0005;
  const result = gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions);
  assert.equal(result.status, 'regressed');
  assert.deepEqual(result.reasons, []);
  assert.ok(result.measured.find(row => row.scenario === 'one-stream' && row.metric === 'operationP95Ms').adjacentDeltas.every(value => value < 5));
});

test('throughput and true tool-burst cost are mandatory even with unchanged prompt latency', () => {
  const input = policyFixture();
  input.candidate.scenarios['one-stream'].runs.forEach(run => { run.metrics.completedOperationsPerSecond = 90; run.durationMs = 100 / 90 * 1000; });
  assert.ok(gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions).regressions.includes('one-stream:throughputCostMs'));
  input.candidate.scenarios['one-stream'].runs.forEach(run => { run.metrics.completedOperationsPerSecond = 100; run.durationMs = 1000; });
  input.candidate.scenarios['eight-call-bursts'].runs[0].receipts.forEach(receipt => {
    receipt.toolProofs.forEach(tool => { tool.state.time.end += 6; });
  });
  const result = gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions);
  assert.equal(result.status, 'regressed'); assert.ok(result.regressions.includes('eight-call-bursts:burstMedianMs'));
});

test('unknown calibration counter platform and absent evidence do not throw or freeze', () => {
  const input = policyFixture();
  assert.equal(freezeRuntimeUpgradePolicy(undefined, input.options).status, 'inconclusive');
  const missing = structuredClone(input.calibration); delete missing.environmentEvidence;
  assert.equal(freezeRuntimeUpgradePolicy(missing, input.options).status, 'inconclusive');
  const foreign = structuredClone(input.calibration); foreign.environmentEvidence.platform = 'linux';
  foreign.environmentSha256 = digest(foreign.environmentEvidence);
  assert.ok(freezeRuntimeUpgradePolicy(foreign, input.options).reasons.includes('ps_counter_precision_unqualified_for_platform'));
});

test('hardcap and absolute idle variability boundaries are inclusive with units-aware CPU precision', () => {
  const input = policyFixture();
  input.calibration.scenarios['one-stream'].runs.forEach((run, index) => {
    run.metrics.operationP95Ms = [91, 100, 100][index];
    run.metrics.sampledDescendantCpuMs = 400;
  });
  input.calibration.scenarios.idle.runs.forEach((run, index) => { run.metrics.hostCpuMs = [0, 0, 10][index]; });
  const policy = freezeRuntimeUpgradePolicy(input.calibration, { ...input.options, monotonicPrecisionMs: .5 });
  assert.equal(policy.status, 'frozen');
  assert.equal(policy.bands['one-stream'].metrics.operationP95Ms.allowance, 10);
  assert.equal(policy.bands['one-stream'].metrics.sampledDescendantCpuMs.allowance, 40);
  assert.equal(policy.bands.idle.metrics.hostCpuMs.mode, 'absolute-idle-budget');
  input.calibration.scenarios['one-stream'].runs.forEach(run => { run.metrics.sampledDescendantCpuMs = 399; });
  assert.equal(freezeRuntimeUpgradePolicy(input.calibration, { ...input.options, monotonicPrecisionMs: .5 }).status, 'inconclusive');
});

test('whole-tree RSS uses aligned samples and refuses independently timed peak sums', () => {
  const input = policyFixture(), run = input.candidate.scenarios['one-stream'].runs[0];
  const processes = run.resource.samples[0].processes;
  run.resource.samples = [{ hostRssMiB: 200, descendantRssMiB: 0, processes },
    { hostRssMiB: 0, descendantRssMiB: 200, processes }];
  run.sampleCount = 2;
  run.metrics.peakHostRssMiB = 200; run.metrics.peakDescendantRssMiB = 200;
  run.metrics.peakTreeRssMiB = 200; run.metrics.settledTreeRssMiB = 200;
  assert.equal(gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions).status, 'nonregressing');
  run.metrics.peakTreeRssMiB = run.metrics.peakHostRssMiB + run.metrics.peakDescendantRssMiB;
  assert.equal(gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions).status, 'inconclusive');
  run.resource.samples[0].descendantRssMiB = 200;
  const result = gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions);
  assert.equal(result.status, 'regressed'); assert.ok(result.regressions.includes('one-stream:peakTreeRssMiB'));
  assert.ok(!result.measured.some(row => row.metric === 'peakHostRssMiB' || row.metric === 'peakDescendantRssMiB'));
  assert.equal(input.policy.bands['one-stream'].metrics.peakTreeRssMiB.quantum, 3 / 1024);
});


test('candidate artifact must match the manifest pinned before calibration policy freeze', () => {
  const input = policyFixture();
  const missing = { ...input.options.frozenInputs }; delete missing.candidateArtifactSha256;
  assert.equal(freezeRuntimeUpgradePolicy(input.calibration, { ...input.options, frozenInputs: missing }).status, 'inconclusive');
  input.candidate.executionEvidence.artifactSha256 = hash(9);
  input.candidate.executionSha256 = digest(input.candidate.executionEvidence);
  const result = gradeRuntimeUpgradePolicy(input.policy, input.baseline, input.candidate, input.gradeOptions);
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(result.reasons, ['paired_freeze_binding_mismatch']);
});


test('same artifact configuration comparison binds distinct arms and only exact declared leaves', () => {
  const baseline = report(1), candidate = report(2);
  candidate.runtimeFingerprint = structuredClone(baseline.runtimeFingerprint);
  candidate.runtimeFingerprint.policies.healthyReconcileIntervalMs = 10000;
  baseline.runtimeFingerprint.policies.healthyReconcileIntervalMs = 1000;
  const bind = value => {
    value.comparisonArm.configurationSha256 = digest(value.runtimeFingerprint);
    value.executionEvidence.runtimeFingerprintSha256 = digest(value.runtimeFingerprint);
    value.executionSha256 = digest(value.executionEvidence);
  };
  bind(baseline); bind(candidate);
  const declaration = [{path:['policies','healthyReconcileIntervalMs'],baseline:1000,candidate:10000}];
  assert.equal(compareRuntimeUpgradeSummaries(baseline, candidate, {configurationDelta:declaration}).status, 'compared');
  assert.throws(() => compareRuntimeUpgradeSummaries(baseline, candidate), /configuration mismatch/);
  for (const delta of [[{...declaration[0],candidate:20000}], [...declaration,...declaration],
    [{path:['policies'],baseline:{},candidate:{changed:true}}], [{path:['runtimeVersion','value'],baseline:1,candidate:2}]]) {
    assert.throws(() => compareRuntimeUpgradeSummaries(baseline, candidate, {configurationDelta:delta}));
  }
  candidate.comparisonArm.id = baseline.comparisonArm.id;
  assert.throws(() => compareRuntimeUpgradeSummaries(baseline, candidate, {configurationDelta:declaration}), /comparison arms/);
});
