import { matchRuntimeUpgradeFingerprints } from '../agent-evals/paired.mjs';
import { createHash } from 'node:crypto';

const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const runtimeUpgradeScenarios = Object.freeze(['idle', 'one-stream', 'four-streams', 'long-history', 'tools-1k', 'tools-12k', 'eight-call-bursts']);

/** Exact native v2 arms. Declared leaf changes are pinned before calibration;
 * no whole section, runtime version or plugin inventory is normalized away. */
export function matchV2ComparisonFingerprints(baseline, candidate, configurationDelta = [], runtimePluginMigrations = []) {
  const left = structuredClone(baseline), right = structuredClone(candidate);
  if (!Array.isArray(configurationDelta)) throw new Error('Invalid configuration delta');
  const seen = [];
  for (const entry of configurationDelta) {
    const parts = entry?.path;
    if (!Array.isArray(parts) || parts.length < 2 || parts.some(key => typeof key !== 'string'
      || !key || ['__proto__', 'prototype', 'constructor'].includes(key))
      || ['runtimeVersion', 'plugins'].includes(parts[0]) || same(entry.baseline, entry.candidate)
      || seen.some(old => same(old.slice(0, Math.min(old.length, parts.length)), parts.slice(0, Math.min(old.length, parts.length))))) {
      throw new Error('Invalid or overlapping configuration delta');
    }
    seen.push(parts);
    for (const [fingerprint, side] of [[left, 'baseline'], [right, 'candidate']]) {
      let owner = fingerprint;
      for (const key of parts.slice(0, -1)) owner = owner && Object.hasOwn(owner, key) ? owner[key] : undefined;
      const key = parts.at(-1);
      if (!owner || !Object.hasOwn(owner, key) || !same(owner[key], entry[side])
        || owner[key] !== null && typeof owner[key] === 'object') throw new Error('Configuration delta does not match exact observed leaf');
      owner[key] = { declaredConfigurationDelta: parts.join('.') };
    }
  }
  const matched = matchRuntimeUpgradeFingerprints(left, right, runtimePluginMigrations);
  if (!matched.available) return matched;
  for (const [fingerprint, side] of [[left, 'baseline'], [right, 'candidate']]) {
    fingerprint.plugins.observed = fingerprint.plugins.observed.map(plugin => {
      const declaration = runtimePluginMigrations.find(row=>row.name===plugin.name && row[`${side}Hash`]===plugin.contentHash);
      return declaration ? {...plugin,contentHash:`declared:${digest(declaration)}`} : plugin;
    }).sort((a,b)=>a.name.localeCompare(b.name));
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object'
    ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
  return { ...matched, matched: matched.matched && same(canonical(left),canonical(right)) };

}
export const compareRuntimeUpgradeSummaries = (baseline, candidate, { configurationDelta = [], runtimePluginMigrations = [] } = {}) => {
  if (baseline?.fixtureGeneration !== 2 || candidate?.fixtureGeneration !== 2) {
    throw new Error('Comparison requires two native generation 2 arms');
  }
  const identities = ['semanticFixtureSha256', 'upgradeProtocolSha256', 'environmentSha256'];
  const missing = identities.filter(key => !isHash(baseline[key]) || !isHash(candidate[key]));
  const fingerprint = matchV2ComparisonFingerprints(baseline.runtimeFingerprint, candidate.runtimeFingerprint, configurationDelta, runtimePluginMigrations);
  if (missing.length || !fingerprint.available) return { status: 'unavailable',
    reasons: [...missing.map(key => `missing_${key}`), ...(!fingerprint.available ? ['observed_runtime_fingerprint_unavailable'] : [])] };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(baseline.comparisonArm?.id ?? '') || !/^[a-zA-Z0-9_-]{1,64}$/.test(candidate.comparisonArm?.id ?? '') || baseline.comparisonArm.id === candidate.comparisonArm.id
    || baseline.comparisonArm.configurationSha256 !== digest(baseline.runtimeFingerprint)
    || candidate.comparisonArm.configurationSha256 !== digest(candidate.runtimeFingerprint)) throw new Error('Distinct pinned comparison arms required');
  for (const report of [baseline, candidate]) {
    const execution = report.executionEvidence, environment = report.environmentEvidence;
    if (!execution || execution.kind !== 'native-runtime' || execution.generation !== report.fixtureGeneration
      || !['artifactSha256', 'sourceSha256', 'observationsSha256', 'runtimeFingerprintSha256'].every(key => isHash(execution[key]))
      || !environment || !['platform', 'arch', 'node', 'cpu'].every(key => typeof environment[key] === 'string' && environment[key].trim())) {
      return { status: 'unavailable', reasons: ['native_execution_or_environment_evidence_unavailable'] };
    }
    if (execution.runtimeFingerprintSha256 !== digest(report.runtimeFingerprint)
      || report.executionSha256 !== digest(execution) || report.environmentSha256 !== digest(environment)) {
      throw new Error('Runtime upgrade execution or environment evidence hash mismatch');
    }
  }
  for (const key of identities) if (baseline[key] !== candidate[key]) throw new Error(`Runtime upgrade comparison requires matching ${key}`);
  if (!fingerprint.matched) throw new Error('Native v2 configuration mismatch');
  for (const key of ['startupMode', 'runsPerScenario', 'warmupMs', 'measureMs', 'sampleIntervalMs']) {
    if (baseline[key] === undefined || !same(baseline[key], candidate[key])) throw new Error(`Runtime upgrade comparison requires matching ${key}`);
  }
  if (baseline.runsPerScenario < 3) throw new Error('Runtime upgrade comparison requires at least three launches per scenario');
  const names = Object.keys(baseline.scenarios ?? {}).sort();
  if (!names.length || !same(names, Object.keys(candidate.scenarios ?? {}).sort())) throw new Error('Runtime upgrade scenario membership mismatch');
  if (names.some(name => !runtimeUpgradeScenarios.includes(name))) throw new Error('Unknown runtime upgrade scenario');
  const missingScenarios = runtimeUpgradeScenarios.filter(name => !names.includes(name));
  const changes = {};
  for (const name of names) {
    const before = baseline.scenarios[name], after = candidate.scenarios[name];
    if (baseline.measurementKind === 'native-process-tree' && candidate.measurementKind === 'native-process-tree') {
      if (before.processConditions?.kind !== 'owned-process-tree' || !same(before.processConditions, after.processConditions)) {
        throw new Error('Runtime upgrade comparison requires matching owned process measurement conditions');
      }
      if ([before,after].some(scenario=>scenario.runs?.some(run=>!Array.isArray(run.resource?.failures)
        ||run.resource.failures.length||!(run.sampleCount>0)))) throw new Error('Owned process resource observation was incomplete');
    } else if (!before.chromium?.product || !same(before.chromium, after.chromium)
      || before.display?.visibilityState !== 'visible' || !before.display.innerWidth || !same(before.display, after.display)) {
      throw new Error('Runtime upgrade comparison requires matching Chromium and visible display conditions');
    }
    for (const scenario of [before, after]) {
      if (scenario.runs?.length !== baseline.runsPerScenario || scenario.runs.some(run => run.failed || run.error)
        || scenario.startup?.totalRuns !== baseline.runsPerScenario
        || scenario.startup.successfulRuns !== scenario.startup.totalRuns) {
        throw new Error('Runtime upgrade comparison requires all retained launches to succeed');
      }
      if (name === 'idle') {
        if (scenario.kind !== 'idle-observation') throw new Error('Idle requires a measured zero-work observation');
        if (scenario.runs.some(run => run.completedOperations !== 0 || run.submittedOperations !== 0
          || !(run.durationMs > 0) || !(run.sampleCount > 0) || !isHash(run.observationSha256))) {
          throw new Error('Idle requires a measured zero-work observation, not fabricated completed operations');
        }
      } else if (scenario.runs.some(run => !Number.isSafeInteger(run.completedOperations) || run.completedOperations < 100
        || !isHash(run.completedOperationReceiptsSha256))) {
        throw new Error('Runtime upgrade comparison requires at least 100 receipt-backed completed operations per scenario, arm and launch');
      }
    }
    if (before.kind !== after.kind) throw new Error('Runtime upgrade scenario kind mismatch');
    const metrics = {};
    for (const key of Object.keys(before.aggregate ?? {}).sort()) {
      const a = before.aggregate[key], b = after.aggregate?.[key];
      if (typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)) {
        metrics[key] = { baseline: a, candidate: b, delta: b - a, ratio: a === 0 ? null : b / a };
      }
    }
    const startupKey = baseline.measurementKind === 'native-process-tree' ? 'medianRuntimeReadyMs' : 'medianUiReadyMs';
    if (![before.startup[startupKey], after.startup[startupKey]].every(Number.isFinite)) throw new Error('Observed startup duration unavailable');
    changes[name] = { metrics, startupMs: after.startup[startupKey] - before.startup[startupKey] };
  }
  if (missingScenarios.length || baseline.diagnostic || candidate.diagnostic) return { status: 'diagnostic',
    reasons: [...(missingScenarios.length ? ['incomplete_scenario_matrix'] : []), ...(baseline.diagnostic || candidate.diagnostic ? ['diagnostic_run'] : [])],
    missingScenarios, scope: 'Diagnostic evidence cannot qualify Stage E', runtimePluginMigrations };
  return { status: 'compared', scope: 'descriptive fixture resource deltas; provider latency, native confinement and upgrade acceptance are not established',
    runtimePluginMigrations, changes };
};

// Prospective policy for the headless collector only. The descriptive/UI API
// above is unchanged; a frozen policy is never derived from candidate values.
const policyMetrics = Object.freeze([
  'startupMs', 'operationP95Ms', 'throughputCostMs', 'burstMedianMs', 'hostCpuMs',
  'sampledDescendantCpuMs', 'peakTreeRssMiB', 'settledTreeRssMiB', 'hostLoopP95Ms',
]);
const frozenKeys = ['configurationSha256', 'policySourceSha256', 'baselineSourceSha256',
  'candidateSourceSha256', 'candidateArtifactSha256', 'upgradeProtocolSha256', 'environmentSha256',
  'baselineConfigurationSha256', 'candidateConfigurationSha256', 'comparisonDeclarationSha256'];
const validMetric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const identity = row => `${row.pid}\0${row.startIdentity}`;
const validIdentity = row => Number.isSafeInteger(row?.pid) && row.pid > 0
  && typeof row.startIdentity === 'string' && row.startIdentity.length > 0;
const applicableMetrics = name => policyMetrics.filter(key => (name !== 'idle'
  || !['operationP95Ms', 'throughputCostMs', 'burstMedianMs'].includes(key))
  && (key !== 'burstMedianMs' || name === 'eight-call-bursts'));
const metricValue = (run, key) => {
  if (key === 'startupMs') return run.startupMs;
  if (key === 'throughputCostMs') {
    const rate = run.metrics?.completedOperationsPerSecond;
    return validMetric(rate) && rate > 0 ? 1000 / rate : null;
  }
  if (['peakTreeRssMiB', 'settledTreeRssMiB'].includes(key)) {
    const samples = run.resource?.samples;
    if (!Array.isArray(samples) || !samples.length
      || samples.some(row => !validMetric(row?.hostRssMiB) || !validMetric(row?.descendantRssMiB))) return null;
    const totals = samples.map(row => row.hostRssMiB + row.descendantRssMiB);
    const actual = key === 'peakTreeRssMiB' ? Math.max(...totals) : totals.at(-1);
    return run.metrics?.[key] === actual ? actual : null;
  }
  if (key !== 'burstMedianMs') return run.metrics?.[key];
  if (!Array.isArray(run.receipts) || run.receipts.length !== run.completedOperations) return null;
  const durations = run.receipts.map(receipt => {
    if (receipt.toolProofs?.length !== 8) return null;
    const times = receipt.toolProofs.map(tool => tool.state?.time);
    if (times.some(time => !validMetric(time?.start) || !validMetric(time?.end) || time.end < time.start)) return null;
    return Math.max(...times.map(time => time.end)) - Math.min(...times.map(time => time.start));
  });
  if (!durations.length || !durations.every(validMetric)) return null;
  return median(durations);
};

function policyReportIssues(report) {
  const issues = [];
  if (report?.measurementKind !== 'native-process-tree' || report.diagnostic
    || report.runsPerScenario !== 3 || !same(Object.keys(report.scenarios ?? {}).sort(), [...runtimeUpgradeScenarios].sort())) {
    return ['complete_native_matrix_required'];
  }
  const execution = report.executionEvidence;
  if (!execution || execution.kind !== 'native-runtime' || execution.generation !== report.fixtureGeneration
    || !['artifactSha256', 'sourceSha256', 'observationsSha256', 'runtimeFingerprintSha256'].every(key => isHash(execution[key]))
    || execution.runtimeFingerprintSha256 !== (report.runtimeFingerprint ? digest(report.runtimeFingerprint) : null)
    || !report.runtimeFingerprint || !report.environmentEvidence
    || !['platform', 'arch', 'node', 'cpu'].every(key => typeof report.environmentEvidence[key] === 'string' && report.environmentEvidence[key].trim())
    || report.executionSha256 !== digest(execution) || report.environmentSha256 !== digest(report.environmentEvidence)
    || !isHash(report.semanticFixtureSha256) || !isHash(report.upgradeProtocolSha256)
    || !matchRuntimeUpgradeFingerprints(report.runtimeFingerprint, report.runtimeFingerprint, []).available) issues.push('report_binding_unavailable');
  for (const name of runtimeUpgradeScenarios) {
    const scenario = report.scenarios[name];
    if (scenario?.processConditions?.kind !== 'owned-process-tree' || scenario.runs?.length !== 3
      || scenario.startup?.totalRuns !== 3 || scenario.startup.successfulRuns !== 3) {
      issues.push(`${name}:launches_unavailable`); continue;
    }
    for (const [index, run] of scenario.runs.entries()) {
      const label = `${name}:${index}`;
      if (run.generation !== report.fixtureGeneration || run.scenario !== name
        || run.status !== 'completed' || run.failed || run.error || run.sourceCohort?.valid !== true
        || !Array.isArray(run.cleanup?.cleanupFailures) || run.cleanup.cleanupFailures.length
        || !isHash(run.observationSha256)) issues.push(`${label}:arm_evidence_unavailable`);
      if (name === 'idle' ? scenario.kind !== 'idle-observation' || run.completedOperations !== 0 || run.submittedOperations !== 0
        : !Number.isSafeInteger(run.completedOperations) || run.completedOperations < 100
          || !isHash(run.completedOperationReceiptsSha256)) issues.push(`${label}:operation_evidence_unavailable`);
      if (!validMetric(run.durationMs) || run.durationMs === 0) issues.push(`${label}:duration_unavailable`);
      if (name !== 'idle' && (!Array.isArray(run.receipts) || run.receipts.length !== run.completedOperations)) issues.push(`${label}:raw_receipts_unavailable`);
      if (name !== 'idle') {
        const rate = run.metrics?.completedOperationsPerSecond, expected = run.completedOperations / (run.durationMs / 1000);
        if (!validMetric(rate) || rate <= 0 || Math.abs(rate - expected) > Number.EPSILON * Math.max(1, expected) * 4) issues.push(`${label}:throughput_duration_mismatch`);
      }
      const start = Date.parse(run.hostConditions?.before?.observedAt), end = Date.parse(run.hostConditions?.after?.observedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) issues.push(`${label}:chronology_unavailable`);
      const resource = run.resource;
      if (!Array.isArray(resource?.failures) || resource.failures.length || !Array.isArray(resource.exitedBeforeSample)
        || resource.exitedBeforeSample.some(row => !validIdentity(row))
        || !Array.isArray(resource.samples) || !resource.samples.length || run.sampleCount !== resource.samples.length
        || !Array.isArray(resource.processOwnership?.observedProcesses)
        || resource.processOwnership.observedProcesses.some(row => !validIdentity(row))) {
        issues.push(`${label}:sampling_coverage_unavailable`); continue;
      }
      const sampled = new Set(), observed = new Set(resource.processOwnership.observedProcesses.map(identity));
      for (const sample of resource.samples) {
        if (!Array.isArray(sample?.processes) || sample.processes.some(row => !validIdentity(row)
          || !validMetric(row.cpuMs) || !validMetric(row.rssMiB))) issues.push(`${label}:sampling_coverage_unavailable`);
        else for (const row of sample.processes) {
          sampled.add(identity(row));
          if (!observed.has(identity(row))) issues.push(`${label}:sampling_identity_unknown`);
        }
      }
      if (!Number.isSafeInteger(run.metrics?.sampledProcessIdentities) || run.metrics.sampledProcessIdentities < 1 || run.metrics.sampledProcessIdentities !== sampled.size) {
        issues.push(`${label}:process_count_unavailable`);
      }
      const writers = Array.isArray(run.receipts) ? run.receipts.flatMap(receipt => receipt.toolProofs ?? []).filter(tool => tool.ledger) : [];
      if (writers?.length) {
        const coverage = resource.receiptProcessIdentities;
        const tokens = new Set(writers.map(tool => tool.ledger.token));
        if (coverage?.status !== 'observed' || !Array.isArray(coverage.identities)
          || coverage.required !== tokens.size || coverage.observed !== tokens.size
          || !Array.isArray(coverage.unavailable) || coverage.unavailable.length
          || coverage.identities.length !== tokens.size
          || new Set(coverage.identities.map(identity)).size !== tokens.size
          || coverage.identities.some(row => !validIdentity(row) || !sampled.has(identity(row)) || !tokens.has(row.receiptToken))
          || writers.some(tool => typeof tool.ledger.token !== 'string' || !tool.ledger.token
            || coverage.identities.filter(row => row.receiptToken === tool.ledger.token).length !== 1)) {
          issues.push(`${label}:receipt_process_sampling_unavailable`);
        }
      }
      for (const key of applicableMetrics(name)) if (!validMetric(metricValue(run, key))) issues.push(`${label}:${key}_unavailable`);
    }
  }
  return [...new Set(issues)];
}

const allRuns = report => runtimeUpgradeScenarios.flatMap(name => report.scenarios[name].runs);
const quantum = (key, count, clock) => key === 'sampledDescendantCpuMs' ? 10 * count
  : key === 'hostCpuMs' ? .001 : key.includes('TreeRss') ? (count + 1) / 1024 : key === 'hostLoopP95Ms' ? .000001
      : key === 'burstMedianMs' ? 1 : key === 'throughputCostMs' ? clock / 100 : clock;
const idleBudget = (key, count) => key === 'hostCpuMs' || key === 'hostLoopP95Ms' ? 20
  : key === 'sampledDescendantCpuMs' ? 20 * count : key.includes('RssMiB') ? 1 : null;
const inconclusive = reasons => ({ status: 'inconclusive', reasons, scope: 'No Stage E nonregression qualification' });

export function freezeRuntimeUpgradePolicy(calibration, { frozenAt, frozenInputs, monotonicPrecisionMs, configurationDelta = [], runtimePluginMigrations = [] } = {}) {
  const issues = policyReportIssues(calibration);
  if (calibration?.environmentEvidence?.platform !== 'darwin') issues.push('ps_counter_precision_unqualified_for_platform');
  if (calibration?.fixtureGeneration !== 2) issues.push('independent_generation_2_calibration_required');
  if (!frozenInputs?.baselineArmID || !frozenInputs?.candidateArmID || frozenInputs.baselineArmID === frozenInputs.candidateArmID
    || calibration?.comparisonArm?.id !== frozenInputs.baselineArmID
    || calibration?.comparisonArm?.configurationSha256 !== frozenInputs.baselineConfigurationSha256) issues.push('explicit_arm_binding_required');
  if (!frozenKeys.every(key => isHash(frozenInputs?.[key])) || !validMetric(monotonicPrecisionMs)
    || monotonicPrecisionMs === 0) issues.push('freeze_inputs_or_clock_precision_unavailable');
  if (frozenInputs?.comparisonDeclarationSha256 !== digest({ configurationDelta, runtimePluginMigrations })) issues.push('comparison_declaration_not_frozen');
  if (issues.length) return inconclusive(issues);
  const runs = allRuns(calibration), freezeTime = Date.parse(frozenAt);
  const chronology = runs.map(run => [Date.parse(run.hostConditions.before.observedAt), Date.parse(run.hostConditions.after.observedAt)]).sort((a, b) => a[0] - b[0]);
  if (!Number.isFinite(freezeTime) || chronology.some((row, index) => row[1] >= freezeTime || index > 0 && row[0] < chronology[index - 1][1])) {
    return inconclusive(['calibration_must_finish_sequentially_before_freeze']);
  }
  if (frozenInputs.baselineSourceSha256 !== calibration.executionEvidence.sourceSha256
    || frozenInputs.environmentSha256 !== calibration.environmentSha256 || frozenInputs.upgradeProtocolSha256 !== calibration.upgradeProtocolSha256) {
    return inconclusive(['calibration_freeze_binding_mismatch']);
  }
  const bands = {};
  for (const name of runtimeUpgradeScenarios) {
    const rows = calibration.scenarios[name].runs, count = Math.max(...rows.map(run => run.metrics.sampledProcessIdentities));
    bands[name] = { sampledProcessIdentityCeiling: count, metrics: {} };
    for (const key of applicableMetrics(name)) {
      const values = rows.map(run => metricValue(run, key)), B = median(values), R = Math.max(...values) - Math.min(...values);
      const q = quantum(key, count, monotonicPrecisionMs), absolute = name === 'idle' ? idleBudget(key, count) : null;
      const nearZero = absolute !== null && B <= absolute;
      const A = nearZero ? absolute : Math.max(.05 * B, R + 2 * q);
      if (nearZero ? R > A / 2 : A > .10 * B) issues.push(`${name}:${key}:calibration_too_noisy_or_unresolved`);
      bands[name].metrics[key] = { baselineMedian: B, calibrationRange: R, quantum: q, allowance: A,
        baselineDrift: Math.max(R, 2 * q), mode: nearZero ? 'absolute-idle-budget' : 'relative' };
    }
  }
  if (issues.length) return inconclusive(issues);
  const policy = { schema: 1, status: 'frozen', frozenAt, frozenInputs, monotonicPrecisionMs,
    calibrationSha256: digest(calibration), calibrationRunSha256: runs.map(digest),
    baselineArtifactSha256: calibration.executionEvidence.artifactSha256,
    semanticFixtureSha256: calibration.semanticFixtureSha256, runtimeFingerprint: calibration.runtimeFingerprint,
    conditions: Object.fromEntries(['startupMode', 'warmupMs', 'measureMs', 'sampleIntervalMs'].map(key => [key, calibration[key]])),
    processConditions: Object.fromEntries(runtimeUpgradeScenarios.map(name => [name, calibration.scenarios[name].processConditions])),
    configurationDelta, runtimePluginMigrations,
    pairedOrder: [['baseline', 'candidate'], ['candidate', 'baseline'], ['baseline', 'candidate']], bands,
    scope: 'Headless observed process resources and receipt-backed local operation latency; no complete CPU census, UI or paid-provider claim' };
  return { ...policy, policySha256: digest(policy) };
}

export function gradeRuntimeUpgradePolicy(policy, baseline, candidate, { frozenInputs, runtimePluginMigrations = [] } = {}) {
  if (policy?.status !== 'frozen' || !isHash(policy.policySha256)) return inconclusive(['frozen_policy_required']);
  const { policySha256, ...body } = policy;
  if (digest(body) !== policySha256 || !same(frozenInputs, policy.frozenInputs)) return inconclusive(['frozen_policy_or_inputs_changed']);
  let descriptive;
  try {
    if (!same(runtimePluginMigrations, policy.runtimePluginMigrations)) throw new Error('Comparison declaration changed');
    descriptive = compareRuntimeUpgradeSummaries(baseline, candidate, { configurationDelta: policy.configurationDelta, runtimePluginMigrations });
  }
  catch { return inconclusive(['paired_comparison_contract_mismatch']); }
  const issues = [...policyReportIssues(baseline), ...policyReportIssues(candidate)];
  if (descriptive.status !== 'compared') issues.push('complete_paired_comparison_required');
  if (issues.length) return inconclusive([...new Set(issues)]);
  if (baseline.comparisonArm.id !== frozenInputs.baselineArmID || candidate.comparisonArm.id !== frozenInputs.candidateArmID
    || baseline.comparisonArm.configurationSha256 !== frozenInputs.baselineConfigurationSha256
    || candidate.comparisonArm.configurationSha256 !== frozenInputs.candidateConfigurationSha256
    || baseline.executionEvidence.artifactSha256 !== policy.baselineArtifactSha256
    || baseline.executionEvidence.sourceSha256 !== frozenInputs.baselineSourceSha256
    || candidate.executionEvidence.sourceSha256 !== frozenInputs.candidateSourceSha256
    || candidate.executionEvidence.artifactSha256 !== frozenInputs.candidateArtifactSha256
    || baseline.environmentSha256 !== frozenInputs.environmentSha256 || baseline.upgradeProtocolSha256 !== frozenInputs.upgradeProtocolSha256
    || baseline.semanticFixtureSha256 !== policy.semanticFixtureSha256 || !same(baseline.runtimeFingerprint, policy.runtimeFingerprint)
    || !same(Object.fromEntries(Object.keys(policy.conditions).map(key => [key, baseline[key]])), policy.conditions)) {
    return inconclusive(['paired_freeze_binding_mismatch']);
  }
  const freezeTime = Date.parse(policy.frozenAt), measured = [], regressions = [];
  const orderedArms = [...allRuns(baseline), ...allRuns(candidate)].map(run => [Date.parse(run.hostConditions.before.observedAt), Date.parse(run.hostConditions.after.observedAt)]).sort((a, b) => a[0] - b[0]);
  if (orderedArms.some((row, index) => index > 0 && row[0] < orderedArms[index - 1][1])) issues.push('paired_arms_overlap');
  for (const name of runtimeUpgradeScenarios) {
    const left = baseline.scenarios[name], right = candidate.scenarios[name], band = policy.bands[name];
    if (!same(left.processConditions, policy.processConditions[name])) issues.push(`${name}:process_conditions_changed`);
    const chronology = [];
    for (let index = 0; index < 3; index++) {
      const pair = [left.runs[index], right.runs[index]];
      if (policy.pairedOrder[index][0] === 'candidate') pair.reverse();
      for (const run of pair) {
        const start = Date.parse(run.hostConditions.before.observedAt), end = Date.parse(run.hostConditions.after.observedAt);
        if (start <= freezeTime || chronology.length && start < chronology.at(-1)) issues.push(`${name}:pair_order_or_freeze_time_mismatch`);
        chronology.push(end);
        if (policy.calibrationRunSha256.includes(digest(run))) issues.push(`${name}:calibration_arm_reused`);
        if (run.metrics.sampledProcessIdentities > band.sampledProcessIdentityCeiling) issues.push(`${name}:process_identity_ceiling_exceeded`);
      }
    }
    for (const [key, rule] of Object.entries(band.metrics)) {
      const before = left.runs.map(run => metricValue(run, key)), after = right.runs.map(run => metricValue(run, key));
      const beforeMedian = median(before), afterMedian = median(after), deltas = after.map((value, index) => value - before[index]);
      if ([...before, beforeMedian].some(value => Math.abs(value - rule.baselineMedian) > rule.baselineDrift)) issues.push(`${name}:${key}:baseline_drift`);
      const regressed = afterMedian - rule.baselineMedian > rule.allowance || deltas.some(value => value > rule.allowance);
      if (regressed) regressions.push(`${name}:${key}`);
      measured.push({ scenario: name, metric: key, calibrationMedian: rule.baselineMedian, baselineMedian: beforeMedian, candidateMedian: afterMedian,
        adjacentDeltas: deltas, allowance: rule.allowance, regressed });
    }
  }
  return { status: issues.length ? 'inconclusive' : regressions.length ? 'regressed' : 'nonregressing',
    reasons: [...new Set(issues)], regressions, policySha256, calibrationSha256: policy.calibrationSha256,
    baselineSha256: digest(baseline), candidateSha256: digest(candidate), measured, descriptive, scope: policy.scope };
}
