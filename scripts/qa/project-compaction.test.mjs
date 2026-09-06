import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeQaProjectManualCompaction, runQaProjectManualCompaction } from './project-compaction.mjs';

const complete = () => {
  const expectedPausedState = { objectiveRevision: 2, phase: 'paused-before-implementation',
    planSha256: 'revised-plan', preservedFileHashes: { 'user-note.md': 'original-edit' } };
  return { source: 'opencode', mode: 'manual', outcome: 'passed-with-declared-coverage', nativeLifecycle: 'observed',
    sessionID: 'ses_project', implementationSessionID: 'ses_project', expectedPausedState,
    initialPlanGrade: { passed: true }, revisedPlanGrade: { passed: true },
    operationalContinuityGrade: { passed: true }, projectGrade: { passed: true },
    boundaries: [0, 1].map(index => ({ eventId: `part_${index}`, summaryMessageId: `summary_${index}`,
      source: 'opencode', trigger: 'manual', requestKind: 'manual',
      auto: false, overflow: false, observedAt: 150 + index * 200, sessionID: 'ses_project', nativeLifecycle: 'observed',
      nativeCycle: { startedAt: 100 + index * 200, completedAt: 160 + index * 200 },
      continuation: { sessionID: 'ses_project', restoredSummaryMessageId: `summary_${index}`,
        pausedProjectGrade: { passed: true }, observedPausedState: structuredClone(expectedPausedState) } })) };
};

test('composed manual project acceptance requires both real boundaries and each retained continuation', () => {
  assert.equal(gradeQaProjectManualCompaction(complete()).passed, true);
  assert.equal(gradeQaProjectManualCompaction(undefined).passed, false);
  for (const mutate of [
    value => { value.source = 'fixture'; },
    value => { value.boundaries[0].source = 'fixture'; },
    value => { value.boundaries[0].trigger = 'automatic'; },
    value => { value.boundaries[0].requestKind = 'recap'; },
    value => { value.boundaries.pop(); },
    value => { value.boundaries[1].eventId = value.boundaries[0].eventId; },
    value => { value.boundaries[1].summaryMessageId = value.boundaries[0].summaryMessageId; },
    value => { value.boundaries[1].nativeCycle.startedAt = 120; },
    value => { value.boundaries[0].auto = true; },
    value => { value.boundaries[0].overflow = true; },
    value => { value.boundaries[0].nativeLifecycle = 'missing'; },
    value => { value.boundaries[0].sessionID = 'ses_new'; },
    value => { value.boundaries[1].continuation.sessionID = 'ses_new'; },
    value => { value.implementationSessionID = 'ses_new'; },
    value => { delete value.boundaries[0].continuation; },
    value => { value.boundaries[1].continuation.restoredSummaryMessageId = 'stale_summary'; },
    value => { value.boundaries[0].continuation.observedPausedState.planSha256 = 'stale_plan'; },
    value => { value.boundaries[1].continuation.observedPausedState.preservedFileHashes['user-note.md'] = 'lost_edit'; },
    value => { value.boundaries[1].continuation.pausedProjectGrade.passed = false; },
    value => { value.expectedPausedState.phase = 'already-implemented'; },
    value => { value.operationalContinuityGrade.passed = false; },
    value => { value.projectGrade.passed = false; },
    value => { value.managedSnapshotGap = 'missing observation'; },
    value => { value.actionSnapshotGap = 'missing action'; },
  ]) {
    const value = complete(); mutate(value);
    assert.equal(gradeQaProjectManualCompaction(value).passed, false);
  }
});

test('project composition uses the existing context once and preserves separate grades', async () => {
  const checks = [];
  const context = { cell: { runtime: 'electron', transport: 'live', scenarioId: 'project-work', projectCompaction: 'manual',
    modelId: 'pinned-model', agent: 'orchestrator', planMode: true, variant: 'high' },
    projectFixture: { fixtureRoot: 'one-owned-project' }, getSessionID: () => 'ses_project',
    check: async (name, action) => { checks.push(name); await action(); } };
  const compaction = complete(); let calls = 0;
  const result = await runQaProjectManualCompaction(context, { runCompaction: async received => {
    calls++; assert.equal(received, context); assert.equal(received.getSessionID(), 'ses_project'); return compaction;
  } });
  assert.equal(calls, 1);
  assert.equal(checks.length, 1);
  assert.equal(result.compaction, compaction);
  assert.equal(result.projectGrade, compaction.projectGrade);
  assert.equal(result.projectComposition.passed, true);
  assert.notEqual(result.projectComposition, result.projectGrade);
  const incomplete = complete(); incomplete.boundaries.pop();
  let failedRecord;
  await assert.rejects(runQaProjectManualCompaction({ ...context, record: value => { failedRecord = value; } },
    { runCompaction: async () => incomplete }), /lacks complete/);
  assert.equal(failedRecord.compaction, incomplete);
  assert.equal(failedRecord.projectComposition.passed, false, 'A failed composition retains its individual grade checks');
  await assert.rejects(runQaProjectManualCompaction({ ...context, cell: { ...context.cell, runtime: 'web' } },
    { runCompaction: async () => { throw new Error('must not run'); } }), /opted-in live Electron/);
});
