import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gradeQaProject } from './acceptance-graders.mjs';
import { QA_PROJECT_PROTECTED_PATHS } from './project-fixture.mjs';
import { gradeCompactionOperationalContinuity, isQaCompactionPostSummaryCohortPreserved, projectQaCompactionSummaryExit, mergeCompactionActions, projectCompactionActions, projectQaCompactionBoundaryBracket, projectQaCompactionBoundaryCohort, QA_COMPACTION_INVESTIGATION_MARKERS } from './compaction-action-evidence.mjs';
import { projectQaPlanChildPolicy } from './live-task-evidence.mjs';
import { assertQaCompactionPlanUnchanged, captureQaCompactionPlanReference, captureQaCompactionProjectPlan, prepareQaCompactionApproval } from './compaction-approval.mjs';
import { createQaCompactionSnapshotRecorder, createQaCompactionActionSnapshotRecorder, decodeQaCompactionSnapshots } from './compaction-snapshot-evidence.mjs';
import { readQaManualCompactionQueueMode, withQaManualCompactionSubmission } from './manual-compaction-submission.mjs';
import { findQaSubmittedUser } from './submitted-turn.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const messageText = row => row.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');

export function findQaPlanApprovalUser(rows, previousIds, { sessionID, sourceMessageID, cell, nativeAgent }) {
  const prefix = '[openchamber-plan-action:v1] ';
  const candidates = rows.filter(row => row.info?.role === 'user' && !previousIds.has(row.info.id)
    && row.parts?.some(part => part.type === 'text' && part.synthetic === true && part.text?.startsWith(prefix)));
  if (!candidates.length) return null;
  assert.equal(candidates.length, 1, 'Plan approval produced multiple canonical requests');
  const user = candidates[0];
  const markers = user.parts.filter(part => part.type === 'text' && part.synthetic === true && part.text?.startsWith(prefix));
  assert.equal(markers.length, 1, 'Plan approval must have exactly one source marker');
  assert.deepEqual(JSON.parse(markers[0].text.slice(prefix.length)), {
    action: 'implement', sourceSessionId: sessionID, sourceMessageId: sourceMessageID, planIndex: 0,
  }, 'Plan approval changed the source revision');
  assert.equal(user.info.sessionID, sessionID, 'Plan approval changed the session');
  assert.equal(user.info.model?.providerID, cell.providerId, 'Plan approval changed the provider');
  assert.equal(user.info.model?.modelID, cell.modelId, 'Plan approval changed the model');
  assert.ok(cell.agent === 'builder' ? ['build','builder'].includes(nativeAgent) : nativeAgent === 'orchestrator', 'The resolved native primary agent is unavailable');
  assert.equal(user.info.agent, nativeAgent, 'Plan approval changed the primary agent');
  assert.equal(user.info.model?.variant ?? user.info.variant ?? '', cell.variant ?? '', 'Plan approval changed thinking');
  assert.equal(user.parts.some(part => part.type === 'compaction' || (part.type === 'text' && part.synthetic === true
    && part.text?.trim().startsWith('User has requested to enter plan mode'))), false, 'Plan approval must leave Plan mode');
  return user;
}

export function findQaNativeCompactionCycle(events, summaryCompletedAt) {
  if (!Number.isFinite(summaryCompletedAt)) return null;
  let startedAt = null;
  for (const event of events.filter(item => Number.isFinite(item.at)
    && ['native.compacting','native.session.compacted'].includes(item.kind)).toSorted((a,b)=>a.at-b.at)) {
    if (event.kind === 'native.compacting') { startedAt = event.at; continue; }
    if (startedAt !== null && startedAt <= summaryCompletedAt && event.at >= summaryCompletedAt
      && event.at <= summaryCompletedAt + 5000) return { startedAt, completedAt: event.at };
    startedAt = null;
  }
  return null;
}

// A typed compaction part linked to a completed summary is the native boundary.
// A recap, slash-command text, or a summary from another turn cannot substitute.
export function findManualCompactionBoundary(rows, previousPartIds = []) {
  const previous = new Set(previousPartIds);
  for (const row of rows) {
    if (row.info?.role !== 'user') continue;
    const part = row.parts?.find(item => item.type === 'compaction' && item.auto === false && !previous.has(item.id));
    if (!part) continue;
    const summary = rows.find(item => item.info?.role === 'assistant' && item.info.parentID === row.info.id
      && item.info.summary === true && item.info.time?.completed && !item.info.error && messageText(item).trim());
    if (!summary) continue;
    return { source: 'opencode', trigger: 'manual', requestKind: 'manual', eventId: part.id,
      boundaryMessageId: row.info.id, summaryMessageId: summary.info.id, observedAt: summary.info.time.completed,
      summarySha256: digest(messageText(summary)), summaryBytes: Buffer.byteLength(messageText(summary)),
      auto: part.auto, overflow: part.overflow === true };
  }
  return null;
}

export function projectCompactionTaskSnapshot(snapshot, rootSessionId) {
  if (!snapshot || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.resultEnvelopes)) {
    return { state: 'unavailable', reason: 'invalid snapshot contract' };
  }
  if (snapshot.available !== true || snapshot.bridgeReady !== true || snapshot.recoveryWarning) {
    return { state: 'unavailable', reason: 'managed runtime not ready' };
  }
  const tasks = snapshot.tasks.filter(task => task.rootSessionId === rootSessionId).map(task => ({
    taskId: task.taskId, childSessionId: task.childSessionId, status: task.status,
    dispatchCallId: task.dispatchCallId, priorTaskId: task.priorTaskId, executionKind: task.executionKind,
    readOnly: task.readOnly, createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
    attempt: task.attempt, recoveryLineageId: task.recoveryLineageId,
  }));
  const envelopes = snapshot.resultEnvelopes.filter(item => item.rootSessionId === rootSessionId).map(item => ({
    taskId: item.taskId, envelopeId: item.envelopeId, status: item.status, action: item.action,
    createdAt: item.createdAt, acknowledgedAt: item.acknowledgedAt, followUpTaskId: item.followUpTaskId,
  }));
  const activeTaskIds = tasks.filter(task => !terminal.has(task.status)).map(task => task.taskId);
  const awaitingDispositionTaskIds = tasks.filter(task => {
    const results = envelopes.filter(item => item.taskId === task.taskId);
    return task.status === 'completed' && results.length === 1 && results[0].status === 'completed'
      && typeof results[0].envelopeId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(results[0].envelopeId)
      && results[0].action === null;
  }).map(task => task.taskId);
  return { state: 'observed', tasks, envelopes, activeTaskIds, awaitingDispositionTaskIds };
}

export async function runQaManualCompaction({ cell, projectFixture, cdp, ui, api, check, screenshot, runDeadline,
  sendTurn, messages, getSessionID, captureSavedPlan, readSavedRevision, readProviderObservation, nativeAgent }) {
  const composedProject = cell?.scenarioId === 'project-work' && cell.runtime === 'electron' && cell.projectCompaction === 'manual';
  if (cell?.transport !== 'live' || (cell.scenarioId !== 'compaction-manual' && !composedProject)) throw new Error('Manual compaction requires a live manual matrix cell or opted-in Electron project journey');
  const snapshotRecorder = createQaCompactionSnapshotRecorder();
  const actionSnapshotRecorder = createQaCompactionActionSnapshotRecorder();
  const evidence = { source: 'opencode', mode: 'manual', planMode: cell.planMode, boundaries: [], plans: [],
    managedSnapshots: snapshotRecorder.data, nativeLifecycle: 'not-yet-observed', behaviorCoverage: 'domain, storage, HTTP and restart; browser presentation requires separate acceptance',
    continuityClaims: { completedWorkNotRepeated: 'operational-grade-pending', rejectedSorting: 'browser-acceptance-required' },
    actions: mergeCompactionActions(), actionSnapshots: actionSnapshotRecorder.data, submittedUserMessageIDs: [], manualSubmissions: [] };
  const persist = () => writeFile(path.join(projectFixture.evidenceDirectory, 'compaction-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const scope = () => new URLSearchParams({ rootSessionId: getSessionID(), directory: projectFixture.fixtureRoot });
  const snapshot = async stage => {
    if (cell.agent !== 'orchestrator' || !getSessionID()) return;
    const requestStartedAt = Date.now();
    let projection;
    try { projection = projectCompactionTaskSnapshot(await api(`/api/orchestration/snapshot?${scope()}`), getSessionID()); }
    catch { projection = { state: 'unavailable', reason: 'snapshot request failed' }; }
    const responseCompletedAt = Date.now();
    snapshotRecorder.record({ stage, requestStartedAt, responseCompletedAt, snapshot: projection });
    if (snapshotRecorder.gap) evidence.managedSnapshotGap = snapshotRecorder.gap;
    evidence.managedSnapshotReadErrors = snapshotRecorder.unavailableReads;
    return projection;
  };
  const captureActions = async stage => {
    const observed = await snapshot(stage);
    const rows = await messages();
    evidence.actions = mergeCompactionActions(evidence.actions, projectCompactionActions(rows, {
      directory: projectFixture.fixtureRoot, snapshot: observed, rootSessionID: getSessionID(),
    }));
    actionSnapshotRecorder.record({ stage, at: Date.now(), callCounts: Object.fromEntries(Object.entries(evidence.actions).map(([key, value]) => [key, value.length])) });
    if (actionSnapshotRecorder.gap) evidence.actionSnapshotGap = actionSnapshotRecorder.gap;
    await persist();
    return { snapshot: observed, rows };
  };
  const assertPendingCohort = observed => {
    const mixed = projectQaCompactionBoundaryCohort(observed, evidence.investigationCohort);
    evidence.firstBoundaryPrecondition = mixed;
    assert.ok(mixed.passed, `The first compaction boundary is unavailable: ${mixed.reason}`);
  };
  const observeDuring = async (stage, action) => {
    let done = false;
    const sampling = (async () => { while (!done) { await snapshot(stage); if (!done) await pause(500); } })();
    try { return await action(); } finally { done = true; await sampling; await snapshot(`${stage}:settled`); await persist(); }
  };
  const readState = async savedPlan => ({
    repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectFixture.fixtureRoot, encoding: 'utf8' }).trim(),
    preservedFileHashes: Object.fromEntries(await Promise.all(QA_PROJECT_PROTECTED_PATHS.map(async file => [file, digest(await readFile(path.join(projectFixture.fixtureRoot, file)))]))),
    planSha256: digest(await readFile(savedPlan.path)), sourceMessageID: savedPlan.sourceMessageID, objectiveRevision: 2, phase: 'paused-before-implementation',
    planReference: evidence.expectedPausedState
      ? await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision })
      : await captureQaCompactionPlanReference({ planMode: cell.planMode, projectFixture, savedPlan, readSavedRevision }),
  });
  const capturePlan = async (name, userMessageID) => {
    let saved;
    if (cell.planMode) saved = await captureSavedPlan(name, { userMessageID });
    else {
      const candidate = (await captureQaCompactionProjectPlan(projectFixture)).realPath;
      const content = await readFile(candidate, 'utf8');
      assert.ok(content.trim(), 'The requested saved plan is empty');
      saved = { path: path.join(projectFixture.evidenceDirectory, `${name}.md`), sha256: digest(content), sourceMessageID: null,
        provenance: 'saved-project-file', canonicalPath: '.opencode/plans/qa-current.md' };
      await writeFile(saved.path, content, { mode: 0o600 });
    }
    evidence.plans.push(saved);
    return saved;
  };
  const submitPlan = async (name, text) => {
    const previousIds = new Set(getSessionID() ? (await messages()).map(row => row.info.id) : []);
    const rows = await sendTurn(text);
    const submitted = findQaSubmittedUser(rows, previousIds, text);
    assert.ok(submitted, 'Planning requires the exact canonical human request');
    return capturePlan(name, submitted.info.id);
  };
  const pausedGrade = savedPlan => {
    const grade = gradeQaProject({ fixture: projectFixture, phase: 'plan', savedPlan });
    assert.ok(grade.passed, 'Paused compaction work changed implementation or failed to save the plan');
    return grade;
  };
  const waitAfterCard = async (previousIds, sourceMessageID) => ui.waitFor('completed plan-card implementation', async () => {
    const rows = await messages();
    const user = findQaPlanApprovalUser(rows, previousIds, { sessionID: getSessionID(), sourceMessageID, cell, nativeAgent });
    if (!user) return false;
    if (!evidence.submittedUserMessageIDs.includes(user.info.id)) evidence.submittedUserMessageIDs.push(user.info.id);
    const answers = rows.filter(row => row.info?.role === 'assistant' && row.info.parentID === user.info.id);
    const failure = answers.find(row => row.info.error);
    if (failure) throw new Error(`Implementation failed: ${failure.info.error.name}`);
    const status = await api(`/api/session/status?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`);
    return answers.some(row => row.info.time?.completed && row.info.finish !== 'tool-calls')
      && (!status[getSessionID()] || status[getSessionID()].type === 'idle') ? rows : false;
  }, cell.timeoutMs);

  try {
    await check('observe actual queue preference before creating compaction witnesses', async () => {
      evidence.queueModeObservation = await readQaManualCompactionQueueMode({ cdp, ui });
      await persist();
    });
    await check('diagnose attached project and pause implementation before compaction', () => observeDuring('diagnosis', async () => {
      await ui.attach(projectFixture.attachments.map(item => item.path));
      const saved = await submitPlan('compaction-plan-revision-1', 'Investigate Task Board and the attached requirements and visual reference. Read the fixture AGENTS.md, then successfully read src/tasks.mjs with native read. Only after that source read completes, run standalone `node --test test/tasks.test.mjs` with native bash and observe the initial failure. Keep these calls sequential, never run the initial test before or concurrently with the read. If core policy disables execution, complete the read now and defer the native failing test until immediately after approval and before edits. After authorized implementation, run the same standalone native bash command and verify it passes. Preserve numeric exit statuses. Propose the complete repair and persisted priority feature. '
        + 'Implementation is paused until explicit approval regardless of the current Plan toggle. Do not modify implementation, tests, or dependencies. Preserve the existing user note and all compatibility contracts. '
        + (cell.agent === 'orchestrator' ? 'Delegate independent read-only domain/storage and browser investigations, handle each managed result once, and do not delegate writable work. ' : 'Investigate directly. ')
        + (cell.planMode ? 'Return the complete Markdown plan for the Plan card to save, then stop for a requirement revision.'
          : 'Save the full current plan at .opencode/plans/qa-current.md and return a complete Markdown plan, then stop for a requirement revision.'));
      evidence.sessionID = getSessionID();
      evidence.initialPlanGrade = pausedGrade(saved);
      await screenshot('compaction-diagnosis');
    }));
    let revisedPlan;
    await check('save revised requirements without implementing', () => observeDuring('revision', async () => {
      revisedPlan = await submitPlan('compaction-plan-revision-2', projectFixture.prompts.revision + ' Implementation remains paused. '
        + (cell.planMode ? 'Return the complete replacement Markdown plan for the Plan card to save and await approval.'
          : 'Save a complete replacement plan at .opencode/plans/qa-current.md, return the full plan, and wait for approval.'));
      assert.notEqual(revisedPlan.sha256, evidence.plans[0].sha256, 'Revision 2 must replace the saved plan');
      const content = await readFile(revisedPlan.path, 'utf8');
      assert.match(content, /creation order/i); assert.match(content, /priority filter/i);
      evidence.revisedPlanGrade = pausedGrade(revisedPlan);
      evidence.expectedPausedState = await readState(revisedPlan);
      await screenshot('compaction-revised-plan');
    }));
    await captureActions('paused-action-baseline');
    evidence.baselineActions = structuredClone(evidence.actions);

    if (cell.agent === 'orchestrator') {
      await check('leave exact read-only investigations pending for the first compaction boundary', () => observeDuring('pending-investigations', async () => {
        await sendTurn('Prepare the revised plan for a compaction continuity check. Start exactly two independent read-only Explorer tasks through devryan_task. '
          + `The first task prompt must include the exact marker ${QA_COMPACTION_INVESTIGATION_MARKERS[0]} and review revision 2 domain/persistence edge cases: stale and equal revisions, legacy normal priority, and restart consistency. `
          + `The second task prompt must include the exact marker ${QA_COMPACTION_INVESTIGATION_MARKERS[1]} and review revision 2 browser acceptance: creation order, Priority filter, visible text/color, and keyboard focus. `
          + 'Each task must inspect and report only, with no file edits or command execution. These reviews are pending obligations across the upcoming compaction. '
          + 'After both start calls return, end this parent turn. Do not wait, inspect status, read_result, continue, or acknowledge them yet; the next user instruction will authorize collection after compaction. '
          + 'Do not start other tasks, rewrite the saved plan, change todos, or modify project files. Preserve the current implementation pause.');
        const before = new Set(evidence.baselineActions.starts.map(item => item.callId));
        let captured;
        await ui.waitFor('one running seeded child and one completed undispositioned seeded result', async () => {
          captured = await captureActions('pending-investigations:children');
          const cohort = evidence.actions.starts.filter(item => !before.has(item.callId));
          if (cohort.length !== 2 || !cohort.every(item => item.taskId && item.childSessionId)) return false;
          assert.ok(QA_COMPACTION_INVESTIGATION_MARKERS.every(marker => cohort.filter(item => item.marker === marker).length === 1), 'Pending investigation markers do not match the requested tasks');
          evidence.investigationCohort = cohort;
          evidence.firstBoundaryPrecondition = projectQaCompactionBoundaryCohort(captured.snapshot, cohort);
          return evidence.firstBoundaryPrecondition.passed;
        }, cell.timeoutMs);
        if (cell.planMode) {
          const tree = [{ sessionId: getSessionID(), messages: captured.rows }];
          for (const item of evidence.investigationCohort) tree.push({ sessionId: item.childSessionId,
            messages: await api(`/api/session/${encodeURIComponent(item.childSessionId)}/message?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`) });
          const tasks = captured.snapshot.tasks.filter(task => evidence.investigationCohort.some(item => item.taskId === task.taskId));
          evidence.planChildPolicy = projectQaPlanChildPolicy(tree, getSessionID(), tasks);
          assert.ok(evidence.planChildPolicy.passed && evidence.planChildPolicy.children.length === 2, 'Plan-mode child read-only policy was not observed in canonical prompt permissions');
        }
        evidence.pendingInvestigationsGrade = pausedGrade(revisedPlan);
      }));
    }

    for (let index = 0; index < 2; index++) {
      if (index === 1) {
        await check('steering between compactions preserves the implementation pause', () => observeDuring('steering', async () => {
          const taskInstruction = cell.agent === 'orchestrator'
            ? `Collect the exact investigations ${evidence.investigationCohort.map(item => item.taskId).join(', ')} that are still pending. If the native managed lifecycle already continued an exact result, do not disposition it again. Otherwise use wait, read every result page if required, and continue each completed result exactly once. Do not start a replacement or repeated investigation. ` : '';
          await sendTurn(taskInstruction + 'Keep implementation paused and leave the approved candidate plan unchanged. Treat revision 2 as current, retain the rejected priority sorting decision and all unfinished obligations. Inspect the saved plan and current task state only; do not reread completed source inspections or rerun failed tests. Briefly acknowledge readiness and await approval without editing files.');
          evidence.betweenCompactionsGrade = pausedGrade(revisedPlan);
          await captureActions('between-boundaries:dispositioned');
        }));
      }
      await check(`manual native compaction boundary ${index + 1}`, () => observeDuring(`compaction-${index + 1}`, async () => {
        await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision });
        const before = (await messages()).flatMap(row => row.parts.filter(part => part.type === 'compaction').map(part => part.id));
        const startedAt = Date.now();
        const stateBefore = await captureActions(`before-boundary-${index + 1}`);
        if (cell.agent === 'orchestrator') {
          if (index === 0) { assertPendingCohort(stateBefore.snapshot); evidence.firstBoundaryTasksBeforeRequest = stateBefore.snapshot; }
          else evidence.completedTasksBeforeSecondBoundary = stateBefore.snapshot;
        }
        const submission = { boundaryIndex: index + 1 };
        evidence.manualSubmissions.push(submission);
        const boundary = await withQaManualCompactionSubmission({ cdp, ui,
          origin: evidence.queueModeObservation.origin, sessionID: getSessionID(),
          queueModeEnabled: evidence.queueModeObservation.enabled, deadline: runDeadline, receipt: submission, persist }, async observer => {
          const observed = await ui.waitFor('canonical manual compaction and completed summary', async () => {
            observer.assertHealthy();
            return findManualCompactionBoundary(await messages(), before);
          }, cell.timeoutMs);
          observed.sessionID = getSessionID();
          assert.equal(observed.sessionID, evidence.sessionID, 'Manual compaction changed the project session');
          if (cell.agent === 'orchestrator' && index === 0) await snapshot('first-summary-exit:observed');
          return observed;
        });
        await ui.waitFor('session idle after manual compaction', async () => {
          const status = await api(`/api/session/status?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`);
          return !status[getSessionID()] || status[getSessionID()].type === 'idle';
        }, cell.timeoutMs);
        boundary.nativeEvents = [];
        try {
          await ui.waitFor('native observer flush', async () => {
            const observations = await readProviderObservation();
            assert.ok(Array.isArray(observations), 'Provider observation must be parsed records');
            boundary.nativeEvents = observations.filter(item => item.sessionID === getSessionID() && item.at >= startedAt
              && item.at <= boundary.observedAt + 5000
              && ['native.compacting', 'native.session.compacted', 'native.compaction.autocontinue'].includes(item.kind));
            boundary.nativeCycle = findQaNativeCompactionCycle(boundary.nativeEvents, boundary.observedAt);
            return boundary.nativeCycle;
          }, 5000);
        } catch (error) {
          if (error.message !== 'Timed out: native observer flush') throw error;
        }
        boundary.nativeLifecycle = boundary.nativeCycle ? 'observed' : 'missing';
        evidence.boundaries.push(boundary);
        if (cell.agent === 'orchestrator' && index === 0) {
          const bracket = projectQaCompactionBoundaryBracket({ snapshots: decodeQaCompactionSnapshots(evidence.managedSnapshots), cohort: evidence.investigationCohort,
            nativeStartedAt: boundary.nativeCycle?.startedAt, gap: evidence.managedSnapshotGap });
          evidence.firstBoundaryBracket = bracket;
          assert.ok(bracket.passed, `The first manual compaction has no strict bracketed mixed-cohort evidence: ${bracket.reason}`);
          evidence.firstBoundaryTasksBefore = bracket.before.snapshot;
          const exit = projectQaCompactionSummaryExit({ snapshots: decodeQaCompactionSnapshots(evidence.managedSnapshots),
            before: evidence.firstBoundaryTasksBefore, cohort: evidence.investigationCohort,
            summaryCompletedAt: boundary.observedAt, nativeCycle: boundary.nativeCycle, gap: evidence.managedSnapshotGap });
          evidence.firstBoundarySummaryExit = exit;
          assert.ok(exit.passed, `First manual summary-exit coverage is unavailable: ${exit.reason}`);
          evidence.firstBoundaryTasksAfter = exit.sample.snapshot;
        }
        await screenshot(`compaction-boundary-${index + 1}`);
        await ui.reload();
        const restored = findManualCompactionBoundary(await messages(), before);
        assert.equal(restored?.summaryMessageId, boundary.summaryMessageId, 'Reload lost the canonical compaction summary');
        evidence.afterCompactionGrade = pausedGrade(revisedPlan);
        // Read the current authoritative plan again; the retained evidence copy
        // alone cannot reveal an accidental rewrite during compaction.
        evidence.observedPausedState = await readState(revisedPlan);
        assert.deepEqual(evidence.observedPausedState, evidence.expectedPausedState, 'Compaction changed the paused repository or current saved plan');
        const stateAfter = await captureActions(`after-boundary-${index + 1}`);
        boundary.continuation = { sessionID: getSessionID(), restoredSummaryMessageId: restored.summaryMessageId,
          pausedProjectGrade: evidence.afterCompactionGrade, observedPausedState: evidence.observedPausedState };
        if (cell.agent === 'orchestrator') {
          if (index === 0) {
            evidence.firstBoundaryTasksAfterReload = stateAfter.snapshot;
            assert.ok(isQaCompactionPostSummaryCohortPreserved({ exit: evidence.firstBoundarySummaryExit,
              after: stateAfter.snapshot, cohort: evidence.investigationCohort, dispositions: evidence.actions.dispositions }),
            'Reload changed a seeded task/result or its post-summary disposition timing');
          }
          else evidence.secondBoundaryTasksAfter = stateAfter.snapshot;
        }
      }));
    }
    let approvalPlan;
    if (cell.planMode) {
      await check('present the current saved plan as a fresh approval source', () => observeDuring('approval-preparation', async () => {
        const prepared = await prepareQaCompactionApproval({ projectFixture, priorSavedPlan: revisedPlan,
          expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision,
          messages, sendTurn, captureSavedPlan, evidenceName: 'compaction-plan-current-approval' });
        approvalPlan = prepared.savedPlan;
        evidence.approvalPreparation = prepared.evidence;
        await captureActions('approval-preparation:completed');
        await screenshot('compaction-current-plan-approval');
      }));
    }
    await captureActions('before-implementation-approval');
    await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision });
    evidence.pausedActions = structuredClone(evidence.actions);

    await check('resume from the current saved plan after repeated compaction', () => observeDuring('implementation', async () => {
      if (cell.planMode) {
        const current = approvalPlan;
        assert.ok(current, 'The fresh current Plan approval source is unavailable');
        const selector = `[data-plan-source-message-id=${JSON.stringify(current.sourceMessageID)}]`;
        const previousIds = new Set((await messages()).map(row => row.info.id));
        await ui.reveal(selector + ' button', 'Implement Plan', { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
        await ui.click({ selector: selector + ' button', text: 'Implement Plan' });
        evidence.approvalSurface = 'latest-plan-card';
        await waitAfterCard(previousIds, current.sourceMessageID);
      } else {
        evidence.approvalSurface = 'composer-with-plan-mode-off';
        await sendTurn(projectFixture.prompts.approve);
      }
      evidence.projectGrade = gradeQaProject({ fixture: projectFixture, phase: 'implemented' });
      evidence.implementationSessionID = getSessionID();
      assert.equal(evidence.implementationSessionID, evidence.sessionID, 'Post-compaction implementation changed the project session');
      assert.ok(evidence.projectGrade.passed, 'Post-compaction behavior failed independent domain/API/restart acceptance');
      await captureActions('implementation:completed');
      await screenshot('compaction-implemented');
    }));
    evidence.nativeLifecycle = evidence.boundaries.every(item => item.nativeLifecycle === 'observed') ? 'observed' : 'missing';
    evidence.managedContinuity = cell.agent !== 'orchestrator' ? 'not-applicable' : decodeQaCompactionSnapshots(evidence.managedSnapshots).some(item => item.stage.startsWith('before-boundary')
      && item.snapshot.state === 'observed' && (item.snapshot.activeTaskIds.length || item.snapshot.awaitingDispositionTaskIds.length)) ? 'boundary-task-state-observed' : 'no-active-or-awaiting-task-at-boundary';
    await check('manual native lifecycle is independently observed for both boundaries', async () => {
      assert.equal(evidence.nativeLifecycle, 'observed', 'Canonical summaries exist, but native compaction lifecycle evidence is missing');
    });
    await check('manual compaction preserves observed operational work across both boundaries', async () => {
      evidence.operationalContinuityGrade = gradeCompactionOperationalContinuity({ agent: cell.agent,
        baselineActions: evidence.baselineActions, pausedActions: evidence.pausedActions, continuedActions: evidence.actions,
        cohort: evidence.investigationCohort, firstBefore: evidence.firstBoundaryTasksBefore, firstAfter: evidence.firstBoundaryTasksAfter, firstSummaryExit: evidence.firstBoundarySummaryExit,
        completedBeforeSecond: evidence.completedTasksBeforeSecondBoundary, secondAfter: evidence.secondBoundaryTasksAfter, projectGrade: evidence.projectGrade });
      evidence.continuityClaims.completedWorkNotRepeated = evidence.operationalContinuityGrade.scope;
      assert.ok(evidence.operationalContinuityGrade.passed, 'Compaction operational continuity failed authoritative tool/ledger checks');
      assert.equal(evidence.managedSnapshotGap, undefined, 'A managed snapshot gap prevents a complete continuity claim');
      assert.equal(evidence.actionSnapshotGap, undefined, 'An action snapshot gap prevents a complete continuity claim');
    });
    evidence.outcome = 'passed-with-declared-coverage';
    return evidence;
  } catch (error) {
    evidence.outcome = 'failed'; evidence.error = error.message;
    throw error;
  } finally { await persist(); }
}
