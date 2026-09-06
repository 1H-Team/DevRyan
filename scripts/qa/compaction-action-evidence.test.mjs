import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeCompactionOperationalContinuity, gradeQaNaturalCompactionOperationalContinuity, projectQaCompactionGlobalIdentity, mergeCompactionActions, projectCompactionActions, projectQaCompactionBoundaryBracket, projectQaCompactionBoundaryCohort, projectQaCompactionSummaryExit, isQaCompactionPostSummaryCohortPreserved, QA_COMPACTION_INVESTIGATION_MARKERS } from './compaction-action-evidence.mjs';

const part = (callID, tool, input, metadata = {}) => ({ type: 'tool', callID, tool, state: { status: 'completed', input, metadata } });
test('compaction actions contain only canonical finalized source reads, numeric RED results, and exact marked dispatch links', () => {
  const directory = '/owned/project';
  const rows = [{ info: { id: 'msg_one', role: 'assistant', sessionID: 'ses_root' }, parts: [
    part('call_read', 'read', { filePath: '/owned/project/src/tasks.mjs' }),
    part('call_plan', 'read', { filePath: '.opencode/plans/qa-current.md' }),
    part('call_outside', 'read', { filePath: '../../secret' }),
    part('call_red', 'bash', { command: 'npm test' }, { exit: 1 }),
    part('call_prose', 'bash', { command: 'npm test' }, {}),
    part('call_start', 'devryan_task', { action: 'start', prompt: `Private task details ${QA_COMPACTION_INVESTIGATION_MARKERS[0]}` }),
  ] }];
  const result = projectCompactionActions(rows, { directory, rootSessionID: 'ses_root', snapshot: { tasks: [{ dispatchCallId: 'call_start', taskId: 'task_one', childSessionId: 'ses_child' }] } });
  assert.equal(result.completedInspections.length, 1); assert.equal(result.failedTests.length, 1);
  assert.equal(result.starts[0].taskId, 'task_one'); assert.equal(result.starts[0].marker, QA_COMPACTION_INVESTIGATION_MARKERS[0]);
  assert.doesNotMatch(JSON.stringify(result), /Private task|prompt|secret/);
  assert.equal(mergeCompactionActions(result, result).starts.length, 1);
  rows[0].parts[0].state.status = 'running';
  assert.equal(projectCompactionActions(rows, { directory, rootSessionID: 'ses_root' }).completedInspections.length, 0);
});

const managed = () => {
  const cohort = QA_COMPACTION_INVESTIGATION_MARKERS.map((marker, index) => ({ marker, taskId: `task_${index}`, childSessionId: `ses_child${index}`, callId: `call_start${index}` }));
  const tasks = cohort.map((item, index) => ({ taskId: item.taskId, childSessionId: item.childSessionId, dispatchCallId: item.callId,
    status: index === 0 ? 'running' : 'completed', attempt: 1, executionKind: 'start', priorTaskId: null, recoveryLineageId: null }));
  const firstBefore = { state: 'observed', tasks,
    envelopes: [{ taskId: tasks[1].taskId, envelopeId: 'envelope_1', status: 'completed', action: null, acknowledgedAt: null }],
    activeTaskIds: [tasks[0].taskId], awaitingDispositionTaskIds: [tasks[1].taskId] };
  const completedBeforeSecond = { state: 'observed', tasks: tasks.map(item => ({ ...item, status: 'completed' })),
    envelopes: tasks.map((item, index) => ({ taskId: item.taskId, envelopeId: `envelope_${index}`, status: 'completed', action: 'continue', acknowledgedAt: 160 + index })), activeTaskIds: [], awaitingDispositionTaskIds: [] };
  const firstAfter = structuredClone(firstBefore);
  const firstSummaryExit = projectQaCompactionSummaryExit({ before: firstBefore, cohort, summaryCompletedAt: 100,
    nativeCycle: { startedAt: 50, completedAt: 102 }, snapshots: [{ requestStartedAt: 110, responseCompletedAt: 120, snapshot: firstAfter }] });
  return { agent: 'orchestrator', cohort, firstBefore, firstAfter, firstSummaryExit, completedBeforeSecond,
    secondAfter: structuredClone(completedBeforeSecond), baselineActions: { starts: [] },
    pausedActions: { starts: cohort, dispositions: cohort.map((item, index) => ({ callId: `call_continue${index}`, taskId: item.taskId, startedAt: 150, completedAt: 180 })) }, projectGrade: { passed: true } };
};

test('managed continuity requires exact pending identities, one dispatch/disposition, completed preservation and external behavior', () => {
  assert.equal(gradeCompactionOperationalContinuity(managed()).passed, true);
  for (const mutation of [
    value => { value.cohort[1].marker = value.cohort[0].marker; },
    value => { value.firstBefore.activeTaskIds = []; },
    value => { value.firstAfter.tasks[0].childSessionId = 'ses_replaced'; },
    value => { value.pausedActions.starts.push({ ...value.cohort[0], callId: 'duplicate_start' }); },
    value => { value.pausedActions.dispositions.push({ ...value.pausedActions.dispositions[0], callId: 'duplicate_continue' }); },
    value => { value.completedBeforeSecond.envelopes[0].action = null; },
    value => { value.secondAfter.envelopes[0].envelopeId = 'new_envelope'; },
    value => { value.secondAfter.tasks[0].status = 'running'; },
    value => { value.projectGrade.passed = false; },
  ]) { const value = managed(); mutation(value); assert.equal(gradeCompactionOperationalContinuity(value).passed, false, mutation.toString()); }
  const awaiting = managed(); awaiting.firstBefore.activeTaskIds = []; awaiting.firstBefore.awaitingDispositionTaskIds = awaiting.cohort.map(item => item.taskId);
  assert.equal(gradeCompactionOperationalContinuity(awaiting).passed, false);
  const progressed = managed();
  progressed.firstAfter.tasks[0].status = 'completed';
  progressed.firstAfter.envelopes.push({ taskId: 'task_0', envelopeId: 'envelope_0', status: 'completed', action: null, acknowledgedAt: null });
  progressed.firstAfter.activeTaskIds = []; progressed.firstAfter.awaitingDispositionTaskIds.push('task_0');
  assert.equal(gradeCompactionOperationalContinuity(progressed).passed, true, 'The active child may finish naturally while its result stays pending');
});

test('first-boundary continuity rejects absent, failed, ambiguous and unmixed result states', () => {
  for (const mutate of [
    value => { value.firstBefore.tasks[1].status = 'running'; value.firstBefore.activeTaskIds.push('task_1'); },
    value => { value.firstBefore.tasks[0].status = 'completed'; },
    value => { value.firstBefore.tasks[0].status = 'queued'; },
    value => { value.firstBefore.tasks[1].status = 'failed'; },
    value => { value.firstBefore.envelopes = []; },
    value => { value.firstBefore.envelopes[0].status = 'failed'; },
    value => { value.firstBefore.envelopes[0].action = 'continue'; },
    value => { value.firstBefore.envelopes[0].taskId = 'unrelated_task'; },
    value => { value.firstBefore.envelopes[0].envelopeId = null; },
    value => { value.firstBefore.envelopes.push({ ...value.firstBefore.envelopes[0], envelopeId: 'replacement' }); },
    value => { value.firstBefore.tasks[1].dispatchCallId = 'unrelated_dispatch'; },
    value => { value.firstBefore.tasks[1].childSessionId = 'unrelated_child'; },
  ]) {
    const value = managed(); mutate(value);
    assert.equal(projectQaCompactionBoundaryCohort(value.firstBefore, value.cohort).passed, false, mutate.toString());
    assert.equal(gradeCompactionOperationalContinuity(value).passed, false);
  }
  for (const stage of ['firstAfter', 'completedBeforeSecond']) {
    const value = managed(); value[stage].envelopes.find(item => item.taskId === 'task_1').envelopeId = 'replacement';
    assert.equal(gradeCompactionOperationalContinuity(value).passed, false, `${stage} must retain the original result identity`);
  }
});

test('Builder continuity fails empty baselines and repeated paused source reads or RED commands', () => {
  const baselineActions = { completedInspections: [{ callId: 'read_one', actionId: 'source-read-hash' }], failedTests: [{ callId: 'red_one', actionId: 'qa-original-tests-red' }] };
  const input = { agent: 'builder', baselineActions, pausedActions: structuredClone(baselineActions), projectGrade: { passed: true } };
  assert.equal(gradeCompactionOperationalContinuity(input).passed, true);
  for (const field of ['completedInspections', 'failedTests']) {
    const value = structuredClone(input); value.pausedActions[field].push({ ...value.baselineActions[field][0], callId: 'repeated' });
    assert.equal(gradeCompactionOperationalContinuity(value).passed, false);
  }
  assert.equal(gradeCompactionOperationalContinuity({ ...input, baselineActions: {} }).passed, false);
});


test('manual and natural task evidence brackets a native hook with immutable exact attempts, not an atomic snapshot claim', () => {
  const input = managed();
  for (const task of input.firstBefore.tasks) Object.assign(task, { attempt: 1, executionKind: 'start', priorTaskId: null, recoveryLineageId: null });
  const before = { requestStartedAt: 80, responseCompletedAt: 90, snapshot: input.firstBefore };
  const after = { requestStartedAt: 110, responseCompletedAt: 120, snapshot: structuredClone(input.firstBefore) };
  const options = { snapshots: [before, after], cohort: input.cohort, nativeStartedAt: 100 };
  const result = projectQaCompactionBoundaryBracket(options);
  assert.equal(result.passed, true);
  assert.equal(result.source, 'bracketed-authoritative-task-snapshots');
  assert.deepEqual([result.intervalStartedAt, result.intervalEndedAt], [90, 110]);
  for (const mutate of [
    value => { value.gap = 'bounded evidence exhausted'; },
    value => { value.nativeStartedAt = NaN; },
    value => { value.snapshots = [value.snapshots[0]]; },
    value => { value.snapshots[0].responseCompletedAt = 100; },
    value => { value.snapshots[1].requestStartedAt = 100; },
    value => { value.snapshots[0].requestStartedAt = 95; },
    value => { delete value.snapshots[1].responseCompletedAt; },
    value => { value.snapshots[1].snapshot.tasks[0].status = 'completed'; },
    value => { value.snapshots[1].snapshot.tasks[0].status = 'queued'; },
    value => { value.snapshots[1].snapshot.tasks[0].childSessionId = 'ses_replacement'; },
    value => { value.snapshots[1].snapshot.tasks[0].dispatchCallId = 'call_replacement'; },
    value => { value.snapshots[1].snapshot.tasks[0].attempt = 2; },
    value => { value.snapshots[1].snapshot.tasks[0].executionKind = 'resume'; },
    value => { value.snapshots[1].snapshot.tasks[0].priorTaskId = 'prior_replacement'; },
    value => { value.snapshots[1].snapshot.tasks[0].recoveryLineageId = 'lineage_replacement'; },
    value => { delete value.snapshots[1].snapshot.tasks[0].attempt; },
    value => { value.snapshots[1].snapshot.envelopes[0].action = 'continue'; },
    value => { value.snapshots[1].snapshot.envelopes[0].envelopeId = 'envelope_replacement'; },
  ]) {
    const changed = structuredClone(options); mutate(changed);
    assert.equal(projectQaCompactionBoundaryBracket(changed).passed, false, mutate.toString());
  }
  const hiddenIntermediateLoss = structuredClone(options);
  hiddenIntermediateLoss.snapshots.splice(1, 0, { requestStartedAt: 96, responseCompletedAt: 99,
    snapshot: { state: 'unavailable', reason: 'unavailable nearest observation' } });
  assert.equal(projectQaCompactionBoundaryBracket(hiddenIntermediateLoss).passed, false,
    'The nearest complete sample is authoritative; do not skip it to cherry-pick an older mixed state');
});

test('a mixed pre-request snapshot cannot establish a mixed cohort at native compaction start', () => {
  const input = managed();
  const completed = structuredClone(input.firstBefore);
  completed.tasks[0].status = 'completed';
  completed.activeTaskIds = [];
  completed.awaitingDispositionTaskIds.push('task_0');
  completed.envelopes.push({ taskId: 'task_0', envelopeId: 'envelope_0', status: 'completed', action: null, acknowledgedAt: null });
  const snapshots = [
    { requestStartedAt: 20, responseCompletedAt: 30, snapshot: input.firstBefore },
    { requestStartedAt: 80, responseCompletedAt: 90, snapshot: completed },
    { requestStartedAt: 110, responseCompletedAt: 120, snapshot: completed },
    { requestStartedAt: 210, responseCompletedAt: 220, snapshot: completed },
  ];
  assert.equal(projectQaCompactionBoundaryCohort(snapshots[0].snapshot, input.cohort).passed, true);
  assert.equal(projectQaCompactionSummaryExit({ snapshots, before: snapshots[0].snapshot, cohort: input.cohort,
    summaryCompletedAt: 200, nativeCycle: { startedAt: 100, completedAt: 202 } }).passed, true);
  assert.equal(projectQaCompactionBoundaryBracket({ snapshots, cohort: input.cohort, nativeStartedAt: 100 }).passed, false,
    'The nearest native-start bracket must reject completed children even when the pre-request and summary-exit checks pass');
});

test('summary exit requires real wholly-after-completion pending evidence and permits natural child completion', () => {
  const input = managed();
  const options = { before: input.firstBefore, cohort: input.cohort, summaryCompletedAt: 100,
    nativeCycle: { startedAt: 50, completedAt: 105 }, snapshots: [input.firstSummaryExit.sample] };
  assert.equal(projectQaCompactionSummaryExit(options).passed, true);
  const finished = structuredClone(options);
  finished.snapshots[0].snapshot.tasks[0].status = 'completed';
  finished.snapshots[0].snapshot.envelopes.push({ taskId: 'task_0', envelopeId: 'envelope_0', status: 'completed', action: null, acknowledgedAt: null });
  assert.equal(projectQaCompactionSummaryExit(finished).passed, true);
  for (const mutate of [
    value => { value.snapshots = []; },
    value => { value.snapshots[0].requestStartedAt = 99; },
    value => { value.snapshots[0].requestStartedAt = 100; },
    value => { value.snapshots[0].responseCompletedAt = 109; },
    value => { value.summaryCompletedAt = NaN; },
    value => { value.nativeCycle.completedAt = 99; },
    value => { value.nativeCycle.startedAt = 101; },
    value => { value.nativeCycle = null; },
    value => { value.gap = 'snapshot gap'; },
    value => { value.snapshots[0].snapshot.tasks[0].attempt = 2; },
    value => { value.snapshots[0].snapshot.tasks[0].recoveryLineageId = 'replacement'; },
    value => { value.snapshots[0].snapshot.tasks[1].executionKind = 'resume'; },
    value => { value.snapshots[0].snapshot.envelopes[0].envelopeId = 'replacement'; },
    value => { value.snapshots[0].snapshot.envelopes[0].action = 'continue'; },
    value => { value.snapshots[0].snapshot.envelopes[0].acknowledgedAt = 115; },
    value => { delete value.snapshots[0].snapshot.envelopes[0].acknowledgedAt; },
    value => { value.snapshots.unshift({ requestStartedAt: 101, responseCompletedAt: 109, snapshot: input.completedBeforeSecond }); },
  ]) {
    const value = structuredClone(options); mutate(value);
    assert.equal(projectQaCompactionSummaryExit(value).passed, false, mutate.toString());
  }
});

test('late native collection after the recorded summary exit passes exact timing and identity checks', () => {
  const input = managed();
  const options = { exit: input.firstSummaryExit, after: input.completedBeforeSecond,
    cohort: input.cohort, dispositions: input.pausedActions.dispositions };
  assert.equal(isQaCompactionPostSummaryCohortPreserved(options), true,
    'A post-idle/reload consumed envelope must not be regraded as pending at summary exit');
  assert.equal(gradeCompactionOperationalContinuity(input).passed, true);
  for (const mutate of [
    value => { value.dispositions[0].startedAt = 99; },
    value => { value.dispositions[0].startedAt = 100; },
    value => { delete value.dispositions[0].startedAt; },
    value => { delete value.dispositions[0].completedAt; },
    value => { value.dispositions[0].completedAt = 149; },
    value => { value.after.envelopes[0].acknowledgedAt = 99; },
    value => { value.after.envelopes[0].acknowledgedAt = 149; },
    value => { value.after.envelopes[0].acknowledgedAt = 181; },
    value => { value.after.envelopes[0].acknowledgedAt = null; },
    value => { value.after.envelopes[0].action = 'retry'; },
    value => { value.after.envelopes[1].envelopeId = 'replacement'; },
    value => { value.after.tasks[0].attempt = 2; },
    value => { value.after.tasks[0].status = 'running'; },
    value => { value.dispositions.push({ ...value.dispositions[0], callId: 'duplicate_continue' }); },
    value => { value.dispositions = []; },
  ]) {
    const value = structuredClone(options); mutate(value);
    assert.equal(isQaCompactionPostSummaryCohortPreserved(value), false, mutate.toString());
  }
  const delayedObserver = structuredClone(options);
  delayedObserver.exit.nativeCycle.completedAt = 175;
  assert.equal(isQaCompactionPostSummaryCohortPreserved(delayedObserver), true,
    'Canonical summary completion, not later observer delivery, governs post-summary action timing');
});

test('continue timing comes only from finalized canonical tool state', () => {
  const call = part('call_continue', 'devryan_task', { action: 'continue', task_id: 'task_0' });
  call.state.time = { start: 150, end: 180 };
  const rows = [{ info: { id: 'msg_continue', role: 'assistant', sessionID: 'ses_root' }, parts: [call] }];
  const project = () => projectCompactionActions(rows, { rootSessionID: 'ses_root' }).dispositions[0];
  assert.deepEqual(project(), { callId: 'call_continue', sourceMessageId: 'msg_continue', taskId: 'task_0', startedAt: 150, completedAt: 180 });
  delete call.state.time;
  assert.equal(project().startedAt, null); assert.equal(project().completedAt, null);
  call.state.status = 'running';
  assert.equal(project(), undefined);
});

const phased = () => {
  const cohort = managed().cohort;
  const task = (index, status, childSessionId = cohort[index].childSessionId) => ({ taskId: cohort[index].taskId,
    childSessionId, dispatchCallId: cohort[index].callId, status, attempt: 1, executionKind: 'start', priorTaskId: null, recoveryLineageId: null });
  const envelope = (index, collected = false) => ({ taskId: cohort[index].taskId, envelopeId: `envelope_${index}`, status: 'completed',
    action: collected ? 'continue' : null, acknowledgedAt: collected ? [310, 660][index] : null });
  const state = (tasks, envelopes = []) => ({ state: 'observed', tasks, envelopes,
    activeTaskIds: tasks.filter(item => ['queued', 'starting', 'running'].includes(item.status)).map(item => item.taskId),
    awaitingDispositionTaskIds: envelopes.filter(item => item.action === null).map(item => item.taskId) });
  const firstCollected = () => state([task(0, 'completed')], [envelope(0, true)]);
  const secondPending = () => state([task(0, 'completed'), task(1, 'completed')], [envelope(0, true), envelope(1)]);
  const bothCollected = () => state([task(0, 'completed'), task(1, 'completed')], [envelope(0, true), envelope(1, true)]);
  const sample = (stage, start, snapshot) => ({ stage, at: start + 10, requestStartedAt: start, responseCompletedAt: start + 10, snapshot });
  const snapshots = [sample('queued-1', 60, state([task(0, 'queued', null)])),
    sample('before-1', 80, state([task(0, 'running')])), sample('after-1', 110, state([task(0, 'running')])),
    sample('exit-1', 210, state([task(0, 'completed')], [envelope(0)])),
    sample('reload-1', 230, state([task(0, 'completed')], [envelope(0)])), sample('collect-1', 330, firstCollected()),
    sample('queued-2', 420, state([task(0, 'completed'), task(1, 'starting', null)], [envelope(0, true)])),
    sample('before-2', 480, secondPending()), sample('after-2', 510, secondPending()),
    sample('exit-2', 610, secondPending()), sample('reload-2', 630, secondPending()),
    sample('collect-2', 690, bothCollected()), sample('final', 800, bothCollected())];
  const boundaries = [0, 1].map(index => ({ source: 'opencode', auto: true, overflow: false, thresholdReached: true,
    nativeLifecycle: 'observed', eventId: `part_${index}`, summaryMessageId: `summary_${index}`, observedAt: [200, 600][index],
    nativeCycle: { startedAt: [100, 500][index], completedAt: [205, 605][index] } }));
  const witnesses = ['active', 'completed-awaiting'].map((coverage, index) => ({ boundaryIndex: index + 1, coverage,
    cohort: [cohort[index]], afterReload: snapshots.find(item => item.stage === `reload-${index + 1}`),
    afterCollection: snapshots.find(item => item.stage === `collect-${index + 1}`) }));
  const pausedActions = { starts: cohort, dispositions: cohort.map((item, index) => ({ callId: `continue_${index}`, taskId: item.taskId,
    startedAt: [300, 650][index], completedAt: [320, 680][index] })) };
  return { cohort, witnesses, boundaries, snapshots, finalSnapshot: snapshots.at(-1), baselineActions: { starts: [] },
    pausedActions, continuedActions: structuredClone(pausedActions), projectGrade: { passed: true } };
};

test('separate natural phase witnesses pass without any simultaneous mixed cohort', () => {
  const value = phased();
  assert.equal(value.snapshots.some(item => projectQaCompactionBoundaryCohort(item.snapshot, value.cohort).passed), false);
  const grade = gradeQaNaturalCompactionOperationalContinuity(value);
  assert.equal(grade.passed, true, JSON.stringify(grade));
  for (const [index, coverage] of ['active', 'completed-awaiting'].entries()) {
    const witness = value.witnesses[index]; const boundary = value.boundaries[index];
    const bracket = projectQaCompactionBoundaryBracket({ snapshots: value.snapshots, cohort: witness.cohort,
      coverage, nativeStartedAt: boundary.nativeCycle.startedAt });
    assert.equal(bracket.passed, true);
    const exit = projectQaCompactionSummaryExit({ snapshots: value.snapshots, cohort: witness.cohort, coverage,
      before: bracket.before.snapshot, summaryCompletedAt: boundary.observedAt, nativeCycle: boundary.nativeCycle });
    assert.equal(exit.passed, true); assert.equal(exit.coverage, coverage);
    assert.equal(isQaCompactionPostSummaryCohortPreserved({ exit, after: witness.afterCollection.snapshot,
      cohort: witness.cohort, dispositions: value.continuedActions.dispositions }), true);
  }
  const running = phased();
  const exit = running.snapshots.find(item => item.stage === 'exit-1').snapshot;
  exit.tasks[0].status = 'running'; exit.envelopes = []; exit.activeTaskIds = ['task_0']; exit.awaitingDispositionTaskIds = [];
  assert.equal(gradeQaNaturalCompactionOperationalContinuity(running).passed, true, 'The active witness can remain running at summary exit and finish later');
});

test('single-witness policies retain strict nearest brackets, pending exits and exact attempts', () => {
  for (const coverage of ['active', 'completed-awaiting']) {
    const value = phased(); const index = coverage === 'active' ? 0 : 1;
    const witness = value.witnesses[index]; const boundary = value.boundaries[index];
    const options = { snapshots: value.snapshots, cohort: witness.cohort, coverage, nativeStartedAt: boundary.nativeCycle.startedAt };
    for (const mutate of [input => { input.coverage = 'optional'; }, input => { input.cohort = value.cohort; },
      input => { input.gap = 'truncated'; }, input => { input.snapshots.find(item => item.stage === `after-${index + 1}`).snapshot.tasks[index].attempt = 2; },
      input => { input.snapshots.push({ stage: 'nearer-unavailable', requestStartedAt: boundary.nativeCycle.startedAt + 1,
        responseCompletedAt: boundary.nativeCycle.startedAt + 2, snapshot: { state: 'unavailable' } }); }]) {
      const changed = structuredClone(options); mutate(changed);
      assert.equal(projectQaCompactionBoundaryBracket(changed).passed, false, mutate.toString());
    }
  }
});

test('natural journey rejects missing phases, early collection, hidden nearest losses and repeated work', () => {
  for (const mutate of [
    value => { value.witnesses.pop(); }, value => { value.witnesses[1].coverage = 'active'; },
    value => { delete value.witnesses[0].afterCollection; }, value => { delete value.finalSnapshot; },
    value => { value.witnesses[1].cohort = value.witnesses[0].cohort; },
    value => { value.boundaries[1].eventId = value.boundaries[0].eventId; },
    value => { value.boundaries[1].nativeCycle = value.boundaries[0].nativeCycle; },
    value => { value.boundaries[1].auto = false; }, value => { value.boundaries[1].thresholdReached = false; },
    value => { value.snapshotGap = 'missing samples'; }, value => { value.actionGap = 'truncated'; },
    value => { value.snapshots.push({ stage: 'nearer-consumed', requestStartedAt: 601, responseCompletedAt: 602,
      snapshot: structuredClone(value.finalSnapshot.snapshot) }); },
    value => { value.snapshots.push({ stage: 'nearer-unavailable', requestStartedAt: 201, responseCompletedAt: 202, snapshot: { state: 'unavailable' } }); },
    value => { value.snapshots.find(item => item.stage === 'before-2').snapshot.envelopes[0].envelopeId = 'replacement'; },
    value => { value.snapshots.find(item => item.stage === 'exit-2').snapshot.envelopes[1].acknowledgedAt = 590; },
    value => { value.snapshots.find(item => item.stage === 'queued-2').snapshot.tasks.shift(); },
    value => { const consumed = structuredClone(value.snapshots.find(item => item.stage === 'collect-2'));
      consumed.stage = 'transient-early-collection'; consumed.requestStartedAt = 560; consumed.responseCompletedAt = 570;
      value.snapshots.splice(9, 0, consumed); },
    value => { value.continuedActions.dispositions[0].startedAt = 200; },
    value => { value.continuedActions.dispositions[1].startedAt = 590; },
    value => { value.continuedActions.dispositions[1].completedAt = 659; },
    value => { value.continuedActions.dispositions.push({ ...value.continuedActions.dispositions[0], callId: 'duplicate_collection' }); },
    value => { value.pausedActions.starts.push({ ...value.cohort[0], marker: null, callId: 'unmarked_extra' }); },
    value => { value.continuedActions.starts.push({ ...value.cohort[1], callId: 'restart_after_approval' }); },
    value => { value.projectGrade.passed = false; },
  ]) {
    const value = phased(); mutate(value);
    assert.equal(gradeQaNaturalCompactionOperationalContinuity(value).passed, false, mutate.toString());
  }
});

test('global identity allows first child binding but rejects transient or cross-phase dispatch and attempt reuse', () => {
  const project = value => projectQaCompactionGlobalIdentity({ snapshots: value.snapshots,
    actionStages: [value.baselineActions, value.pausedActions, value.continuedActions] });
  assert.equal(project(phased()).passed, true);
  for (const mutate of [
    value => { value.snapshots[2].snapshot.tasks[0].attempt = 2; },
    value => { value.snapshots[2].snapshot.tasks[0].recoveryLineageId = 'replacement'; },
    value => { value.snapshots[7].snapshot.tasks[1].dispatchCallId = value.cohort[0].callId; },
    value => { value.snapshots[7].snapshot.tasks[1].childSessionId = value.cohort[0].childSessionId; },
    value => { value.snapshots[7].snapshot.tasks[1].priorTaskId = value.cohort[0].taskId; },
    value => { value.snapshots[7].snapshot.tasks.push({ ...value.snapshots[7].snapshot.tasks[0] }); },
    value => { value.snapshots[7].snapshot.tasks[0].status = 'running'; },
    value => { value.finalSnapshot.snapshot.envelopes[1].envelopeId = value.finalSnapshot.snapshot.envelopes[0].envelopeId; },
    value => { value.finalSnapshot.snapshot.envelopes[0].acknowledgedAt = 799; },
    value => { value.continuedActions.starts[0].taskId = value.cohort[1].taskId; },
    value => { value.continuedActions.identityConflicts = [{ callId: value.cohort[0].callId, field: 'taskId' }]; },
  ]) {
    const value = phased(); mutate(value);
    assert.equal(project(value).passed, false, mutate.toString());
  }
});

test('canonical action merge preserves discovered bindings and retains rebinding failures after later restoration', () => {
  const start = phased().cohort[0];
  const unknown = { starts: [{ ...start, taskId: null, childSessionId: null }] };
  const known = mergeCompactionActions(unknown, { starts: [start] });
  assert.equal(known.identityConflicts, undefined);
  assert.deepEqual(mergeCompactionActions(known, unknown).starts, [start]);
  const rebound = mergeCompactionActions(known, { starts: [{ ...start, childSessionId: 'replacement' }] });
  assert.ok(rebound.identityConflicts.length > 0);
  assert.ok(mergeCompactionActions(rebound, known).identityConflicts.length > 0);
  const unmarked = mergeCompactionActions(known, { starts: [{ ...start, marker: null }] });
  assert.ok(unmarked.identityConflicts.length > 0, 'Removing the marker cannot hide a reused canonical call');
});

test('global identity rejects disappearing and restored records but permits older overlapping empty observations', () => {
  const input = phased();
  const snapshot = structuredClone(input.snapshots.find(item => item.stage === 'exit-1').snapshot);
  const sample = (requestStartedAt, responseCompletedAt, observed) => ({ requestStartedAt, responseCompletedAt, snapshot: observed });
  const full = sample(10, 11, snapshot);
  const empty = { state: 'observed', tasks: [], envelopes: [] };
  const project = snapshots => projectQaCompactionGlobalIdentity({ snapshots,
    actionStages: [{ starts: [input.cohort[0]] }] });
  assert.equal(project([full, sample(20, 21, empty), sample(30, 31, snapshot)]).passed, false);
  assert.equal(project([full, sample(5, 21, empty), sample(30, 31, snapshot)]).passed, true,
    'An older in-flight response cannot prove that a later observed identity disappeared');
  assert.equal(project([full, sample(20, 21, { ...snapshot, envelopes: [] }), sample(30, 31, snapshot)]).passed, false);
  const lostChild = structuredClone(snapshot); lostChild.tasks[0].childSessionId = null;
  assert.equal(project([full, sample(20, 21, lostChild), sample(30, 31, snapshot)]).passed, false);
});
