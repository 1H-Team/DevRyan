import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { runQaManualCompaction } from './compaction-scenarios.mjs';

// A project composition keeps one owned project, session and pinned selection.
// This grades retained observations; it does not request another scenario run.
export function gradeQaProjectManualCompaction(compaction) {
  const boundaries = compaction?.boundaries ?? [];
  const sessionID = compaction?.sessionID;
  const expected = compaction?.expectedPausedState;
  const checks = [];
  const check = (id, passed) => checks.push({ id, passed: passed === true });
  check('project-compaction.manual-adapter-completed', compaction?.source === 'opencode' && compaction.mode === 'manual'
    && compaction.outcome === 'passed-with-declared-coverage' && compaction.nativeLifecycle === 'observed');
  check('project-compaction.two-distinct-native-boundaries', boundaries.length === 2
    && new Set(boundaries.map(boundary => boundary.eventId)).size === 2
    && new Set(boundaries.map(boundary => boundary.summaryMessageId)).size === 2
    && boundaries.every(boundary => typeof boundary.eventId === 'string' && typeof boundary.summaryMessageId === 'string'
      && boundary.source === 'opencode' && boundary.trigger === 'manual' && boundary.requestKind === 'manual'
      && boundary.auto === false && boundary.overflow === false && boundary.nativeLifecycle === 'observed'
      && Number.isFinite(boundary.nativeCycle?.startedAt) && Number.isFinite(boundary.nativeCycle?.completedAt)
      && boundary.nativeCycle.startedAt <= boundary.observedAt && boundary.observedAt <= boundary.nativeCycle.completedAt)
    && boundaries[1].nativeCycle.startedAt > boundaries[0].nativeCycle.completedAt);
  check('project-compaction.same-project-session', typeof sessionID === 'string' && sessionID.length > 0
    && compaction?.implementationSessionID === sessionID && boundaries.length === 2
    && boundaries.every(boundary => boundary.sessionID === sessionID && boundary.continuation?.sessionID === sessionID));
  check('project-compaction.revised-unfinished-plan', expected?.objectiveRevision === 2
    && expected.phase === 'paused-before-implementation'
    && compaction?.initialPlanGrade?.passed === true && compaction?.revisedPlanGrade?.passed === true);
  for (let index = 0; index < 2; index++) {
    const boundary = boundaries[index];
    check(`project-compaction.boundary-${index + 1}-continuation`, Boolean(boundary?.continuation)
      && boundary.continuation.restoredSummaryMessageId === boundary.summaryMessageId
      && boundary.continuation.pausedProjectGrade?.passed === true
      && Boolean(expected) && isDeepStrictEqual(boundary.continuation.observedPausedState, expected));
  }
  check('project-compaction.operational-continuity', compaction?.operationalContinuityGrade?.passed === true
    && !compaction.managedSnapshotGap && !compaction.actionSnapshotGap);
  check('project-compaction.independent-implementation', compaction?.projectGrade?.passed === true);
  return { mode: 'manual', scope: 'two manual UI boundaries within one project journey, retained revision-2 state and independently graded implementation',
    passed: checks.every(item => item.passed), checks };
}

export async function runQaProjectManualCompaction(context, { runCompaction = runQaManualCompaction } = {}) {
  const { cell } = context;
  assert.ok(cell?.transport === 'live' && cell.runtime === 'electron'
    && cell.scenarioId === 'project-work' && cell.projectCompaction === 'manual',
  'Composed manual compaction requires an opted-in live Electron project-work cell');
  const compaction = await runCompaction(context);
  const projectComposition = gradeQaProjectManualCompaction(compaction);
  const result = { compaction, projectComposition, initialPlanGrade: compaction.initialPlanGrade,
    planGrade: compaction.revisedPlanGrade, projectGrade: compaction.projectGrade };
  context.record?.(result);
  await context.check('two manual UI boundaries retain and continue the same unfinished project', async () => {
    assert.ok(projectComposition.passed, 'Composed project compaction lacks complete boundary, continuation or implementation evidence');
  });
  return result;
}
