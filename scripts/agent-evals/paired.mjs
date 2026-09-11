import { createHash } from 'node:crypto';
import { buildSchemaV1Report, writeSchemaV1Report } from './report.mjs';
import { assertFixtureReady } from './fixture.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const matchedFingerprint = (run, factor) => {
  const value = run.harness?.finishFingerprint ?? run.harness?.startFingerprint;
  if (!value || value.runtimeVersion === 'unknown' || !hash(value.role?.contentHash) || !hash(value.catalog?.contentHash)
    || !Array.isArray(value.plugins?.observed) || !value.plugins.observed.length
    || value.plugins.observed.some((entry) => !hash(entry.contentHash))) return null;
  return digest({ runtimeVersion: value.runtimeVersion, selection: value.selection,
    roleHash: factor === 'role' ? 'experimental' : value.role.contentHash, catalogHash: value.catalog.contentHash,
    plugins: value.plugins.observed.map(({ name, contentHash }) => ({ name, contentHash })).sort((a, b) => a.name.localeCompare(b.name)),
    policies: Object.fromEntries(Object.entries(value.policies).filter(([key]) => key !== factor).sort(([a], [b]) => a.localeCompare(b))),
  });
};
const metric = (run, target) => {
  const evidence = run.harness?.evidence;
  if (!evidence || evidence.incomplete || evidence.roots?.length !== 1) return null;
  const root = evidence.roots[0];
  if (target === 'objectiveDurationMs') return Number.isFinite(root.objectiveDurationMs) ? root.objectiveDurationMs : null;
  const value = target === 'input' ? root.usage?.input : root[target];
  return value?.observed > 0 && value.unknown === 0 && Number.isFinite(value.total) ? value.total : null;
};

export const comparePairedReports = ({ pairs, factor, targetMetric, requiredPairs = 3 }) => {
  const cases = [], reasons = new Set();
  let disagreement = false, unavailable = false;
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
      const fingerprintA = left.harness?.finishFingerprint ?? left.harness?.startFingerprint;
      const fingerprintB = right.harness?.finishFingerprint ?? right.harness?.startFingerprint;
      const factorA = factor === 'role' ? fingerprintA?.role?.contentHash : fingerprintA?.policies?.[factor];
      const factorB = factor === 'role' ? fingerprintB?.role?.contentHash : fingerprintB?.policies?.[factor];
      if (factorA === undefined || factorB === undefined || factorA === factorB) reasons.add('experimental_factor_unchanged');
      const matchA = matchedFingerprint(left, factor), matchB = matchedFingerprint(right, factor);
      const matched = matchA !== null && matchA === matchB;
      if (!matched) reasons.add(matchA === null || matchB === null ? 'fingerprint_unavailable' : 'configuration_mismatch');
      const outcomeAgreement = left.status === right.status;
      if (!outcomeAgreement) { disagreement = true; reasons.add('outcome_disagreement'); }
      if (left.status !== 'passed' || right.status !== 'passed') reasons.add('outcome_failed');
      if ([left.errorCode, right.errorCode].includes('evaluation_model_unavailable')) unavailable = true;
      const before = metric(left, targetMetric), after = metric(right, targetMetric);
      if (before === null || after === null) reasons.add('measurement_unavailable');
      cases.push({ pair: pair.index, caseId, order: pair.order, matched, matchHash: matched ? matchA : null,
        baselineFactor: factorA ?? null, candidateFactor: factorB ?? null,
        baselineStatus: left.status, candidateStatus: right.status, baseline: before, candidate: after,
        delta: before === null || after === null ? null : after - before });
    }
  }
  if (pairs.length < requiredPairs || cases.length === 0) reasons.add('insufficient_pairs');
  const measured = cases.filter((entry) => entry.delta !== null);
  // A small pilot is evidence for this canary only. A regression or missing
  // measurement never becomes a speed claim or a default-policy promotion.
  if (measured.length && measured.reduce((sum, entry) => sum + entry.delta, 0) >= 0) reasons.add('target_waste_not_reduced');
  return { schemaVersion: 1, factor, targetMetric, completedPairs: pairs.length, requiredPairs,
    verdict: unavailable ? 'unavailable' : reasons.size === 0 ? 'canary-eligible' : 'inconclusive',
    reasons: [...reasons].sort(), expansionRequired: disagreement && requiredPairs < 10,
    nextRequiredPairs: disagreement && requiredPairs < 10 ? 10 : requiredPairs, cases };
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
    requiredPairs: candidate.pairing.pairs });
  const report = buildSchemaV1Report({ runId: dependencies.createRunId(), selection: candidate,
    caseResults: results, executionFailed: comparison.verdict !== 'canary-eligible', plannedRuns: candidate.pairing.pairs * 2,
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
