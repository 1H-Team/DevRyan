import { normalizeCursorUsage } from '../../packages/cursor-sdk-runtime/cursor-usage.js';

export const cursorUsagePools = ['auto-composer', 'api'];

export function projectCursorQuota(payload, now = Date.now()) {
  if (!payload?.ok || !Number.isFinite(payload.fetchedAt) || payload.fetchedAt > now + 5000
    || now - payload.fetchedAt > 90_000) throw new Error('Cursor quota is unavailable or stale');
  const pools = {};
  for (const id of cursorUsagePools) {
    const value = payload.usage?.windows?.[id];
    if (!Number.isFinite(value?.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) {
      throw new Error(`Cursor quota pool ${id} is unavailable`);
    }
    pools[id] = { usedPercent: value.usedPercent, resetAt: value.resetAt ?? null };
  }
  return { fetchedAt: payload.fetchedAt, pools };
}

export function cursorQuotaDelta(before, after) {
  if (after.fetchedAt <= before.fetchedAt) throw new Error('Quota endpoint must follow the baseline');
  return Object.fromEntries(cursorUsagePools.map(id => {
    const left = before.pools[id], right = after.pools[id];
    if (left.resetAt !== right.resetAt || right.usedPercent < left.usedPercent - 0.000001) {
      throw new Error('Cursor quota reset or correction invalidates this comparison');
    }
    return [id, Math.max(0, right.usedPercent - left.usedPercent)];
  }));
}

export function canReuseCursorQuota(current, now = Date.now(), freshAfter = 0, maxAgeMs = 85_000) {
  return Number.isFinite(current?.fetchedAt) && current.fetchedAt > freshAfter
    && current.fetchedAt <= now + 5000 && now - current.fetchedAt <= maxAgeMs;
}

export function admitCursorWork({ baseline, current, phase = 'exploration', limitPoints = 10, requiredPoints = {}, now = Date.now() }) {
  if (!canReuseCursorQuota(current, now, 0, 90_000)) throw new Error('Cursor quota is stale at admission');
  if (!Number.isFinite(limitPoints) || limitPoints <= 4 || limitPoints > 10) throw new Error('Invalid Cursor study ceiling');
  if (!['exploration', 'verification'].includes(phase)) throw new Error('Invalid study phase');
  const used = cursorQuotaDelta(baseline, current);
  const ceiling = limitPoints - (phase === 'verification' ? 2 : 4);
  for (const id of cursorUsagePools) {
    const required = requiredPoints[id] ?? 0;
    if (!Number.isFinite(required) || required < 0) throw new Error('Invalid Cursor work estimate');
    if (used[id] + required >= ceiling || current.pools[id].usedPercent + required >= 98) {
      throw new Error(`Cursor ${id} budget headroom exhausted`);
    }
  }
  return { used, admissionCeiling: ceiling };
}

export function estimateCursorWorkPoints(attempts, { modelID, arm, workload }) {
  const comparable = attempts.filter(row => row.modelID === modelID && row.workload === workload && row.delta);
  const sameArm = comparable.filter(row => row.arm === arm);
  const rows = sameArm.length ? sameArm : comparable;
  // Include failed attempts. This is an admission forecast, not a substitute
  // for live guards or the two-point reporting reserve. Pilots remain unknown.
  return Object.fromEntries(cursorUsagePools.map(pool => [pool,
    rows.length ? Math.max(...rows.map(row => row.delta[pool])) * 1.25 : 0,
  ]));
}

export function cursorReferenceMatchesAttempt(attempt, current) {
  if (current?.active) return false;
  if (current?.hash === attempt.referenceBefore?.hash) return true;
  // A reviewed journal reconstruction may account for a deleted *completed*
  // chat. Keep the original failed trial and reference; never reset its budget.
  const proof = attempt.referenceReconciliation;
  return proof?.kind === 'completed-session-deletion' && proof.removedWasActive === false
    && proof.beforeHash === attempt.referenceBefore?.hash && proof.afterHash === current?.hash
    && Number.isFinite(proof.deletedAt) && proof.deletedAt >= attempt.startedAt
    && proof.deletedAt <= attempt.completedAt && proof.journalReconstructionVerified === true;
}

export function summarizeCursorRuns(records) {
  const runs = new Map();
  for (const record of records) {
    if (!['run-started', 'run-ended'].includes(record.kind) || !record.agentID || !record.runID) continue;
    const key = `${record.agentID}:${record.runID}`;
    if (record.kind === 'run-ended' || !runs.has(key)) runs.set(key, record);
  }
  const values = [...runs.values()];
  const reported = values.map(row => normalizeCursorUsage(row.usage)).filter(Boolean);
  const usage = reported.length ? Object.fromEntries(
    ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']
      .map(key => [key, reported.reduce((sum, row) => sum + row[key], 0)]),
  ) : null;
  const oneShots = records.filter(row => row.kind === 'one-shot-ended');
  const oneShotReported = oneShots.map(row => normalizeCursorUsage(row.usage)).filter(Boolean);
  const processedInput = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null;
  return {
    runs: values.length, reportedRuns: reported.length, missingUsageRuns: values.length - reported.length,
    sendAttempts: records.filter(row => row.kind === 'send').length,
    runSubmissions: records.filter(row => row.kind === 'run-started').length,
    oneShotSubmissions: records.filter(row => row.kind === 'one-shot-started').length,
    oneShotUsage: { reported: oneShotReported.length,
      unavailable: Math.max(oneShots.length, records.filter(row => row.kind === 'one-shot-started').length) - oneShotReported.length,
      totalTokens: oneShotReported.length ? oneShotReported.reduce((sum, row) => sum + row.totalTokens, 0) : null },
    exposedRequestIDs: new Set(values.map(row => row.requestID).filter(Boolean)).size,
    providerAttemptCount: null, usage, processedInput,
    reasoning: { reportedRuns: reported.filter(row => row.reasoningTokens !== undefined).length,
      tokens: reported.some(row => row.reasoningTokens !== undefined)
        ? reported.reduce((sum, row) => sum + (row.reasoningTokens ?? 0), 0) : null },
    cacheReadRatio: processedInput ? usage.cacheReadTokens / processedInput : null,
    toolCalls: records.filter(row => row.kind === 'tool-started').length,
    createCount: records.filter(row => row.kind === 'agent-create').length,
    resumeCount: records.filter(row => row.kind === 'agent-resume').length,
    failures: values.filter(row => row.status !== 'finished').length,
  };
}

// Shareable projection: no credentials, prompts, native stores, or local paths.
// Matched comparisons and failed-attempt spend are both visible. A missing
// reading never silently becomes zero or disappears from a group average.
export function summarizeCursorStudy(study) {
  const groups = new Map();
  const attempts = study.attempts.map(attempt => {
    const key = `${attempt.modelID}/${attempt.arm}/${attempt.workload}/${attempt.workerHost || 'node'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(attempt);
    return {
      id: attempt.id, modelID: attempt.modelID, arm: attempt.arm,
      repetition: attempt.repetition, workload: attempt.workload, outcome: attempt.outcome,
      workerHost: attempt.workerHost || 'node',
      error: attempt.error ?? null, guardError: attempt.guardError ?? null,
      quotaError: attempt.quotaError ?? null, quotaRecovered: Boolean(attempt.quotaRecovery),
      delta: attempt.delta ?? null, native: attempt.native ?? null,
      estimatedPoints: attempt.estimatedPoints ?? null,
      successfulEditingTurns: attempt.turns.filter(turn => turn.grade?.passed).length,
      elapsedMs: attempt.completedAt ? attempt.completedAt - attempt.startedAt : null,
      workMs: attempt.turns.length ? attempt.turns.reduce((sum, turn) => sum + turn.completedAt - turn.start, 0) : null,
      modelParametersMatched: attempt.modelParametersMatched ?? null,
      idleRunStarts: attempt.idleRunStarts ?? null,
      runtimeSha256: attempt.runtimeSha256 ?? null, observerSha256: attempt.observerSha256 ?? null,
      titleSourceSha256: attempt.titleSourceSha256 ?? null,
      cleanupVerified: attempt.cleanup?.rootObserved === true
        && attempt.cleanup.remainingProcessIds?.length === 0 && attempt.cleanup.observationErrors?.length === 0,
    };
  });
  const sumQuota = rows => Object.fromEntries(cursorUsagePools.map(pool => [pool,
    rows.every(row => Number.isFinite(row.delta?.[pool]))
      ? rows.reduce((sum, row) => sum + row.delta[pool], 0) : null,
  ]));
  return {
    schemaVersion: 1, revision: study.revision, selections: study.selections,
    contextSha256: study.contextSha256, baseline: study.baseline,
    spentPoints: sumQuota(study.attempts),
    limitations: ['SDK counters are not independently verified billing records',
      'Provider request/retry counts and settled billing are unavailable',
      'Pool percentages have independent denominators; do not add them',
      'Failed or guard-invalidated attempts stay in the spend ledger'],
    groups: [...groups.entries()].map(([key, rows]) => {
      const accepted = rows.filter(row => row.outcome === 'completed');
      const spent = sumQuota(rows); const acceptedSpend = sumQuota(accepted);
      const mean = totals => Object.fromEntries(cursorUsagePools.map(pool => [pool,
        accepted.length && totals[pool] !== null ? totals[pool] / accepted.length : null,
      ]));
      return { key, attempts: rows.length, accepted: accepted.length,
        failed: rows.filter(row => row.outcome === 'failed').length,
        spentPoints: spent, acceptedMeanPoints: mean(acceptedSpend),
        pointsPerAcceptedWorkloadIncludingFailures: mean(spent) };
    }),
    attempts,
  };
}
