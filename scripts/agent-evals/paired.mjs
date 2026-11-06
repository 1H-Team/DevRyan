import { createHash } from 'node:crypto';
import { buildSchemaV1Report, writeSchemaV1Report } from './report.mjs';
import { assertFixtureReady } from './fixture.mjs';
import { DEFAULT_NON_INFERIORITY_MARGIN, normalizeRuntimePluginMigrations } from './config.mjs';

// Waste-reduction factors succeed only when the target metric fell; the
// `runtime` factor succeeds only when the candidate runtime is non-inferior.
export const pairedSuccessVerdict = (factor) => factor === 'runtime' ? 'non-inferior' : 'canary-eligible';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprintOf = (run) => run.harness?.finishFingerprint ?? run.harness?.startFingerprint;
const experimentalFactor = (fingerprint, factor) => {
  if (factor === 'role') return fingerprint?.role?.contentHash;
  if (factor === 'runtime') return fingerprint?.runtimeVersion;
  return fingerprint?.policies?.[factor];
};

// Harness policy factors are promoted only through the Balanced gate.
export const HARNESS_POLICY_FACTORS = Object.freeze(['readOverlap', 'waitAny', 'compactResults', 'contextProjection', 'adaptiveDelegation']);
// Tools whose advertised schema each policy factor is declared to change
// (`createManagedTaskInputSchema` adds wait_any and checkpoint actions). Every
// other tool keeps its exact content hash across the arms.
export const FACTOR_CAPABILITY_SCHEMA_DELTAS = Object.freeze({ readOverlap: Object.freeze([]), waitAny: Object.freeze(['devryan_task']),
  compactResults: Object.freeze([]), contextProjection: Object.freeze(['devryan_task']), adaptiveDelegation: Object.freeze([]) });
const BALANCED_METRICS = Object.freeze(['objectiveDurationMs', 'input', 'output']);
// Missing evidence, a missing prerequisite or a confound holds promotion; a
// clean measured comparison that misses a criterion fails it.
const HOLD_REASONS = new Set(['trial_incomplete', 'insufficient_pairs', 'measurement_unavailable', 'usage_unattributable',
  'prerequisite_unavailable', 'cleanup_incomplete', 'fingerprint_unavailable', 'switches_unavailable', 'switches_changed_during_run',
  'switches_mismatch', 'policy_source_unattested', 'role_attestation_mismatch', 'configuration_mismatch', 'experimental_factor_unchanged',
  'fixture_mismatch', 'environment_mismatch', 'selection_mismatch', 'case_membership_mismatch', 'model_trials_required', 'expansion_required',
  'arm_unattested']);
const PREREQUISITE_ERRORS = new Set(['evaluation_model_unavailable', 'evaluation_managed_unavailable']);

// The behaviour switches a fingerprint carries; null unless complete and enum-valued.
const switchesOf = (fingerprint) => {
  const value = fingerprint?.switches;
  if (!object(value)) return null;
  const names = Object.keys(value).sort();
  return names.length && names.every(name => /^DEVRYAN_[A-Z0-9_]+$/.test(name) && typeof value[name] === 'string'
    && /^(?:unset|0|1|true|false|on|off|yes|no|other)$/.test(value[name])) ? Object.fromEntries(names.map(name => [name, value[name]])) : null;
};
// The catalog identity a factor must preserve: the whole catalog, or every
// tool outside the factor's declared capability-schema delta plus the id set.
const catalogIdentity = (value, factor) => {
  const declared = FACTOR_CAPABILITY_SCHEMA_DELTAS[factor];
  if (!declared?.length) return value.catalog.contentHash;
  const tools = value.catalog.tools;
  if (!hash(value.catalog.idsHash) || !Array.isArray(tools) || !tools.length
    || tools.some(tool => typeof tool?.id !== 'string' || !tool.id || !hash(tool.contentHash))
    || new Set(tools.map(tool => tool.id)).size !== tools.length) return null;
  return digest({ idsHash: value.catalog.idsHash, declaredDelta: declared, tools: tools.filter(tool => !declared.includes(tool.id))
    .map(({ id, contentHash }) => ({ id, contentHash })).sort((a, b) => a.id.localeCompare(b.id)) });
};
const matchedFingerprint = (run, factor, migrations, side) => {
  const value = fingerprintOf(run);
  if (!value || typeof value.runtimeVersion !== 'string' || !value.runtimeVersion || value.runtimeVersion === 'unknown'
    || !hash(value.role?.contentHash) || !hash(value.catalog?.contentHash)
    || !value.selection || typeof value.selection !== 'object' || Array.isArray(value.selection)
    || !value.policies || typeof value.policies !== 'object' || Array.isArray(value.policies)
    || !Array.isArray(value.plugins?.observed) || !value.plugins.observed.length
    || value.plugins.observed.some((entry) => typeof entry.name !== 'string' || !entry.name || !hash(entry.contentHash))
    || new Set(value.plugins.observed.map(entry => entry.name)).size !== value.plugins.observed.length) return null;
  // Only an explicitly declared, exact per-side migration hash is normalized.
  // Every other plugin retains its content identity across runtime versions.
  const runtime = factor === 'runtime';
  const policyFactor = HARNESS_POLICY_FACTORS.includes(factor);
  // Every factor but `runtime` compares two arms of the same candidate
  // artifact: identical runtime bytes, configured plugins and switches.
  if (!runtime && (!hash(value.runtimeHash) || !Array.isArray(value.plugins.configured)
    || value.plugins.configured.some(entry => typeof entry?.name !== 'string' || !entry.name) || !switchesOf(value))) return null;
  // A policy factor's role identity is its derivation: the unrendered
  // template and renderer. The rendered hash is checked per arm against the
  // host's attested render for that arm's policies (see derivationIssues).
  if (policyFactor && (!hash(value.role.templateHash) || !hash(value.role.rendererHash) || !hash(value.role.attestedContentHash))) return null;
  const catalogHash = policyFactor ? catalogIdentity(value, factor) : value.catalog.contentHash;
  if (catalogHash === null) return null;
  return digest({ runtimeVersion: runtime ? 'experimental' : value.runtimeVersion, selection: value.selection,
    roleHash: factor === 'role' ? 'experimental' : policyFactor
      ? { templateHash: value.role.templateHash, rendererHash: value.role.rendererHash } : value.role.contentHash,
    catalogHash,
    plugins: value.plugins.observed.map(({ name, contentHash }) => {
      const migration = runtime ? migrations.find(entry => entry.name === name && entry[`${side}Hash`] === contentHash) : null;
      return { name, contentHash: migration ? `declared-migration:${digest(migration)}` : contentHash };
    })
      .sort((a, b) => a.name.localeCompare(b.name)),
    policies: Object.fromEntries(Object.entries(value.policies).filter(([key]) => key !== factor).sort(([a], [b]) => a.localeCompare(b))),
    // Configured plugin names in load order; source path hashes are host-local.
    ...(runtime ? {} : { runtimeHash: value.runtimeHash, configuredPlugins: value.plugins.configured.map(entry => entry.name),
      switches: switchesOf(value) }),
  });
};
// Per-arm derivation checks a digest cannot express.
const derivationIssues = (run, factor) => {
  const issues = [];
  if (factor === 'runtime') return issues;
  const start = switchesOf(run.harness?.startFingerprint), finish = switchesOf(run.harness?.finishFingerprint);
  // Some switches are read lazily: the run must start and finish under the same values.
  if (!start || !finish) issues.push('switches_unavailable');
  else if (digest(start) !== digest(finish)) issues.push('switches_changed_during_run');
  if (!HARNESS_POLICY_FACTORS.includes(factor)) return issues;
  const value = fingerprintOf(run);
  if (value?.policySource !== 'runtime-projection') issues.push('policy_source_unattested');
  if (!hash(value?.role?.attestedContentHash) || value.role.attestedContentHash !== value.role.contentHash) issues.push('role_attestation_mismatch');
  return issues;
};
// The evaluated root's measurements. Strict attribution names that root,
// requires every other root to carry no usage and every recorded helper call
// to have a usage record; anything else is unattributable, never dropped.
const attributedRoot = (run, strict) => {
  const evidence = run.harness?.evidence;
  if (!evidence || evidence.incomplete || !Array.isArray(evidence.roots)) return { reason: 'measurement_unavailable' };
  if (!strict) return evidence.roots.length === 1 ? { root: evidence.roots[0] } : { reason: 'measurement_unavailable' };
  const roots = evidence.roots;
  const primary = evidence.rootSessionId ? roots.filter(root => root.rootSessionId === evidence.rootSessionId)
    : roots.length === 1 ? roots : [];
  if (primary.length !== 1) return { reason: roots.length > 1 ? 'usage_unattributable' : 'measurement_unavailable' };
  const [root] = primary;
  const spends = entry => ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => (entry.usage?.[key]?.observed ?? 0) > 0
    || (entry.usage?.[key]?.unknown ?? 0) > 0);
  if (roots.some(entry => entry !== root && spends(entry))
    || evidence.attribution?.unattributedHelperUsage !== 0 || root.attribution?.unattributedHelperCalls !== 0) return { reason: 'usage_unattributable' };
  return { root };
};
const metric = (run, target, strict = false) => {
  const { root, reason } = attributedRoot(run, strict);
  if (!root) return { value: null, reason };
  if (target === 'objectiveDurationMs') return Number.isFinite(root.objectiveDurationMs)
    ? { value: root.objectiveDurationMs, reason: null } : { value: null, reason: 'measurement_unavailable' };
  const value = target === 'input' || target === 'output' ? root.usage?.[target] : root[target];
  return value?.observed > 0 && value.unknown === 0 && Number.isFinite(value.total)
    ? { value: value.total, reason: null } : { value: null, reason: 'measurement_unavailable' };
};

// Balanced acceptance: both arms correct, aggregate objective duration lower,
// and aggregate input and output tokens each no higher than the baseline.
const balancedGate = ({ cases, reasons, required, disagreement, requiredPairs }) => {
  const totals = Object.fromEntries(BALANCED_METRICS.map(key => {
    const complete = cases.length > 0 && cases.every(entry => entry.balanced[key].baseline !== null && entry.balanced[key].candidate !== null);
    const baselineTotal = complete ? cases.reduce((sum, entry) => sum + entry.balanced[key].baseline, 0) : null;
    const candidateTotal = complete ? cases.reduce((sum, entry) => sum + entry.balanced[key].candidate, 0) : null;
    const passed = complete ? key === 'objectiveDurationMs' ? candidateTotal < baselineTotal : candidateTotal <= baselineTotal : null;
    return [key, { rule: key === 'objectiveDurationMs' ? 'candidate < baseline' : 'candidate <= baseline', baselineTotal, candidateTotal,
      delta: complete ? candidateTotal - baselineTotal : null, ratio: complete && baselineTotal > 0 ? candidateTotal / baselineTotal : null, passed }];
  }));
  const gate = new Set([...reasons].filter(reason => HOLD_REASONS.has(reason) || reason === 'outcome_failed'));
  if (disagreement && requiredPairs < 10) gate.add('expansion_required');
  if (totals.objectiveDurationMs.passed === false) gate.add('duration_not_lower');
  if (totals.input.passed === false) gate.add('input_tokens_higher');
  if (totals.output.passed === false) gate.add('output_tokens_higher');
  const held = [...gate].some(reason => HOLD_REASONS.has(reason));
  return { name: 'balanced', required, status: held ? 'held' : gate.size ? 'failed' : 'passed', reasons: [...gate].sort(),
    outcomes: { cases: cases.length, baselinePassed: cases.filter(entry => entry.baselineStatus === 'passed').length,
      candidatePassed: cases.filter(entry => entry.candidateStatus === 'passed').length,
      disagreements: cases.filter(entry => entry.baselineStatus !== entry.candidateStatus).length },
    metrics: totals };
};

// Resource comparisons use the same strict observed configuration contract as
// live paired trials. Only declared per-side plugin hashes may differ.
export const matchRuntimeUpgradeFingerprints = (baseline, candidate, runtimePluginMigrations = []) => {
  const migrations = normalizeRuntimePluginMigrations(runtimePluginMigrations);
  const run = fingerprint => ({ harness: { finishFingerprint: fingerprint } });
  const left = matchedFingerprint(run(baseline), 'runtime', migrations, 'baseline');
  const right = matchedFingerprint(run(candidate), 'runtime', migrations, 'candidate');
  const declared = migrations.every(entry => [baseline, candidate].every((fingerprint, index) => (
    fingerprint?.plugins?.observed?.filter(plugin => plugin.name === entry.name
      && plugin.contentHash === entry[index === 0 ? 'baselineHash' : 'candidateHash']).length === 1
  )));
  return { available: left !== null && right !== null, matched: left !== null && left === right && declared,
    changedRuntime: typeof baseline?.runtimeVersion === 'string' && baseline.runtimeVersion !== candidate?.runtimeVersion };
};

export const comparePairedReports = ({ pairs, factor, targetMetric, requiredPairs = 3,
  nonInferiorityMargin = DEFAULT_NON_INFERIORITY_MARGIN, runtimePluginMigrations }) => {
  const runtime = factor === 'runtime';
  if (!runtime && runtimePluginMigrations !== undefined) throw Object.assign(new Error('Plugin migrations are only valid with factor runtime'), { code: 'evaluation_pair_mismatch' });
  const migrations = normalizeRuntimePluginMigrations(runtimePluginMigrations);
  if (runtime && (typeof nonInferiorityMargin !== 'number' || !Number.isFinite(nonInferiorityMargin)
    || nonInferiorityMargin < 0 || nonInferiorityMargin > 1)) {
    throw Object.assign(new RangeError('Runtime non-inferiority margin must be a number from 0 through 1'), { code: 'evaluation_pair_mismatch' });
  }
  const cases = [], reasons = new Set();
  const policyFactor = HARNESS_POLICY_FACTORS.includes(factor);
  let disagreement = false, unavailable = false, candidateRegressed = false;
  for (const pair of pairs) {
    const baseline = pair.baseline, candidate = pair.candidate;
    if (!baseline || !candidate) { reasons.add('trial_incomplete'); continue; }
    if (baseline.executionMode !== 'live' || candidate.executionMode !== 'live') reasons.add('model_trials_required');
    if (!hash(baseline.fixtureHash) || baseline.fixtureHash !== candidate.fixtureHash) reasons.add('fixture_mismatch');
    if (!hash(baseline.environmentHash) || baseline.environmentHash !== candidate.environmentHash) reasons.add('environment_mismatch');
    if (digest(baseline.selection) !== digest(candidate.selection)) reasons.add('selection_mismatch');
    if (!baseline.cleanup?.restored || !candidate.cleanup?.restored) reasons.add('cleanup_incomplete');
    const ids = new Set([...(baseline.runs ?? []).map((r) => r.caseId), ...(candidate.runs ?? []).map((r) => r.caseId)]);
    for (const caseId of ids) {
      const a = baseline.runs?.filter((r) => r.caseId === caseId), b = candidate.runs?.filter((r) => r.caseId === caseId);
      if (a?.length !== 1 || b?.length !== 1) { reasons.add('case_membership_mismatch'); continue; }
      const left = a[0], right = b[0];
      const factorA = experimentalFactor(fingerprintOf(left), factor);
      const factorB = experimentalFactor(fingerprintOf(right), factor);
      if (factorA === undefined || factorB === undefined || factorA === factorB) reasons.add('experimental_factor_unchanged');
      const matchA = matchedFingerprint(left, factor, migrations, 'baseline'), matchB = matchedFingerprint(right, factor, migrations, 'candidate');
      const migrationsMatch = migrations.every(entry => ['baseline', 'candidate'].every(side => {
        const plugins = fingerprintOf(side === 'baseline' ? left : right)?.plugins?.observed;
        return plugins?.filter(plugin => plugin.name === entry.name && plugin.contentHash === entry[`${side}Hash`]).length === 1;
      }));
      const matched = matchA !== null && matchA === matchB && migrationsMatch;
      if (!matched) reasons.add(matchA === null || matchB === null ? 'fingerprint_unavailable' : 'configuration_mismatch');
      const issues = [...new Set([...derivationIssues(left, factor), ...derivationIssues(right, factor)])];
      for (const issue of issues) reasons.add(issue);
      // A held run (its delegation arm was not attested) is no outcome: it
      // holds the comparison and is never counted as agreement or regression.
      const held = left.status === 'held' || right.status === 'held';
      if (held) reasons.add('arm_unattested');
      const outcomeAgreement = left.status === right.status;
      if (!held && !outcomeAgreement) { disagreement = true; reasons.add('outcome_disagreement'); }
      if (left.status === 'passed' && right.status !== 'passed' && right.status !== 'held') candidateRegressed = true;
      if ([left.status, right.status].some(status => status !== 'passed' && status !== 'held')) reasons.add('outcome_failed');
      if ([left.errorCode, right.errorCode].includes('evaluation_model_unavailable')) unavailable = true;
      if (!runtime && [left.errorCode, right.errorCode].some(code => PREREQUISITE_ERRORS.has(code))) reasons.add('prerequisite_unavailable');
      // Non-runtime factors compare one candidate artifact and need complete attribution.
      const strict = !runtime;
      const before = metric(left, targetMetric, strict), after = metric(right, targetMetric, strict);
      for (const reason of [before.reason, after.reason]) if (reason) reasons.add(reason);
      const balanced = runtime ? null : Object.fromEntries(BALANCED_METRICS.map(key => {
        const a = metric(left, key, true), b = metric(right, key, true);
        for (const reason of [a.reason, b.reason]) if (reason && policyFactor) reasons.add(reason);
        return [key, { baseline: a.value, candidate: b.value }];
      }));
      cases.push({ pair: pair.index, caseId, order: pair.order, matched, matchHash: matched ? matchA : null,
        baselineFactor: factorA ?? null, candidateFactor: factorB ?? null, derivationIssues: issues,
        baselineStatus: left.status, candidateStatus: right.status, baseline: before.value, candidate: after.value,
        delta: before.value === null || after.value === null ? null : after.value - before.value, ...(balanced ? { balanced } : {}) });
    }
  }
  if (pairs.length < requiredPairs || cases.length === 0) reasons.add('insufficient_pairs');
  const measured = cases.filter((entry) => entry.delta !== null);
  const expansion = { expansionRequired: disagreement && requiredPairs < 10,
    nextRequiredPairs: disagreement && requiredPairs < 10 ? 10 : requiredPairs };
  if (runtime) {
    // A runtime candidate is compared for non-inferiority, never for a
    // reduction: its measured total may exceed the baseline by the margin.
    const baselineTotal = measured.length ? measured.reduce((sum, entry) => sum + entry.baseline, 0) : null;
    const candidateTotal = measured.length ? measured.reduce((sum, entry) => sum + entry.candidate, 0) : null;
    if (measured.length && candidateTotal > baselineTotal * (1 + nonInferiorityMargin)) reasons.add('candidate_metric_worse');
    // `inferior` is a real regression on a clean comparison. A pair that was
    // mis-configured or unmeasured cannot prove one, so confounders keep the
    // verdict at `inconclusive` even when the candidate also looks worse.
    const confounded = ['configuration_mismatch', 'fingerprint_unavailable', 'experimental_factor_unchanged', 'fixture_mismatch',
      'environment_mismatch', 'selection_mismatch', 'case_membership_mismatch', 'cleanup_incomplete', 'model_trials_required']
      .some((reason) => reasons.has(reason));
    const inferior = !confounded && (candidateRegressed || reasons.has('candidate_metric_worse'));
    return { schemaVersion: 1, factor, targetMetric, completedPairs: pairs.length, requiredPairs,
      runtimePluginMigrations: migrations,
      verdict: unavailable ? 'unavailable' : reasons.size === 0 ? 'non-inferior' : inferior ? 'inferior' : 'inconclusive',
      reasons: [...reasons].sort(), ...expansion, margin: nonInferiorityMargin, baselineTotal, candidateTotal,
      ratio: baselineTotal === null || candidateTotal === null || baselineTotal <= 0 ? null : candidateTotal / baselineTotal, cases };
  }
  // A small pilot is evidence for this canary only. A regression or missing
  // measurement never becomes a speed claim or a default-policy promotion.
  if (measured.length && measured.reduce((sum, entry) => sum + entry.delta, 0) >= 0) reasons.add('target_waste_not_reduced');
  // A policy factor additionally passes only through the Balanced gate; other
  // factors report it without gating on it.
  const balanced = balancedGate({ cases, reasons, required: policyFactor, disagreement, requiredPairs });
  if (policyFactor) for (const reason of balanced.reasons) if (reason !== 'expansion_required') reasons.add(reason);
  const eligible = reasons.size === 0 && (!policyFactor || balanced.status === 'passed');
  return { schemaVersion: 1, factor, targetMetric, completedPairs: pairs.length, requiredPairs,
    verdict: unavailable ? 'unavailable' : eligible ? 'canary-eligible' : 'inconclusive',
    reasons: [...reasons].sort(), ...expansion, balanced, cases };
};

export const runPairedEvaluation = async (candidate, dependencies) => {
  const baseline = candidate.pairing.baseline;
  const equivalent = (config) => ({ providerId: config.providerId, modelId: config.modelId, agent: config.agent,
    variant: config.variant, caseIds: config.caseIds, timeoutMs: config.timeoutMs });
  if (digest(equivalent(baseline)) !== digest(equivalent(candidate)) || baseline.repetitions !== 1 || candidate.repetitions !== 1) {
    throw Object.assign(new Error('Paired trials require the same selection, tasks and timeout, with one repetition per trial'), { code: 'evaluation_pair_mismatch' });
  }
  // Both fixtures are checked before any session or report write.
  assertFixtureReady(baseline.fixtureRoot); assertFixtureReady(candidate.fixtureRoot);
  const pairs = [], results = [];
  const execute = async (config, side, index) => {
    let result;
    try { result = await dependencies.runSingle({ ...config, pairing: undefined }); }
    catch (error) { if (!error.report) throw error; result = { report: error.report }; }
    results.push({ caseId: `pair-${index}-${side}`, repetition: index, status: result.report.aggregates.status,
      graders: [{ id: `pair-${index}-${side}.outcome`, passed: result.report.aggregates.status === 'passed' }] });
    return result.report;
  };
  for (let index = 1; index <= candidate.pairing.pairs; index++) {
    const order = index % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    const pair = { index, order: order.join('-then-') };
    for (const side of order) pair[side] = await execute(side === 'baseline' ? baseline : candidate, side, index);
    pairs.push(pair);
    if ([pair.baseline, pair.candidate].some((report) => !report.cleanup?.restored
      || report.runs?.some((run) => run.errorCode === 'evaluation_model_unavailable'))) break;
  }
  const comparison = comparePairedReports({ pairs, factor: candidate.pairing.factor, targetMetric: candidate.pairing.targetMetric,
    requiredPairs: candidate.pairing.pairs,
    ...(candidate.pairing.factor === 'runtime' ? { nonInferiorityMargin: candidate.pairing.nonInferiorityMargin,
      runtimePluginMigrations: candidate.pairing.runtimePluginMigrations } : {}) });
  const report = buildSchemaV1Report({ runId: dependencies.createRunId(), selection: candidate,
    caseResults: results, executionFailed: comparison.verdict !== pairedSuccessVerdict(candidate.pairing.factor), plannedRuns: candidate.pairing.pairs * 2,
    cleanup: { restored: pairs.every((pair) => pair.baseline.cleanup.restored && pair.candidate.cleanup.restored),
      manifestMatch: pairs.every((pair) => pair.baseline.cleanup.manifestMatch && pair.candidate.cleanup.manifestMatch),
      sessionComplete: pairs.every((pair) => pair.baseline.cleanup.sessionComplete && pair.candidate.cleanup.sessionComplete),
      sessionDiscoveryComplete: pairs.every((pair) => pair.baseline.cleanup.sessionDiscoveryComplete && pair.candidate.cleanup.sessionDiscoveryComplete) } });
  report.comparison = comparison;
  // Keep immutable evidence identifiers for failed and interrupted trials too.
  report.trials = pairs.flatMap((pair) => ['baseline', 'candidate'].map((side) => ({ pair: pair.index, side,
    runId: pair[side].runId, reportHash: digest(pair[side]), status: pair[side].aggregates.status })));
  return { report, reportPath: writeSchemaV1Report(candidate.reportDirectory, report) };
};
