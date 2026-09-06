import { createHash } from 'node:crypto';
import path from 'node:path';
import { projectQaNativeTestEvidence } from './live-task-evidence.mjs';

export const QA_COMPACTION_INVESTIGATION_MARKERS = Object.freeze([
  'QA_COMPACTION_REV2_DOMAIN_REVIEW', 'QA_COMPACTION_REV2_BROWSER_REVIEW',
]);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (id, passed) => ({ id, passed: passed === true });
const categories = ['starts', 'dispositions', 'completedInspections', 'failedTests'];

// Only real finalized tool records qualify. Prompt text is used transiently to
// locate the agreed action marker and is never copied into evidence.
export function projectCompactionActions(rows, { directory, snapshot, rootSessionID } = {}) {
  const result = Object.fromEntries(categories.map(category => [category, []]));
  for (const row of Array.isArray(rows) ? rows : []) for (const part of row.parts ?? []) {
    if (row.info?.role !== 'assistant' || (row.info.sessionID && row.info.sessionID !== rootSessionID)
      || part.type !== 'tool' || part.state?.status !== 'completed' || !safeId(part.callID)) continue;
    const base = { callId: part.callID, sourceMessageId: row.info.id };
    if (part.tool === 'devryan_task' && part.state.input?.action === 'start') {
      const matches = typeof part.state.input.prompt === 'string'
        ? QA_COMPACTION_INVESTIGATION_MARKERS.filter(marker => part.state.input.prompt.includes(marker)) : [];
      const task = snapshot?.tasks?.find(item => item.dispatchCallId === part.callID);
      result.starts.push({ ...base, marker: matches.length === 1 ? matches[0] : null,
        taskId: safeId(task?.taskId) ? task.taskId : null, childSessionId: safeId(task?.childSessionId) ? task.childSessionId : null });
    }
    if (part.tool === 'devryan_task' && part.state.input?.action === 'continue' && safeId(part.state.input.task_id)) {
      result.dispositions.push({ ...base, taskId: part.state.input.task_id,
        startedAt: Number.isFinite(part.state.time?.start) ? part.state.time.start : null,
        completedAt: Number.isFinite(part.state.time?.end) ? part.state.time.end : null });
    }
    if (['read', 'file_read', 'oc_read'].includes(part.tool)) {
      const input = part.state.input;
      const names = ['filePath', 'file_path', 'path'].filter(key => typeof input?.[key] === 'string');
      if (names.length === 1 && path.isAbsolute(directory ?? '')) {
        const relative = path.relative(directory, path.resolve(directory, input[names[0]]));
        const offset = input.offset ?? null; const limit = input.limit ?? null;
        if (/^(?:src|public)\/[a-zA-Z0-9_./-]+$/.test(relative) && !relative.split('/').includes('..')
          && [offset, limit].every(value => value === null || Number.isSafeInteger(value) && value >= 0)) {
          result.completedInspections.push({ ...base, actionId: `source-read-${hash(JSON.stringify({ relative, offset, limit }))}`,
            relativePath: relative, offset, limit });
        }
      }
    }
    const test = projectQaNativeTestEvidence(part, directory);
    if (test?.exitCode > 0) result.failedTests.push({ ...base, actionId: 'qa-original-tests-red', commandKind: test.kind, exitCode: test.exitCode });
  }
  return result;
}

export function mergeCompactionActions(previous, next) {
  const conflicts = [...(previous?.identityConflicts ?? []), ...(next?.identityConflicts ?? [])].slice(0, 32);
  const result = Object.fromEntries(categories.map(category => {
    const calls = new Map();
    for (const item of [...(previous?.[category] ?? []), ...(next?.[category] ?? [])]) {
      const prior = calls.get(item.callId);
      const fields = category === 'starts' ? ['marker', 'taskId', 'childSessionId', 'sourceMessageId']
        : category === 'dispositions' ? ['taskId', 'sourceMessageId', 'startedAt', 'completedAt'] : [];
      if (prior) for (const field of fields) {
        if ((field === 'marker' || prior[field] != null && item[field] != null) && prior[field] !== item[field]
          && conflicts.length < 32) conflicts.push({ callId: item.callId, category, field });
      }
      // A later context page may lack a task link already proven by the ledger.
      calls.set(item.callId, prior && category === 'starts'
        ? { ...item, taskId: item.taskId ?? prior.taskId, childSessionId: item.childSessionId ?? prior.childSessionId } : item);
    }
    return [category, [...calls.values()]];
  }));
  if (conflicts.length) result.identityConflicts = conflicts;
  return result;
}

const cohortTask = (snapshot, item) => snapshot?.state === 'observed' && snapshot.tasks.find(task => task.taskId === item.taskId
  && task.childSessionId === item.childSessionId && task.dispatchCallId === item.callId);
const completedEnvelope = (snapshot, item) => snapshot?.envelopes?.find(envelope => envelope.taskId === item.taskId
  && safeId(envelope.envelopeId) && envelope.status === 'completed' && envelope.action === 'continue');
const pendingEnvelope = (snapshot, item) => {
  const envelopes = snapshot?.envelopes?.filter(envelope => envelope.taskId === item.taskId) ?? [];
  return envelopes.length === 1 && safeId(envelopes[0].envelopeId) && envelopes[0].status === 'completed'
    && envelopes[0].action === null && envelopes[0].acknowledgedAt === null ? envelopes[0] : null;
};
const exactInvestigationCohort = (cohort, coverage = 'mixed') => ['mixed', 'active', 'completed-awaiting'].includes(coverage)
  && Array.isArray(cohort) && cohort.length === (coverage === 'mixed' ? QA_COMPACTION_INVESTIGATION_MARKERS.length : 1)
  && cohort.every(item => QA_COMPACTION_INVESTIGATION_MARKERS.includes(item?.marker))
  && (coverage !== 'mixed' || QA_COMPACTION_INVESTIGATION_MARKERS.every(marker => cohort.filter(item => item.marker === marker).length === 1))
  && cohort.every(item => safeId(item.taskId) && safeId(item.childSessionId) && safeId(item.callId))
  && ['taskId', 'childSessionId', 'callId'].every(key => new Set(cohort.map(item => item[key])).size === cohort.length);

// Manual coverage remains mixed by default. Natural phases explicitly select
// one active or one completed-unacknowledged witness; neither implies the other.
export function projectQaCompactionBoundaryCohort(snapshot, cohort, { coverage = 'mixed' } = {}) {
  if (!exactInvestigationCohort(cohort, coverage) || !exactAttemptIdentities(snapshot, cohort, coverage)) {
    return { passed: false, reason: 'invalid seeded task identities or attempts' };
  }
  const active = cohort.filter(item => cohortTask(snapshot, item)?.status === 'running'
    && snapshot.activeTaskIds?.includes(item.taskId) && !snapshot.awaitingDispositionTaskIds?.includes(item.taskId)
    && !snapshot.envelopes.some(envelope => envelope.taskId === item.taskId));
  const completed = cohort.filter(item => cohortTask(snapshot, item)?.status === 'completed'
    && !snapshot.activeTaskIds?.includes(item.taskId) && snapshot.awaitingDispositionTaskIds?.includes(item.taskId) && pendingEnvelope(snapshot, item));
  if (coverage === 'active' && active.length === 1) return { passed: true, coverage, active: active[0] };
  if (coverage === 'completed-awaiting' && completed.length === 1) return { passed: true, coverage,
    completed: { ...completed[0], envelopeId: pendingEnvelope(snapshot, completed[0]).envelopeId } };
  if (coverage !== 'mixed') return { passed: false, reason: `requires one ${coverage} seeded witness` };
  if (active.length !== 1 || completed.length !== 1 || active[0].taskId === completed[0].taskId) {
    return { passed: false, reason: 'requires one running seeded child and one completed seeded result awaiting disposition' };
  }
  return { passed: true, coverage, active: active[0], completed: { ...completed[0], envelopeId: pendingEnvelope(snapshot, completed[0]).envelopeId } };
}

// This is a bracketed inference, not an atomic native-hook snapshot. Each
// request window must be wholly before/after the hook's wall-clock timestamp.
// Exact attempts can only progress queued -> starting -> running -> terminal;
// matching running endpoints cannot hide a completed/replaced/retried attempt.
export function projectQaCompactionBoundaryBracket({ snapshots, cohort, nativeStartedAt, gap, coverage = 'mixed' } = {}) {
  const fail = reason => ({ passed: false, reason, source: 'bracketed-authoritative-task-snapshots' });
  if (gap) return fail('managed snapshot evidence has a gap');
  if (!Number.isFinite(nativeStartedAt) || nativeStartedAt < 0 || !Array.isArray(snapshots)) {
    return fail('native boundary timestamp or managed snapshots are unavailable');
  }
  const validWindow = sample => Number.isFinite(sample?.requestStartedAt) && sample.requestStartedAt >= 0
    && Number.isFinite(sample?.responseCompletedAt) && sample.responseCompletedAt >= sample.requestStartedAt;
  if (snapshots.some(sample => !validWindow(sample))) return fail('managed snapshot request timing is malformed');
  const before = snapshots.filter(sample => sample.responseCompletedAt < nativeStartedAt)
    .toSorted((left, right) => right.responseCompletedAt - left.responseCompletedAt)[0];
  const after = snapshots.filter(sample => sample.requestStartedAt > nativeStartedAt)
    .toSorted((left, right) => left.requestStartedAt - right.requestStartedAt)[0];
  if (!before || !after) return fail('the native boundary has no complete before/after snapshot bracket');
  const first = projectQaCompactionBoundaryCohort(before.snapshot, cohort, { coverage });
  const second = projectQaCompactionBoundaryCohort(after.snapshot, cohort, { coverage });
  if (!first.passed || !second.passed) return fail(`the bracket does not preserve the strict ${coverage} cohort`);
  const firstIdentities = exactAttemptIdentities(before.snapshot, cohort, coverage);
  const secondIdentities = exactAttemptIdentities(after.snapshot, cohort, coverage);
  if (!firstIdentities || !secondIdentities
    || JSON.stringify(firstIdentities) !== JSON.stringify(secondIdentities)
    || first.active?.taskId !== second.active?.taskId || first.completed?.envelopeId !== second.completed?.envelopeId) {
    return fail('task attempt, recovery lineage or pending envelope changed across the native boundary');
  }
  return { passed: true, coverage, source: 'bracketed-authoritative-task-snapshots', nativeStartedAt,
    intervalStartedAt: before.responseCompletedAt, intervalEndedAt: after.requestStartedAt,
    identities: firstIdentities, before, after };
}

export function isQaCompactionPendingCohortPreserved(before, after, cohort, { coverage = 'mixed' } = {}) {
  const boundary = projectQaCompactionBoundaryCohort(before, cohort, { coverage });
  if (!boundary.passed) return false;
  return cohort.every(item => {
    const previous = cohortTask(before, item); const current = cohortTask(after, item);
    if (previous.status === 'completed') return current?.status === 'completed'
      && pendingEnvelope(after, item)?.envelopeId === pendingEnvelope(before, item)?.envelopeId;
    if (current?.status === 'running') return !after.envelopes.some(envelope => envelope.taskId === item.taskId);
    return current?.status === 'completed' && Boolean(pendingEnvelope(after, item));
  });
}

const exactAttemptIdentities = (snapshot, cohort, coverage = 'mixed') => {
  if (!exactInvestigationCohort(cohort, coverage) || snapshot?.state !== 'observed'
    || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.envelopes)) return null;
  const identities = cohort.map(item => {
    const matches = snapshot.tasks.filter(task => task.taskId === item.taskId);
    const task = matches.length === 1 ? cohortTask(snapshot, item) : null;
    if (!task || !Number.isSafeInteger(task.attempt) || task.attempt < 1
      || !['start', 'retry', 'resume', 'recover_in_place', 'retry_in_place'].includes(task.executionKind)
      || !(task.priorTaskId === null || safeId(task.priorTaskId))
      || !(task.recoveryLineageId === null || safeId(task.recoveryLineageId))) return null;
    return { taskId: task.taskId, childSessionId: task.childSessionId, dispatchCallId: task.dispatchCallId,
      attempt: task.attempt, executionKind: task.executionKind, priorTaskId: task.priorTaskId,
      recoveryLineageId: task.recoveryLineageId };
  });
  return identities.some(item => item === null) ? null : identities;
};

// The start bracket alone cannot prove survival through the summary. Retain a
// real pending observation after canonical completion, before ordinary native
// collection. Never skip a nearer consumed/unavailable snapshot for a later one.
export function projectQaCompactionSummaryExit({ snapshots, before, cohort, summaryCompletedAt, nativeCycle, gap, coverage = 'mixed' } = {}) {
  const fail = reason => ({ passed: false, reason, source: 'authoritative-post-summary-pending-snapshot' });
  if (gap) return fail('managed snapshot evidence has a gap');
  if (!Number.isFinite(summaryCompletedAt) || summaryCompletedAt < 0
    || !Number.isFinite(nativeCycle?.startedAt) || nativeCycle.startedAt > summaryCompletedAt
    || !Number.isFinite(nativeCycle?.completedAt) || nativeCycle.completedAt < summaryCompletedAt
    || nativeCycle.completedAt > summaryCompletedAt + 5000) return fail('canonical summary completion lacks native lifecycle corroboration');
  if (!Array.isArray(snapshots) || snapshots.some(sample => !Number.isFinite(sample?.requestStartedAt)
    || sample.requestStartedAt < 0 || !Number.isFinite(sample?.responseCompletedAt)
    || sample.responseCompletedAt < sample.requestStartedAt)) return fail('managed snapshot request timing is unavailable');
  const sample = snapshots.filter(item => item.requestStartedAt > summaryCompletedAt)
    .toSorted((left, right) => left.requestStartedAt - right.requestStartedAt)[0];
  if (!sample) return fail('no wholly-after-summary pending observation is available');
  const identities = exactAttemptIdentities(before, cohort, coverage);
  if (!identities || JSON.stringify(identities) !== JSON.stringify(exactAttemptIdentities(sample.snapshot, cohort, coverage))
    || !isQaCompactionPendingCohortPreserved(before, sample.snapshot, cohort, { coverage })) return fail('summary exit lost a pending task attempt or original envelope');
  for (const item of cohort) {
    const previous = before.envelopes.filter(envelope => envelope.taskId === item.taskId);
    const following = sample.snapshot.envelopes.filter(envelope => envelope.taskId === item.taskId);
    if (previous.some(envelope => envelope.acknowledgedAt !== null)
      || following.some(envelope => envelope.acknowledgedAt !== null)) return fail('pending envelope acknowledgement is ambiguous');
  }
  return { passed: true, coverage, source: 'authoritative-post-summary-pending-snapshot', summaryCompletedAt, nativeCycle, identities, sample };
}

// After the saved exit observation, natural result collection is valid. Match
// the exact envelope and require its acknowledgement inside its one canonical
// continue call, strictly after summary completion. No timestamp is inferred.
export function isQaCompactionPostSummaryCohortPreserved({ exit, after, cohort, dispositions } = {}) {
  const before = exit?.sample?.snapshot;
  const coverage = exit?.coverage ?? 'mixed';
  const identities = exactAttemptIdentities(before, cohort, coverage);
  if (exit?.passed !== true || !Number.isFinite(exit.summaryCompletedAt) || !identities
    || JSON.stringify(identities) !== JSON.stringify(exactAttemptIdentities(after, cohort, coverage))) return false;
  return cohort.every(item => {
    const previous = cohortTask(before, item);
    const task = cohortTask(after, item);
    const calls = (dispositions ?? []).filter(call => call.taskId === item.taskId);
    const original = before.envelopes.filter(envelope => envelope.taskId === item.taskId);
    const envelopes = after.envelopes.filter(envelope => envelope.taskId === item.taskId);
    if (task.status === 'running') return previous.status === 'running' && original.length === 0 && envelopes.length === 0 && calls.length === 0;
    if (task.status !== 'completed' || envelopes.length !== 1 || envelopes[0].status !== 'completed'
      || !safeId(envelopes[0].envelopeId) || original.length > 1
      || original.length === 1 && original[0].envelopeId !== envelopes[0].envelopeId) return false;
    const envelope = envelopes[0];
    if (envelope.action === null) return envelope.acknowledgedAt === null && calls.length === 0;
    if (envelope.action !== 'continue' || calls.length !== 1) return false;
    const call = calls[0];
    return Number.isFinite(call.startedAt) && call.startedAt > exit.summaryCompletedAt
      && Number.isFinite(call.completedAt) && call.completedAt >= call.startedAt
      && Number.isFinite(envelope.acknowledgedAt) && envelope.acknowledgedAt >= call.startedAt
      && envelope.acknowledgedAt <= call.completedAt;
  });
}

export function gradeCompactionOperationalContinuity({ agent, baselineActions, pausedActions, cohort,
  firstBefore, firstAfter, firstSummaryExit, completedBeforeSecond, secondAfter, continuedActions = pausedActions, projectGrade } = {}) {
  const checks = [];
  if (agent === 'orchestrator') {
    const exactCohort = exactInvestigationCohort(cohort);
    const firstBoundary = projectQaCompactionBoundaryCohort(firstBefore, cohort);
    checks.push(check('compaction.managed-cohort-observed', exactCohort));
    checks.push(check('compaction.active-and-completed-awaiting-at-first-boundary', firstBoundary.passed));
    checks.push(check('compaction.pending-task-identities-survive-first-boundary', isQaCompactionPendingCohortPreserved(firstBefore, firstAfter, cohort)));
    const summaryExit = projectQaCompactionSummaryExit({ snapshots: firstSummaryExit?.sample ? [{ ...firstSummaryExit.sample, snapshot: firstAfter }] : [],
      before: firstBefore, cohort, summaryCompletedAt: firstSummaryExit?.summaryCompletedAt, nativeCycle: firstSummaryExit?.nativeCycle });
    checks.push(check('compaction.pending-identities-survive-through-summary-completion', summaryExit.passed));
    checks.push(check('compaction.dispositions-occur-after-summary-completion', summaryExit.passed
      && isQaCompactionPostSummaryCohortPreserved({ exit: summaryExit, after: completedBeforeSecond, cohort, dispositions: continuedActions?.dispositions })
      && isQaCompactionPostSummaryCohortPreserved({ exit: summaryExit, after: secondAfter, cohort, dispositions: continuedActions?.dispositions })));
    const baselineStartIds = new Set((baselineActions?.starts ?? []).map(item => item.callId));
    const seededStarts = (pausedActions?.starts ?? []).filter(item => !baselineStartIds.has(item.callId));
    checks.push(check('compaction.seeded-investigations-started-once', exactCohort && seededStarts.length === cohort.length
      && seededStarts.every(item => cohort.some(expected => expected.callId === item.callId && expected.marker === item.marker
        && expected.taskId === item.taskId && expected.childSessionId === item.childSessionId))));
    checks.push(check('compaction.completed-investigations-not-restarted-after-approval', exactCohort && cohort.every(item => (
      (continuedActions?.starts ?? []).filter(start => start.marker === item.marker).length === 1
    ))));
    checks.push(check('compaction.seeded-results-dispositioned-once', exactCohort && cohort.every(item => (
      (continuedActions?.dispositions ?? []).filter(call => call.taskId === item.taskId).length === 1
      && cohortTask(completedBeforeSecond, item)?.status === 'completed' && completedEnvelope(completedBeforeSecond, item)
    )) && firstBoundary.passed
      && completedEnvelope(completedBeforeSecond, firstBoundary.completed)?.envelopeId === firstBoundary.completed.envelopeId));
    checks.push(check('compaction.completed-work-survives-second-boundary', exactCohort && cohort.every(item => (
      cohortTask(secondAfter, item)?.status === 'completed' && completedEnvelope(secondAfter, item)?.envelopeId === completedEnvelope(completedBeforeSecond, item)?.envelopeId
    ))));
  } else {
    const baseline = [...(baselineActions?.completedInspections ?? []), ...(baselineActions?.failedTests ?? [])];
    const knownCalls = new Set(baseline.map(item => item.callId));
    const completedActions = new Set(baseline.map(item => item.actionId));
    const following = [...(pausedActions?.completedInspections ?? []), ...(pausedActions?.failedTests ?? [])].filter(item => !knownCalls.has(item.callId));
    checks.push(check('compaction.builder-completed-actions-observed', baseline.length > 0));
    checks.push(check('compaction.builder-paused-work-not-repeated', baseline.length > 0 && following.every(item => !completedActions.has(item.actionId))));
  }
  checks.push(check('compaction.independent-behavior-after-continuation', projectGrade?.passed === true));
  return { passed: checks.every(item => item.passed), checks,
    scope: agent === 'orchestrator' ? 'Exact marked investigation starts, pending identities and completed dispositions across two boundaries'
      : 'Exact completed source-read signatures and native RED calls during the implementation pause; approval-time implementation is excluded' };
}

// Inspect every retained ledger/action observation, including unmarked tasks
// and the implementation phase. A queued task may acquire its first child ID;
// an observed dispatch, attempt, lineage or non-null child cannot be rebound.
export function projectQaCompactionGlobalIdentity({ snapshots, actionStages = [], gap } = {}) {
  const fail = reason => ({ passed: false, reason });
  if (gap || !Array.isArray(snapshots) || snapshots.length === 0) return fail('complete managed observations are required');
  const tasks = new Map(); const dispatches = new Map(); const children = new Map();
  const envelopeTasks = new Map(); const taskEnvelopes = new Map(); const dispositionsAt = new Map(); const terminalAt = new Map();
  const firstTaskAt = new Map(); const firstEnvelopeAt = new Map();
  const bind = (map, key, value) => {
    if (map.has(key) && map.get(key) !== value) return false;
    map.set(key, value); return true;
  };
  for (const sample of snapshots) {
    const snapshot = sample?.snapshot;
    if (!Number.isFinite(sample?.requestStartedAt) || sample.requestStartedAt < 0
      || !Number.isFinite(sample?.responseCompletedAt) || sample.responseCompletedAt < sample.requestStartedAt
      || snapshot?.state !== 'observed' || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.envelopes)) {
      return fail('a managed observation is unavailable or malformed');
    }
    const sampleTasks = new Set(); const sampleDispatches = new Set(); const sampleEnvelopes = new Set();
    for (const task of snapshot.tasks) {
      if (!safeId(task?.taskId) || !safeId(task.dispatchCallId)
        || !(task.childSessionId === null || safeId(task.childSessionId))
        || !Number.isSafeInteger(task.attempt) || task.attempt < 1
        || !['start', 'retry', 'resume', 'recover_in_place', 'retry_in_place'].includes(task.executionKind)
        || !(task.priorTaskId === null || safeId(task.priorTaskId))
        || !(task.recoveryLineageId === null || safeId(task.recoveryLineageId))
        || sampleTasks.has(task.taskId) || sampleDispatches.has(task.dispatchCallId)) return fail('invalid or duplicate task dispatch identity');
      sampleTasks.add(task.taskId); sampleDispatches.add(task.dispatchCallId);
      const identity = JSON.stringify([task.dispatchCallId, task.attempt, task.executionKind, task.priorTaskId, task.recoveryLineageId]);
      const prior = tasks.get(task.taskId);
      if (prior && (prior.identity !== identity || prior.childSessionId && task.childSessionId && prior.childSessionId !== task.childSessionId)
        || !bind(dispatches, task.dispatchCallId, task.taskId)
        || task.childSessionId && !bind(children, task.childSessionId, task.taskId)) return fail('a task, dispatch, child, attempt or recovery lineage was rebound');
      if (prior?.childSessionId && task.childSessionId === null && sample.requestStartedAt > prior.firstChildAt) return fail('an observed child binding disappeared');
      tasks.set(task.taskId, { identity, childSessionId: task.childSessionId ?? prior?.childSessionId ?? null, priorTaskId: task.priorTaskId,
        firstChildAt: Math.min(prior?.firstChildAt ?? Infinity, task.childSessionId ? sample.responseCompletedAt : Infinity) });
      firstTaskAt.set(task.taskId, Math.min(firstTaskAt.get(task.taskId) ?? Infinity, sample.responseCompletedAt));
      const terminal = terminalAt.get(task.taskId);
      if (terminal && sample.requestStartedAt > terminal.at && task.status !== terminal.status) return fail('a terminal task executed again in a later observation');
      if (['completed', 'failed', 'aborted', 'interrupted'].includes(task.status)
        && (!terminal || sample.responseCompletedAt < terminal.at)) terminalAt.set(task.taskId, { at: sample.responseCompletedAt, status: task.status });
    }
    for (const envelope of snapshot.envelopes) {
      if (!safeId(envelope?.taskId) || !safeId(envelope.envelopeId) || sampleEnvelopes.has(envelope.taskId)
        || !bind(envelopeTasks, envelope.envelopeId, envelope.taskId)
        || !bind(taskEnvelopes, envelope.taskId, envelope.envelopeId)) return fail('a result envelope was duplicated or rebound');
      sampleEnvelopes.add(envelope.taskId);
      firstEnvelopeAt.set(envelope.taskId, Math.min(firstEnvelopeAt.get(envelope.taskId) ?? Infinity, sample.responseCompletedAt));
      const disposition = dispositionsAt.get(envelope.envelopeId);
      if (envelope.action === null) {
        if (envelope.acknowledgedAt !== null || disposition && sample.requestStartedAt > disposition.at) return fail('a result disposition reverted or lost its acknowledgement');
      } else {
        const identity = JSON.stringify([envelope.action, envelope.acknowledgedAt]);
        if (!Number.isFinite(envelope.acknowledgedAt) || envelope.acknowledgedAt < 0
          || disposition && disposition.identity !== identity) return fail('a result disposition identity changed');
        dispositionsAt.set(envelope.envelopeId, { identity, at: Math.min(sample.responseCompletedAt, disposition?.at ?? Infinity) });
      }
    }
    if ([...firstTaskAt].some(([taskId, at]) => sample.requestStartedAt > at && !sampleTasks.has(taskId))
      || [...firstEnvelopeAt].some(([taskId, at]) => sample.requestStartedAt > at && !sampleEnvelopes.has(taskId))) {
      return fail('an observed task or result envelope disappeared in a later snapshot');
    }
  }
  if ([...tasks.values()].some(task => task.priorTaskId !== null && tasks.has(task.priorTaskId))) {
    return fail('a replacement or recovery task repeated an observed task');
  }
  const starts = new Map(); const dispositions = new Map();
  for (const actions of actionStages) {
    if (actions?.identityConflicts?.length) return fail('canonical action identity changed across context captures');
    for (const [category, known] of [['starts', starts], ['dispositions', dispositions]]) {
      const seen = new Set();
      for (const action of actions?.[category] ?? []) {
        if (!safeId(action?.callId) || seen.has(action.callId)) return fail('canonical call identity is invalid or duplicated');
        seen.add(action.callId);
        const prior = known.get(action.callId);
        const fields = category === 'starts' ? ['marker', 'taskId', 'childSessionId', 'sourceMessageId']
          : ['taskId', 'sourceMessageId', 'startedAt', 'completedAt'];
        if (prior && fields.some(field => (field === 'marker' || prior[field] != null && action[field] != null)
          && prior[field] !== action[field])) return fail('canonical call identity was rebound');
        known.set(action.callId, { ...prior, ...Object.fromEntries(Object.entries(action).filter(([, value]) => value != null)) });
      }
    }
  }
  for (const [callId, start] of starts) {
    const taskId = dispatches.get(callId); const task = tasks.get(taskId);
    if (!task || !safeId(start.taskId) || !safeId(start.childSessionId) || start.taskId !== taskId
      || start.childSessionId !== task.childSessionId) return fail('a canonical start lacks its exact observed task and child binding');
  }
  if ([...dispatches.keys()].some(callId => !starts.has(callId))) return fail('an observed dispatch lacks canonical start evidence');
  if ([...dispositions.keys()].some(callId => starts.has(callId))) return fail('one canonical call was reused for dispatch and disposition');
  return { passed: true, observedTasks: tasks.size, observedDispatches: dispatches.size, observedChildren: children.size };
}

const collectedCohort = (exit, snapshot, cohort, dispositions) => isQaCompactionPostSummaryCohortPreserved({ exit, after: snapshot, cohort, dispositions })
  && cohort.every(item => cohortTask(snapshot, item)?.status === 'completed' && completedEnvelope(snapshot, item));
const retainedObservation = (sample, snapshots) => sample && Array.isArray(snapshots) && snapshots.some(item => item.stage === sample.stage
  && item.requestStartedAt === sample.requestStartedAt && item.responseCompletedAt === sample.responseCompletedAt
  && JSON.stringify(item.snapshot) === JSON.stringify(sample.snapshot));

export function gradeQaNaturalCompactionOperationalContinuity({ baselineActions, pausedActions, continuedActions,
  cohort, witnesses, boundaries, snapshots, finalSnapshot, snapshotGap, actionGap, projectGrade } = {}) {
  const checks = [];
  const policies = ['active', 'completed-awaiting'];
  const exactCohort = exactInvestigationCohort(cohort);
  const phases = exactCohort && Array.isArray(witnesses) && witnesses.length === 2 && witnesses.every((witness, index) => (
    witness?.boundaryIndex === index + 1 && witness.coverage === policies[index]
    && exactInvestigationCohort(witness.cohort, policies[index])
    && witness.cohort[0].marker === QA_COMPACTION_INVESTIGATION_MARKERS[index]
    && cohort.some(item => JSON.stringify(item) === JSON.stringify(witness.cohort[0]))
  ));
  checks.push(check('compaction.natural-two-distinct-phase-witnesses', phases));
  const cycles = Array.isArray(boundaries) && boundaries.length === 2 && boundaries.every(boundary => (
    boundary?.source === 'opencode' && boundary.auto === true && boundary.overflow === false
    && boundary.thresholdReached === true && boundary.nativeLifecycle === 'observed'
    && safeId(boundary.eventId) && safeId(boundary.summaryMessageId)
    && Number.isFinite(boundary.observedAt) && Number.isFinite(boundary.nativeCycle?.startedAt)
    && Number.isFinite(boundary.nativeCycle?.completedAt)
  )) && boundaries[0].eventId !== boundaries[1].eventId && boundaries[0].summaryMessageId !== boundaries[1].summaryMessageId
    && boundaries[0].nativeCycle.completedAt < boundaries[1].nativeCycle.startedAt;
  checks.push(check('compaction.natural-two-ordered-automatic-threshold-cycles', cycles));
  const globalIdentity = projectQaCompactionGlobalIdentity({ snapshots,
    actionStages: [baselineActions, pausedActions, continuedActions], gap: snapshotGap || actionGap });
  checks.push(check('compaction.global-dispatch-attempt-identities-remain-unique', globalIdentity.passed));
  const exits = [];
  for (const index of [0, 1]) {
    const witness = phases ? witnesses[index] : null; const boundary = cycles ? boundaries[index] : null;
    const bracket = witness && boundary ? projectQaCompactionBoundaryBracket({ snapshots, cohort: witness.cohort,
      coverage: witness.coverage, nativeStartedAt: boundary.nativeCycle.startedAt, gap: snapshotGap }) : null;
    const exit = bracket?.passed ? projectQaCompactionSummaryExit({ snapshots, before: bracket.before.snapshot,
      cohort: witness.cohort, coverage: witness.coverage, summaryCompletedAt: boundary.observedAt,
      nativeCycle: boundary.nativeCycle, gap: snapshotGap }) : null;
    exits.push(exit);
    checks.push(check(`compaction.natural-boundary-${index + 1}-native-start-and-summary-exit`, bracket?.passed && exit?.passed));
    checks.push(check(`compaction.natural-boundary-${index + 1}-observed-witness-lifetime`, bracket?.passed
      && snapshots.filter(sample => sample.requestStartedAt > bracket.before.responseCompletedAt).every(sample => {
        const identities = exactAttemptIdentities(sample.snapshot, witness.cohort, witness.coverage);
        const task = cohortTask(sample.snapshot, witness.cohort[0]);
        return identities && JSON.stringify(identities) === JSON.stringify(bracket.identities)
          && (task.status === 'completed' || witness.coverage === 'active' && task.status === 'running');
      })));
    const afterReload = witness?.afterReload; const afterCollection = witness?.afterCollection;
    checks.push(check(`compaction.natural-boundary-${index + 1}-reload-and-exact-once-collection`, exit?.passed
      && retainedObservation(afterReload, snapshots) && retainedObservation(afterCollection, snapshots)
      && afterReload.requestStartedAt > exit.sample.responseCompletedAt
      && afterCollection.requestStartedAt >= afterReload.responseCompletedAt
      && isQaCompactionPostSummaryCohortPreserved({ exit, after: afterReload.snapshot,
        cohort: witness.cohort, dispositions: (continuedActions?.dispositions ?? []).filter(call => call.completedAt <= afterReload.responseCompletedAt) })
      && collectedCohort(exit, afterCollection.snapshot, witness.cohort, continuedActions?.dispositions)));
  }
  const first = phases ? witnesses[0] : null;
  const second = phases ? witnesses[1] : null;
  const secondBracket = cycles && second ? projectQaCompactionBoundaryBracket({ snapshots, cohort: second.cohort,
    coverage: second.coverage, nativeStartedAt: boundaries[1].nativeCycle.startedAt, gap: snapshotGap }) : null;
  checks.push(check('compaction.first-collected-result-survives-second-boundary', exits[0]?.passed && secondBracket?.passed
    && first.afterCollection?.responseCompletedAt < secondBracket.before.requestStartedAt
    && [secondBracket.before.snapshot, secondBracket.after.snapshot, exits[1]?.sample?.snapshot,
      second.afterReload?.snapshot, second.afterCollection?.snapshot].every(snapshot => collectedCohort(exits[0], snapshot, first.cohort, continuedActions?.dispositions))));
  const baselineIds = new Set((baselineActions?.starts ?? []).map(item => item.callId));
  const seeded = (pausedActions?.starts ?? []).filter(item => !baselineIds.has(item.callId));
  checks.push(check('compaction.seeded-investigations-started-once', exactCohort && seeded.length === cohort.length
    && seeded.every(item => cohort.some(expected => expected.callId === item.callId && expected.marker === item.marker
      && expected.taskId === item.taskId && expected.childSessionId === item.childSessionId))));
  checks.push(check('compaction.completed-investigations-not-restarted-after-approval', exactCohort && cohort.every(item => (
    (continuedActions?.starts ?? []).filter(start => start.marker === item.marker).length === 1
    && (continuedActions?.dispositions ?? []).filter(call => call.taskId === item.taskId).length === 1
  ))));
  checks.push(check('compaction.both-results-preserved-through-implementation', phases && retainedObservation(finalSnapshot, snapshots)
    && finalSnapshot.requestStartedAt >= second.afterCollection?.responseCompletedAt
    && witnesses.every((witness, index) => collectedCohort(exits[index], finalSnapshot.snapshot, witness.cohort, continuedActions?.dispositions))));
  checks.push(check('compaction.independent-behavior-after-continuation', projectGrade?.passed === true));
  return { passed: checks.every(item => item.passed), checks, globalIdentity,
    scope: 'Separate active and completed-unacknowledged witnesses at two automatic boundaries; exact attempts, result envelopes and one collection per witness across the complete observed journey' };
}
