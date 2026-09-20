// Separate from performance promotion: correctness smoke does not require an
// arbitrary token/latency improvement. Inputs are independently graded live
// trials; absent/incomplete evidence never qualifies a release profile.
export function gradeDuplicateBehaviorPairs(pairs = []) {
  const reasons = new Set(), counts = { skill: 0, managed: 0 }, seen = new Set(), reports = new Set();
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  let repeatedBefore = 0, callsBefore = 0, repeatedAfter = 0, callsAfter = 0;
  let completedPairs = 0;
  for (const pair of pairs) {
    if (!['skill', 'managed'].includes(pair?.kind) || !Number.isSafeInteger(pair?.index) || seen.has(pair.index)) { reasons.add('invalid-pair'); continue; }
    seen.add(pair.index); counts[pair.kind]++;
    const { baseline, candidate } = pair;
    if (!baseline || !candidate) { reasons.add('incomplete-trial'); continue; }
    if ([baseline, candidate].every(trial => trial.executionMode === 'live' && trial.completed === true
      && trial.cleanupComplete === true && hash(trial.reportHash))) completedPairs++;
    if (baseline.duplicateOutputs !== false || candidate.duplicateOutputs !== true || !(candidate.appliedReductions > 0)) reasons.add('factor-not-observed');
    for (const field of ['fixtureHash', 'environmentHash', 'configurationHash']) {
      // configurationHash is the frozen runtime/route/ordered-plugin identity,
      // excluding only the experimental duplicateOutputs switch.
      if (!hash(baseline[field]) || baseline[field] !== candidate[field]) reasons.add('unmatched-trial');
    }
    for (const trial of [baseline, candidate]) {
      if (reports.has(trial.reportHash)) reasons.add('reused-trial');
      reports.add(trial.reportHash);
      if (trial.executionMode !== 'live' || trial.completed !== true || trial.cleanupComplete !== true || !hash(trial.reportHash)) reasons.add('incomplete-trial');
      if (trial.criticalFailures !== 0 || trial.repeatedMutations !== 0) reasons.add('behavior-failure');
      if (!count(trial.sameKeyRepeatCalls) || !count(trial.eligibleCalls) || trial.eligibleCalls < 1 || trial.sameKeyRepeatCalls > trial.eligibleCalls) reasons.add('repeat-rate-unavailable');
    }
    repeatedBefore += baseline.sameKeyRepeatCalls; callsBefore += baseline.eligibleCalls;
    repeatedAfter += candidate.sameKeyRepeatCalls; callsAfter += candidate.eligibleCalls;
  }
  if (pairs.length !== 10 || counts.skill !== 5 || counts.managed !== 5) reasons.add('ten-matched-pairs-required');
  const before = callsBefore > 0 && Number.isFinite(repeatedBefore) ? repeatedBefore / callsBefore : null;
  const after = callsAfter > 0 && Number.isFinite(repeatedAfter) ? repeatedAfter / callsAfter : null;
  if (before === null || after === null) reasons.add('repeat-rate-unavailable');
  else if (after > before) reasons.add('repeat-rate-increased');
  return { factor: 'duplicateOutputs', kind: 'behavior-smoke', qualified: reasons.size === 0,
    completedPairs, counts, sameKeyRepeatRate: { baseline: before, candidate: after }, reasons: [...reasons].sort(),
    statisticalReliabilityClaim: false };
}
