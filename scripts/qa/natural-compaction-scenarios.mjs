import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gradeQaProject } from './acceptance-graders.mjs';
import { findQaNativeCompactionCycle, findQaPlanApprovalUser, projectCompactionTaskSnapshot } from './compaction-scenarios.mjs';
import { QA_PROJECT_PROTECTED_PATHS } from './project-fixture.mjs';
import { gradeCompactionOperationalContinuity, gradeQaNaturalCompactionOperationalContinuity, isQaCompactionPostSummaryCohortPreserved, projectQaCompactionSummaryExit, mergeCompactionActions, projectCompactionActions, projectQaCompactionBoundaryBracket, projectQaCompactionBoundaryCohort, QA_COMPACTION_INVESTIGATION_MARKERS } from './compaction-action-evidence.mjs';
import { projectQaPlanChildPolicy } from './live-task-evidence.mjs';
import { assertQaSubmittedPlanMode, findQaSubmittedUser } from './submitted-turn.mjs';
import { assertQaCompactionPlanUnchanged, captureQaCompactionPlanReference, captureQaCompactionProjectPlan, prepareQaCompactionApproval } from './compaction-approval.mjs';
import { createQaCompactionSnapshotRecorder, createQaCompactionActionSnapshotRecorder, decodeQaCompactionSnapshots } from './compaction-snapshot-evidence.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = row => (row.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
export const qaVisibleUserText = row => (row.parts ?? []).filter(part => part.type === 'text' && part.synthetic !== true).map(part => part.text ?? '').join('\n');
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_BATCHES_PER_BOUNDARY = 40;
export const QA_NATURAL_COMPACTION_PHASES = Object.freeze([
  Object.freeze({ boundaryIndex: 1, coverage: 'active', marker: QA_COMPACTION_INVESTIGATION_MARKERS[0] }),
  Object.freeze({ boundaryIndex: 2, coverage: 'completed-awaiting', marker: QA_COMPACTION_INVESTIGATION_MARKERS[1] }),
]);

export function createQaNaturalInvestigationPrompt(boundaryIndex) {
  assert.ok(boundaryIndex === 1 || boundaryIndex === 2, 'Natural witness boundary must be 1 or 2');
  const phase = QA_NATURAL_COMPACTION_PHASES[boundaryIndex - 1];
  const assignment = boundaryIndex === 1
    ? 'Assign an Oracle a focused read-only review of src/tasks.mjs, src/store.mjs and src/server.mjs against the current revision-2 saved plan, limited to stale/equal revision handling, legacy normal priority and restart consistency. Report at most three evidence-backed findings, then finish. '
    : 'Assign an Explorer to locate only the exact public asset files and selectors for creation ordering, the Priority filter, priority text/color and keyboard focus. Use at most two bounded search passes and return the relevant locations; do not review risk or propose a plan. ';
  return 'Prepare the revised plan for a natural compaction continuity check. Start exactly one independent read-only task through devryan_task. '
    + `Include the exact literal ${phase.marker} inside the prompt argument of the devryan_task start call, as its own first line. A label or parent reply alone does not identify the child prompt. ` + assignment
    + 'The task must stay read-only with no file edits or command execution and finish as soon as its assigned bounded work is complete. Do not ask it to sleep, poll, wait for compaction or prolong its work. '
    + 'After the start call returns, end this parent turn. Leave result collection to the existing managed lifecycle or a later collection instruction; do not suppress automatically delivered managed continuation instructions. '
    + 'Do not start other tasks, repeat a previous investigation, rewrite the saved plan, change todos, or modify project files. Preserve the implementation pause.';
}

// OpenCode 1.18.29's native Is/Dl and maxOutputTokens functions, verified
// against the pinned executable. Input limits take precedence over context.
// This projects the existing policy; it never writes config or model limits.
export function deriveQaNativeCompactionPolicy({ version, modelLimits, compaction, outputTokenMax }) {
  assert.equal(version, '1.18.29', 'Natural threshold evidence requires the verified OpenCode version');
  assert.ok(numeric(modelLimits?.context) && numeric(modelLimits?.output), 'Native model limits are unavailable');
  assert.notEqual(compaction?.auto, false, 'Native automatic compaction is disabled');
  assert.ok(modelLimits.context > 0, 'The selected model has no native context threshold');
  const configuredMax = outputTokenMax === undefined || outputTokenMax === '' ? 32000 : Number(outputTokenMax);
  assert.ok(Number.isSafeInteger(configuredMax) && configuredMax > 0, 'Native output-token cap is invalid');
  const maximumOutput = Math.min(modelLimits.output, configuredMax) || configuredMax;
  const reserved = compaction?.reserved ?? Math.min(20000, maximumOutput);
  assert.ok(numeric(reserved), 'Native compaction reserve is invalid');
  if (modelLimits.input !== null && modelLimits.input !== undefined) assert.ok(numeric(modelLimits.input), 'Native input limit is invalid');
  const usesInputLimit = !!modelLimits.input;
  const threshold = Math.max(0, usesInputLimit ? modelLimits.input - reserved : modelLimits.context - maximumOutput);
  assert.ok(threshold > 0, 'A positive natural compaction threshold is required');
  return { version, source: 'verified-native-1.18.29-policy', modelLimits, maximumOutput, reserved,
    automatic: compaction?.auto ?? 'native-default', configuredReserved: compaction?.reserved ?? null,
    configuredOutputTokenMax: outputTokenMax === undefined || outputTokenMax === '' ? null : configuredMax,
    threshold, thresholdBasis: usesInputLimit ? 'input-minus-reserved' : 'context-minus-maximum-output' };
}

export function qaNativeTokenUsage(tokens) {
  if (numeric(tokens?.total) && tokens.total > 0) return tokens.total;
  if (![tokens?.input, tokens?.output, tokens?.cache?.read, tokens?.cache?.write].every(numeric)) return null;
  return tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
}

export function findNaturalCompactionBoundaries(rows, { previousPartIds = [], threshold, observations = [], sessionID, startedAt = 0 } = {}) {
  const previous = new Set(previousPartIds);
  const found = [];
  const claimedCycles = new Set();
  for (const [index, row] of rows.entries()) {
    if (row.info?.role !== 'user') continue;
    const part = row.parts?.find(item => item.type === 'compaction' && item.auto === true && !previous.has(item.id));
    if (!part) continue;
    const summary = rows.find(item => item.info?.role === 'assistant' && item.info.parentID === row.info.id
      && item.info.summary === true && item.info.time?.completed && !item.info.error && textOf(item).trim());
    if (!summary) continue;
    const preceding = rows.slice(0, index).toReversed().find(item => item.info?.role === 'assistant'
      && item.info.summary !== true && item.info.time?.completed && !item.info.error);
    const usage = qaNativeTokenUsage(preceding?.info.tokens);
    const lowerBound = Math.max(startedAt, row.info.time?.created ?? 0);
    const nativeEvents = observations.filter(item => item.sessionID === sessionID && item.at >= lowerBound
      && item.at <= summary.info.time.completed + 5000
      && ['native.compacting', 'native.session.compacted', 'native.compaction.autocontinue'].includes(item.kind));
    let nativeCycle = findQaNativeCompactionCycle(nativeEvents, summary.info.time.completed);
    if (nativeCycle) {
      const cycleKey = `${nativeCycle.startedAt}:${nativeCycle.completedAt}`;
      if (claimedCycles.has(cycleKey)) nativeCycle = null;
      else claimedCycles.add(cycleKey);
    }
    const nativeLifecycle = nativeCycle ? 'observed' : 'missing';
    found.push({ source: 'opencode', trigger: 'automatic', requestKind: 'ordinary-context-growth', eventId: part.id,
      boundaryMessageId: row.info.id, summaryMessageId: summary.info.id, observedAt: summary.info.time.completed,
      summarySha256: digest(textOf(summary)), summaryBytes: Buffer.byteLength(textOf(summary)),
      auto: true, overflow: part.overflow === true, usageMessageId: preceding?.info.id ?? null,
      usageAtTrigger: usage, threshold, thresholdReached: numeric(threshold) && usage !== null && usage >= threshold,
      nativeLifecycle, nativeCycle, nativeEvents });
  }
  return found;
}

// A deterministic project workload: varied legacy migration and out-of-order
// event replay cases. The agent reviews records through the normal composer;
// synthetic records are explicitly labelled and do not invent new requirements.
export function createQaNaturalWorkload({ batch, maximumBytes = MAX_BATCH_BYTES }) {
  assert.ok(Number.isSafeInteger(batch) && batch > 0, 'Workload batch must be positive');
  assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes >= 4096 && maximumBytes <= MAX_BATCH_BYTES, 'Workload size is outside the bounded range');
  const marker = `QA_TASKBOARD_REPLAY_BATCH_${batch}`;
  const prefix = `${marker}\nReview this synthetic Task Board migration and event-replay audit batch against the current saved plan. These generated cases are supporting investigation, not new requirements or production data. Implementation remains paused. Do not write files, rewrite the plan, rerun completed investigations, or echo this dataset. Read the records and give at most six concise findings, then await further input. Keep unresolved obligations in context.\nEach JSON line contains a legacy or current task, arrival-ordered events, and the expected latest accepted revision; equal or older revisions must preserve current fields.\n`;
  const suffix = '\nEnd of audit batch. Briefly assess the records under the current project contracts without making changes.\n';
  const lines = [prefix];
  let bytes = Buffer.byteLength(prefix + suffix);
  let cases = 0;
  while (true) {
    const number = batch * 100000 + cases;
    const revision = 3 + number % 19;
    const priority = ['low', 'normal', 'high'][number % 3];
    const initial = { id: `audit-${number}`, title: `Task ${number} migration receipt`, done: number % 4 === 0,
      archived: number % 7 === 0, revision };
    if (number % 5 !== 0) initial.priority = priority;
    const row = { case: number, initial, arrivals: [
      { revision: revision - 1, patch: { title: `Delayed receipt ${number}`, done: !initial.done } },
      { revision: revision + 2, patch: { title: `Verified receipt ${number}`, priority } },
      { revision: revision + 1, patch: { title: `Reordered receipt ${number}`, archived: !initial.archived } },
      { revision: revision + 2, patch: { title: `Duplicate receipt ${number}` } },
    ], expected: { revision: revision + 2, title: `Verified receipt ${number}`, priority, done: initial.done, archived: initial.archived } };
    const line = JSON.stringify(row) + '\n';
    if (bytes + Buffer.byteLength(line) > maximumBytes) break;
    lines.push(line); bytes += Buffer.byteLength(line); cases++;
  }
  assert.ok(cases > 0, 'The bounded workload contains no cases');
  const text = lines.join('') + suffix;
  return { text, marker, bytes, cases, sha256: digest(text), source: 'generated-project-event-replay-audit' };
}

// This is only a QA workload scheduling target. Acceptance still requires the
// unchanged native threshold and observed lifecycle; the estimate cannot prove
// that the next turn stays below that threshold.
export function deriveQaNaturalPrefillTarget(threshold) {
  assert.ok(numeric(threshold) && threshold > 0, 'A native threshold is required for prefill');
  const seedHeadroomTokens = Math.min(20000, Math.max(1, Math.floor(threshold * 0.1)));
  return { source: 'qa-prefill-estimate-only', threshold, seedHeadroomTokens, targetUsage: threshold - seedHeadroomTokens };
}

export function projectQaEarlyNaturalBoundary(rows, { previousPartIds, previousNativeEvents = [], observations, sessionID, startedAt }) {
  const previous = new Set(previousPartIds);
  const observedBefore = new Set(previousNativeEvents.map(item => JSON.stringify([item.kind, item.sessionID, item.at])));
  return {
    partIds: rows.flatMap(row => (row.parts ?? []).filter(part => part.type === 'compaction' && !previous.has(part.id)).map(part => part.id)),
    nativeEvents: observations.filter(item => item.sessionID === sessionID && item.at >= startedAt
      && !observedBefore.has(JSON.stringify([item.kind, item.sessionID, item.at]))
      && ['native.compacting', 'native.session.compacted', 'native.compaction.autocontinue'].includes(item.kind)),
  };
}

export async function runQaNaturalCompaction({ cell, projectFixture, ui, api, check, screenshot, sendTurn,
  messages, getSessionID, captureSavedPlan, readSavedRevision, readProviderObservation, nativeOutputTokenMax, nativeAgent }) {
  if (cell?.transport !== 'live' || cell.runtime !== 'electron' || cell.scenarioId !== 'compaction-natural') {
    throw new Error('Natural compaction requires a live Electron natural matrix cell');
  }
  const snapshotRecorder = createQaCompactionSnapshotRecorder();
  const actionSnapshotRecorder = createQaCompactionActionSnapshotRecorder();
  const evidence = { source: 'opencode', mode: 'natural', planMode: cell.planMode, boundaries: [], plans: [], batches: [],
    managedSnapshots: snapshotRecorder.data, nativeLifecycle: 'not-yet-observed', workload: 'synthetic project event-replay audits sent through the real composer',
    bounds: { maximumBatchBytes: MAX_BATCH_BYTES, maximumTotalBytes: MAX_TOTAL_BYTES, maximumBatchesPerBoundary: MAX_BATCHES_PER_BOUNDARY },
    continuityClaims: { completedWorkNotRepeated: 'operational-grade-pending', rejectedSorting: 'browser-acceptance-required' },
    actions: mergeCompactionActions(), actionSnapshots: actionSnapshotRecorder.data, submittedUserMessageIDs: [],
    investigationCohort: [], witnesses: [] };
  const persist = () => writeFile(path.join(projectFixture.evidenceDirectory, 'natural-compaction-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const snapshot = async (stage, includeObservation = false) => {
    if (cell.agent !== 'orchestrator' || !getSessionID()) return;
    const requestStartedAt = Date.now();
    let projection;
    try {
      const query = new URLSearchParams({ rootSessionId: getSessionID(), directory: projectFixture.fixtureRoot });
      projection = projectCompactionTaskSnapshot(await api(`/api/orchestration/snapshot?${query}`), getSessionID());
    } catch { projection = { state: 'unavailable', reason: 'snapshot request failed' }; }
    const responseCompletedAt = Date.now();
    const observation = { stage, requestStartedAt, responseCompletedAt, snapshot: projection };
    snapshotRecorder.record(observation);
    if (snapshotRecorder.gap) evidence.managedSnapshotGap = snapshotRecorder.gap;
    evidence.managedSnapshotReadErrors = snapshotRecorder.unavailableReads;
    return includeObservation ? observation : projection;
  };
  const captureActions = async stage => {
    const observation = await snapshot(stage, true);
    const observed = observation?.snapshot;
    const rows = await messages();
    evidence.actions = mergeCompactionActions(evidence.actions, projectCompactionActions(rows, {
      directory: projectFixture.fixtureRoot, snapshot: observed, rootSessionID: getSessionID(),
    }));
    actionSnapshotRecorder.record({ stage, at: Date.now(), callCounts: Object.fromEntries(Object.entries(evidence.actions).map(([key, value]) => [key, value.length])) });
    if (actionSnapshotRecorder.gap) evidence.actionSnapshotGap = actionSnapshotRecorder.gap;
    await persist();
    return { snapshot: observed, observation, rows };
  };
  const assertPendingCohort = (observed, witness) => {
    const readiness = projectQaCompactionBoundaryCohort(observed, witness.cohort, { coverage: witness.coverage });
    witness.precondition = readiness;
    assert.ok(readiness.passed, `Natural compaction boundary ${witness.boundaryIndex} is unavailable: ${readiness.reason}`);
  };
  const observeDuring = async (stage, action) => {
    let done = false;
    const sampling = (async () => { while (!done) { await snapshot(stage); if (!done) await pause(500); } })();
    try { return await action(); } finally { done = true; await sampling; await snapshot(`${stage}:settled`); await persist(); }
  };
  const capturePlan = async (name, userMessageID) => {
    let saved;
    if (cell.planMode) saved = await captureSavedPlan(name, { userMessageID });
    else {
      const candidate = (await captureQaCompactionProjectPlan(projectFixture)).realPath;
      const content = await readFile(candidate, 'utf8');
      assert.ok(content.trim(), 'The current saved plan is empty');
      saved = { path: path.join(projectFixture.evidenceDirectory, `${name}.md`), sha256: digest(content), sourceMessageID: null,
        provenance: 'saved-project-file', canonicalPath: '.opencode/plans/qa-current.md' };
      await writeFile(saved.path, content, { mode: 0o600 });
    }
    evidence.plans.push(saved); return saved;
  };
  const submitPlan = async (name, text) => {
    const previousIds = new Set(getSessionID() ? (await messages()).map(row => row.info.id) : []);
    const rows = await sendTurn(text);
    const submitted = findQaSubmittedUser(rows, previousIds, text);
    assert.ok(submitted, 'Planning requires the exact canonical human request');
    return capturePlan(name, submitted.info.id);
  };
  const pausedState = async savedPlan => {
    const grade = gradeQaProject({ fixture: projectFixture, phase: 'plan', savedPlan });
    assert.ok(grade.passed, 'Paused natural compaction work changed implementation or lost the saved plan');
    const planReference = evidence.expectedPausedState
      ? await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision })
      : await captureQaCompactionPlanReference({ planMode: cell.planMode, projectFixture, savedPlan, readSavedRevision });
    return {
      repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectFixture.fixtureRoot, encoding: 'utf8' }).trim(),
      preservedFileHashes: Object.fromEntries(await Promise.all(QA_PROJECT_PROTECTED_PATHS.map(async file => [file, digest(await readFile(path.join(projectFixture.fixtureRoot, file)))]))),
      planSha256: digest(await readFile(savedPlan.path)), sourceMessageID: savedPlan.sourceMessageID, objectiveRevision: 2, phase: 'paused-before-implementation',
      planReference,
    };
  };
  const statusIdle = async () => {
    const status = await api(`/api/session/status?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`);
    return !status[getSessionID()] || status[getSessionID()].type === 'idle';
  };
  const latestUsage = rows => {
    const latest = rows.toReversed().find(row => row.info?.role === 'assistant' && row.info.time?.completed && !row.info.error && row.info.summary !== true);
    return { messageID: latest?.info.id ?? null, tokens: qaNativeTokenUsage(latest?.info.tokens) };
  };
  // Auto compaction inserts native user/summary/continuation records. Match the
  // exact submitted user text and settle the whole session, not a user count.
  const ordinaryTurn = async (text, priorIds) => {
    const startedAt = Date.now();
    await ui.send(text);
    return ui.waitFor('ordinary workload turn and automatic continuation settled', async () => {
      const sessionError = (await readProviderObservation()).find(item => item.kind === 'native.session.error'
        && item.sessionID === getSessionID() && item.at >= startedAt);
      if (sessionError) throw new Error(`Natural workload session failed: ${sessionError.errorName || 'unknown'}`);
      const rows = await messages();
      const submitted = findQaSubmittedUser(rows, priorIds, text);
      if (!submitted) return false;
      assertQaSubmittedPlanMode(submitted, cell.planMode);
      if (!evidence.submittedUserMessageIDs.includes(submitted.info.id)) evidence.submittedUserMessageIDs.push(submitted.info.id);
      assert.equal(submitted.info.model?.providerID, cell.providerId, 'Workload provider changed');
      assert.equal(submitted.info.model?.modelID, cell.modelId, 'Workload model changed');
      assert.equal(submitted.info.agent, nativeAgent, 'Workload agent changed');
      assert.equal(submitted.info.model?.variant ?? submitted.info.variant ?? '', cell.variant ?? '', 'Workload effort changed');
      const fresh = rows.filter(row => row.info?.role === 'assistant' && !priorIds.has(row.info.id));
      const failure = fresh.find(row => row.info.error);
      if (failure) throw new Error(`Natural workload turn failed: ${failure.info.error.name || 'unknown'}`);
      return fresh.some(row => row.info.time?.completed && row.info.summary !== true && row.info.finish !== 'tool-calls') && await statusIdle() ? rows : false;
    }, cell.timeoutMs);
  };
  try {
    await check('investigate and save a paused plan before natural context growth', () => observeDuring('diagnosis', async () => {
      await ui.attach(projectFixture.attachments.map(item => item.path));
      const saved = await submitPlan('natural-plan-revision-1', 'Investigate Task Board and the attached requirements and visual reference. Read AGENTS.md, then successfully read src/tasks.mjs with native read. Only after that source read completes, run standalone `node --test test/tasks.test.mjs` with native bash and observe the initial failure. Keep these calls sequential, never run the initial test before or concurrently with the read. If core policy disables execution, complete the read now and defer the native failing test until immediately after approval and before edits. After authorized implementation, run the same standalone native bash command and verify it passes. Preserve numeric exit statuses. Propose the complete repair and persisted priority feature. '
        + 'Implementation is paused until explicit approval regardless of the Plan toggle. Do not modify implementation, tests, dependencies, or the existing user note. '
        + (cell.agent === 'orchestrator' ? 'Delegate independent read-only domain/storage and browser investigations and handle each managed result once. Do not delegate writable work. ' : 'Investigate directly. ')
        + (cell.planMode ? 'Return the complete Markdown plan for the Plan card to save, then wait for a requirement revision.'
          : 'Save the complete plan at .opencode/plans/qa-current.md, return it in Markdown, and wait for a requirement revision.'));
      await pausedState(saved); await screenshot('natural-diagnosis');
    }));
    let revisedPlan;
    await check('replace the saved plan with revision 2 and preserve the pause', () => observeDuring('revision', async () => {
      revisedPlan = await submitPlan('natural-plan-revision-2', projectFixture.prompts.revision + ' Implementation remains paused. '
        + (cell.planMode ? 'Return the complete replacement Markdown plan for the Plan card to save and await approval.'
          : 'Save the complete replacement plan at .opencode/plans/qa-current.md, return the full plan, and await approval.'));
      assert.ok(cell.agent === 'builder' ? ['build','builder'].includes(nativeAgent) : nativeAgent === 'orchestrator', 'The resolved native primary agent is unavailable');
      assert.notEqual(revisedPlan.sha256, evidence.plans[0].sha256, 'Revision 2 did not replace the saved plan');
      const content = await readFile(revisedPlan.path, 'utf8');
      assert.match(content, /creation order/i); assert.match(content, /priority filter/i);
      evidence.expectedPausedState = await pausedState(revisedPlan);
      const health = await api('/api/health');
      const config = await api(`/api/config?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`);
      const observed = (await readProviderObservation()).toReversed().find(item => item.kind === 'chat.params'
        && item.sessionID === getSessionID() && item.providerID === cell.providerId && item.modelID === cell.modelId);
      evidence.policy = deriveQaNativeCompactionPolicy({ version: health.openCodeVersion, modelLimits: observed?.modelLimits,
        compaction: config.compaction, outputTokenMax: nativeOutputTokenMax });
      await screenshot('natural-revised-plan');
    }));
    await captureActions('paused-action-baseline');
    evidence.baselineActions = structuredClone(evidence.actions);
    // Observe from the beginning of prefill, never reset after seeding. An early
    // native boundary is failed evidence, not a new counting baseline.
    const originalParts = (await messages()).flatMap(row => (row.parts ?? []).filter(part => part.type === 'compaction').map(part => part.id));
    const growthStartedAt = Date.now();
    evidence.contextGrowthObservation = { startedAt: growthStartedAt, previousPartIds: originalParts };
    let bytesPerToken = 2;
    let totalBytes = 0;
    const rejectEarlyBoundary = async stage => {
      const early = projectQaEarlyNaturalBoundary(await messages(), {
        previousPartIds: [...originalParts, ...evidence.boundaries.map(item => item.eventId)],
        previousNativeEvents: evidence.boundaries.flatMap(item => item.nativeEvents),
        observations: await readProviderObservation(), sessionID: getSessionID(), startedAt: growthStartedAt });
      if (early.partIds.length || early.nativeEvents.length) {
        evidence.earlyBoundary = { stage, ...early }; await persist();
        assert.fail('A native compaction occurred before the required phase witness; the observation window cannot be restarted');
      }
    };
    const prepareWitness = async index => {
      const witness = { ...QA_NATURAL_COMPACTION_PHASES[index], cohort: [] };
      evidence.witnesses.push(witness);
      await check(`prefill ordinary context before natural witness ${index + 1}`, () => observeDuring(`context-prefill-${index + 1}`, async () => {
        witness.prefillTarget = deriveQaNaturalPrefillTarget(evidence.policy.threshold);
        let ready = false;
        const availableBatches = MAX_BATCHES_PER_BOUNDARY - evidence.batches.filter(item => item.boundaryTarget === index + 1).length;
        for (let attempt = 0; attempt < availableBatches; attempt++) {
          await rejectEarlyBoundary('before-prefill-batch');
          await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision });
          const beforeRows = await messages(); const before = latestUsage(beforeRows);
          assert.notEqual(before.tokens, null, 'Native usage is unavailable for prefill');
          assert.ok(before.tokens < evidence.policy.threshold, 'Prefill reached the native threshold before its witness was seeded');
          if (before.tokens >= witness.prefillTarget.targetUsage) {
            witness.prefillCompleted = { at: Date.now(), usage: before, remainingTokens: evidence.policy.threshold - before.tokens };
            ready = true; break;
          }
          const remaining = witness.prefillTarget.targetUsage - before.tokens;
          const maximumBytes = Math.min(MAX_BATCH_BYTES, Math.max(4096,
            Math.floor(Math.min(48000, Math.max(1000, remaining * 0.8 + 2000)) * bytesPerToken)));
          const workload = createQaNaturalWorkload({ batch: evidence.batches.length + 1, maximumBytes });
          assert.ok(totalBytes + workload.bytes <= MAX_TOTAL_BYTES, 'Natural prefill exhausted the total workload byte bound');
          totalBytes += workload.bytes;
          const batchEvidence = { index: evidence.batches.length + 1, boundaryTarget: index + 1, stage: 'prefill', at: Date.now(),
            bytes: workload.bytes, sha256: workload.sha256, cases: workload.cases, source: workload.source,
            beforeUsage: before, estimatedBytesPerToken: bytesPerToken };
          evidence.batches.push(batchEvidence); evidence.totalWorkloadBytes = totalBytes; await persist();
          const afterRows = await ordinaryTurn(workload.text, new Set(beforeRows.map(row => row.info.id)));
          batchEvidence.afterUsage = latestUsage(afterRows);
          await rejectEarlyBoundary('after-prefill-batch');
          const delta = batchEvidence.afterUsage.tokens - before.tokens;
          if (delta > 0) bytesPerToken = Math.min(6, Math.max(1.2, workload.bytes / delta));
          await pausedState(revisedPlan); await captureActions('prefill:completed-batch');
        }
        assert.ok(ready, `Natural prefill did not leave measured seed headroom within boundary ${index + 1}'s batch bound`);
      }));
      await check(`seed exact bounded read-only natural witness ${index + 1}`, () => observeDuring(`pending-investigation-${index + 1}`, async () => {
        await rejectEarlyBoundary('before-investigation-seed');
        const before = new Set(evidence.actions.starts.map(item => item.callId));
        await sendTurn(createQaNaturalInvestigationPrompt(index + 1));
        await rejectEarlyBoundary('after-investigation-seed');
        let captured;
        await ui.waitFor(`one ${witness.coverage} seeded witness`, async () => {
          captured = await captureActions('pending-investigations:children');
          const cohort = evidence.actions.starts.filter(item => !before.has(item.callId));
          assert.ok(cohort.length <= 1, 'The phase started extra or replacement investigations');
          if (cohort.length !== 1 || !cohort[0].taskId || !cohort[0].childSessionId) return false;
          assert.equal(cohort[0].marker, witness.marker, 'The investigation does not match its planned phase marker');
          witness.cohort = cohort;
          const task = captured.snapshot?.tasks?.find(item => item.taskId === cohort[0].taskId);
          if (task && witness.coverage === 'active') assert.ok(!['completed', 'failed', 'aborted', 'interrupted'].includes(task.status), 'The active witness ended before required coverage; it cannot be recreated');
          if (task && witness.coverage === 'completed-awaiting') {
            assert.ok(!['failed', 'aborted', 'interrupted'].includes(task.status), 'The completed witness failed before required coverage');
            assert.ok(!captured.snapshot.envelopes.some(item => item.taskId === task.taskId && item.action !== null), 'The witness result was already dispositioned before its boundary');
          }
          witness.precondition = projectQaCompactionBoundaryCohort(captured.snapshot, cohort, { coverage: witness.coverage });
          return witness.precondition.passed;
        }, cell.timeoutMs);
        evidence.investigationCohort.push(...witness.cohort);
        if (cell.planMode) {
          const tree = [{ sessionId: getSessionID(), messages: captured.rows }];
          for (const item of witness.cohort) tree.push({ sessionId: item.childSessionId,
            messages: await api(`/api/session/${encodeURIComponent(item.childSessionId)}/message?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`) });
          const tasks = captured.snapshot.tasks.filter(task => witness.cohort.some(item => item.taskId === task.taskId));
          witness.planChildPolicy = projectQaPlanChildPolicy(tree, getSessionID(), tasks);
          assert.ok(witness.planChildPolicy.passed && witness.planChildPolicy.children.length === 1, 'Plan-mode child read-only policy was not observed in canonical prompt permissions');
        }
        await pausedState(revisedPlan);
      }));
      return witness;
    };
    for (let index = 0; index < 2; index++) {
      if (index === 1) {
        await check('preserve the pause between natural boundaries', () => observeDuring('steering', async () => {
          await sendTurn('Keep implementation paused and leave revision 2 and its saved plan unchanged. Inspect the saved plan and task state only. Do not reread completed source inspections, rerun failed tests, or edit files. Briefly acknowledge readiness for more input.');
          await pausedState(revisedPlan);
          await captureActions('between-boundaries:dispositioned');
        }));
      }
      const witness = cell.agent === 'orchestrator' ? await prepareWitness(index) : null;
      await check(`reach and observe natural native compaction boundary ${index + 1}`, () => observeDuring(`context-growth-${index + 1}`, async () => {
        const knownParts = [...originalParts, ...evidence.boundaries.map(item => item.eventId)];
        let boundary;
        const remainingBatchCount = MAX_BATCHES_PER_BOUNDARY - evidence.batches.filter(item => item.boundaryTarget === index + 1).length;
        for (let attempt = 0; attempt < remainingBatchCount; attempt++) {
          if (witness && attempt === 0) await rejectEarlyBoundary(`before-triggering-batch-${index + 1}`);
          await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision });
          const beforeRows = await messages();
          const before = latestUsage(beforeRows);
          assert.notEqual(before.tokens, null, 'Native usage is unavailable; natural threshold cannot be evidenced');
          const stateBefore = await captureActions(`before-boundary-${index + 1}:batch-${attempt + 1}`);
          if (witness) assertPendingCohort(stateBefore.snapshot, witness);
          const remaining = evidence.policy.threshold - before.tokens;
          const maximumBytes = Math.min(MAX_BATCH_BYTES, Math.max(4096, Math.floor(Math.min(48000, Math.max(1000, remaining * 0.8 + 2000)) * bytesPerToken)));
          const pendingInstruction = witness
            ? '\nThis is an input-only replay audit: assess only the supplied records from the context already available. Do not reread source files or the saved plan, call ordinary tools, start tasks, or manually disposition results during this input. Preserve the implementation pause. Existing automatically delivered managed continuation instructions remain authoritative.\n' : '';
          const sourceWorkload = remaining <= 0
            ? { text: `QA_TASKBOARD_THRESHOLD_FOLLOWUP_${index + 1}_${attempt + 1}\nThe audit input is complete for now. Keep implementation paused and the current saved plan unchanged. Briefly assess whether any unresolved audit obligations remain, then await approval.`, cases: 0, source: 'ordinary-project-audit-followup' }
            : createQaNaturalWorkload({ batch: evidence.batches.length + 1, maximumBytes: Math.max(4096, maximumBytes - Buffer.byteLength(pendingInstruction)) });
          const workload = { ...sourceWorkload, text: sourceWorkload.text + pendingInstruction };
          const bytes = Buffer.byteLength(workload.text);
          assert.ok(bytes <= MAX_BATCH_BYTES, 'Natural workload exceeded its unchanged per-batch bound');
          assert.ok(totalBytes + bytes <= MAX_TOTAL_BYTES, 'Natural workload reached its byte bound before two verified native boundaries');
          totalBytes += bytes;
          const batchEvidence = { index: evidence.batches.length + 1, boundaryTarget: index + 1, at: Date.now(), bytes,
            sha256: digest(workload.text), cases: workload.cases, source: workload.source, beforeUsage: before, estimatedBytesPerToken: bytesPerToken };
          evidence.batches.push(batchEvidence); await persist();
          const afterRows = await ordinaryTurn(workload.text, new Set(beforeRows.map(row => row.info.id)));
          batchEvidence.afterUsage = latestUsage(afterRows);
          let candidates = [];
          await ui.waitFor('native observer records after context growth', async () => {
            candidates = findNaturalCompactionBoundaries(await messages(), { previousPartIds: knownParts,
              threshold: evidence.policy.threshold, observations: await readProviderObservation(), sessionID: getSessionID(), startedAt: growthStartedAt });
            return candidates.length === 0 || candidates.every(item => item.nativeLifecycle === 'observed');
          }, 5000);
          if (candidates.length) {
            assert.equal(candidates.length, 1, 'Multiple automatic boundaries occurred in one batch; continuity must be inspected separately');
            boundary = candidates[0];
            evidence.boundaries.push(boundary);
            assert.equal(boundary.overflow, false, 'Provider overflow cannot stand in for reaching the measured native threshold');
            assert.equal(boundary.thresholdReached, true, 'Automatic summary has no measured threshold crossing');
            assert.equal(boundary.nativeLifecycle, 'observed', 'Automatic summary has no independent native lifecycle evidence');
            if (witness) {
              const bracket = projectQaCompactionBoundaryBracket({ snapshots: decodeQaCompactionSnapshots(evidence.managedSnapshots), cohort: witness.cohort,
                coverage: witness.coverage, nativeStartedAt: boundary.nativeCycle.startedAt, gap: evidence.managedSnapshotGap });
              witness.bracket = bracket;
              assert.ok(bracket.passed, `Native boundary ${index + 1} has no strict ${witness.coverage} bracket: ${bracket.reason}`);
              await snapshot(`summary-exit-${index + 1}:observed`);
              const exit = projectQaCompactionSummaryExit({ snapshots: decodeQaCompactionSnapshots(evidence.managedSnapshots), before: bracket.before.snapshot,
                cohort: witness.cohort, coverage: witness.coverage, summaryCompletedAt: boundary.observedAt,
                nativeCycle: boundary.nativeCycle, gap: evidence.managedSnapshotGap });
              witness.summaryExit = exit;
              assert.ok(exit.passed, `Natural boundary ${index + 1} summary-exit coverage is unavailable: ${exit.reason}`);
            }
            break;
          }
          const delta = batchEvidence.afterUsage.tokens - before.tokens;
          if (delta > 0) bytesPerToken = Math.min(6, Math.max(1.2, bytes / delta));
          await pausedState(revisedPlan); await persist();
        }
        assert.ok(boundary, 'Normal project context growth did not reach a verified automatic compaction within the workload bound');
        await screenshot(`natural-boundary-${index + 1}`);
        await ui.reload();
        const restored = findNaturalCompactionBoundaries(await messages(), { previousPartIds: knownParts, threshold: evidence.policy.threshold,
          observations: await readProviderObservation(), sessionID: getSessionID(), startedAt: growthStartedAt });
        assert.ok(restored.some(item => item.summaryMessageId === boundary.summaryMessageId), 'Reload lost the automatic compaction summary');
        const state = await pausedState(revisedPlan);
        boundary.restoredPausedState = state;
        assert.deepEqual(state, evidence.expectedPausedState, 'Natural compaction changed the current plan or paused project state');
        const stateAfter = await captureActions(`after-boundary-${index + 1}`);
        if (witness) {
          witness.afterReload = stateAfter.observation;
          assert.ok(isQaCompactionPostSummaryCohortPreserved({ exit: witness.summaryExit,
              after: stateAfter.snapshot, cohort: witness.cohort, dispositions: evidence.actions.dispositions }),
            'Reload changed a seeded task/result or its post-summary disposition timing');
        }
      }));
      if (witness) {
        await check(`collect natural witness ${index + 1} only after its summary exit`, () => observeDuring(`collection-${index + 1}`, async () => {
          const taskId = witness.cohort[0].taskId;
          await sendTurn(`Collect the exact investigation ${taskId} if it is still pending. If the native managed lifecycle already continued that exact result, do not disposition it again. Otherwise use wait, read every result page if required, and continue its completed result exactly once. Do not start a replacement or repeated investigation. `
            + 'Keep implementation paused and leave revision 2 and its saved plan unchanged. Do not reread completed source inspections, rerun failed tests, or edit files.');
          await pausedState(revisedPlan);
          const collected = await captureActions(`after-collection-${index + 1}`);
          witness.afterCollection = collected.observation;
          assert.ok(isQaCompactionPostSummaryCohortPreserved({ exit: witness.summaryExit, after: collected.snapshot,
            cohort: witness.cohort, dispositions: evidence.actions.dispositions })
            && collected.snapshot.tasks.some(task => task.taskId === taskId && task.status === 'completed')
            && collected.snapshot.envelopes.some(envelope => envelope.taskId === taskId && envelope.action === 'continue'),
          'The exact witness was not collected once after its required summary exit');
        }));
      }
    }
    let approvalPlan;
    if (cell.planMode) {
      await check('present the current saved plan as a fresh approval source after natural compaction', () => observeDuring('approval-preparation', async () => {
        const prepared = await prepareQaCompactionApproval({ projectFixture, priorSavedPlan: revisedPlan,
          expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision,
          messages, sendTurn, captureSavedPlan, evidenceName: 'natural-plan-current-approval' });
        approvalPlan = prepared.savedPlan;
        evidence.approvalPreparation = prepared.evidence;
        await captureActions('approval-preparation:completed');
        await screenshot('natural-current-plan-approval');
      }));
    }
    await captureActions('before-implementation-approval');
    await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan: evidence.expectedPausedState.planReference, readSavedRevision });
    evidence.pausedActions = structuredClone(evidence.actions);
    await check('approve and implement the current plan after repeated natural compaction', () => observeDuring('implementation', async () => {
      if (cell.planMode) {
        const current = approvalPlan;
        assert.ok(current, 'The fresh current Plan approval source is unavailable');
        const selector = `[data-plan-source-message-id=${JSON.stringify(current.sourceMessageID)}] button`;
        const beforeIds = new Set((await messages()).map(row => row.info.id));
        await ui.reveal(selector, 'Implement Plan', { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
        await ui.click({ selector, text: 'Implement Plan' });
        evidence.approvalSurface = 'latest-plan-card';
        await ui.waitFor('post-compaction plan-card implementation', async () => {
          const rows = await messages();
          const submitted = findQaPlanApprovalUser(rows, beforeIds, { sessionID: getSessionID(), sourceMessageID: current.sourceMessageID, cell, nativeAgent });
          if (!submitted) return false;
          if (!evidence.submittedUserMessageIDs.includes(submitted.info.id)) evidence.submittedUserMessageIDs.push(submitted.info.id);
          const fresh = rows.filter(row => row.info?.role === 'assistant' && !beforeIds.has(row.info.id));
          const failure = fresh.find(row => row.info.error);
          if (failure) throw new Error(`Post-compaction implementation failed: ${failure.info.error.name || 'unknown'}`);
          return fresh.some(row => row.info.time?.completed && row.info.summary !== true && row.info.finish !== 'tool-calls') && await statusIdle();
        }, cell.timeoutMs);
      } else {
        evidence.approvalSurface = 'composer-with-plan-mode-off';
        await ordinaryTurn(projectFixture.prompts.approve, new Set((await messages()).map(row => row.info.id)));
      }
      evidence.projectGrade = gradeQaProject({ fixture: projectFixture, phase: 'implemented' });
      assert.ok(evidence.projectGrade.passed, 'Post-natural-compaction behavior failed independent domain/API/restart acceptance');
      const implemented = await captureActions('implementation:completed');
      evidence.finalManagedSnapshot = implemented.observation;
      await screenshot('natural-implemented');
    }));
    evidence.nativeLifecycle = evidence.boundaries.every(item => item.nativeLifecycle === 'observed') ? 'observed' : 'missing';
    await check('natural compaction preserves observed operational work across both boundaries', async () => {
      const actions = { baselineActions: evidence.baselineActions, pausedActions: evidence.pausedActions, continuedActions: evidence.actions,
        projectGrade: evidence.projectGrade };
      evidence.operationalContinuityGrade = cell.agent === 'orchestrator'
        ? gradeQaNaturalCompactionOperationalContinuity({ ...actions, cohort: evidence.investigationCohort,
          witnesses: evidence.witnesses, boundaries: evidence.boundaries, snapshots: decodeQaCompactionSnapshots(evidence.managedSnapshots),
          finalSnapshot: evidence.finalManagedSnapshot, snapshotGap: evidence.managedSnapshotGap, actionGap: evidence.actionSnapshotGap })
        : gradeCompactionOperationalContinuity({ ...actions, agent: cell.agent });
      evidence.continuityClaims.completedWorkNotRepeated = evidence.operationalContinuityGrade.scope;
      assert.ok(evidence.operationalContinuityGrade.passed, 'Natural compaction operational continuity failed authoritative tool/ledger checks');
      assert.equal(evidence.managedSnapshotGap, undefined, 'A managed snapshot gap prevents a complete continuity claim');
      assert.equal(evidence.actionSnapshotGap, undefined, 'An action snapshot gap prevents a complete continuity claim');
    });
    evidence.managedContinuity = cell.agent === 'orchestrator' ? 'exact-operational-continuity-graded' : 'not-applicable';
    evidence.totalWorkloadBytes = totalBytes;
    evidence.outcome = 'passed-with-declared-coverage';
    return evidence;
  } catch (error) { evidence.outcome = 'failed'; evidence.error = error.message; throw error; }
  finally { await persist(); }
}
