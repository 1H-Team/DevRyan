import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gradeQaProject } from './acceptance-graders.mjs';
import { projectCompactionActions } from './compaction-action-evidence.mjs';
import { findManualCompactionBoundary, findQaNativeCompactionCycle } from './compaction-scenarios.mjs';
import { assertQaSubmittedPlanMode, findQaSubmittedUser } from './submitted-turn.mjs';
import { createQaNaturalWorkload, deriveQaNativeCompactionPolicy, qaNativeTokenUsage } from './natural-compaction-scenarios.mjs';

export const QA_RETRIEVAL_SCENARIOS = Object.freeze(['compaction-retrieval-control', 'compaction-retrieval-compacted']);
export const QA_RETRIEVAL_PROBE = 'Continue with the next permitted step from the current state.';
export const QA_RETRIEVAL_PLAN = '.opencode/plans/qa-current.md';
const digest = value => createHash('sha256').update(value).digest('hex');
const textOf = row => (row.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
const boundaryParts = rows => rows.flatMap(row => (row.parts ?? []).filter(part => part.type === 'compaction'));
const excludedAcceptance = { retentionAcceptance: false, naturalCompactionAcceptance: false, automaticContinuationAcceptance: false };
const diagnosis = 'Investigate Task Board and the attached requirements and visual reference. Read the fixture AGENTS.md, then successfully read src/tasks.mjs with native read. Only after that source read completes, run standalone node --test test/tasks.test.mjs with native bash and observe the initial failure. Keep these calls sequential. Investigate directly. Propose the complete repair and persisted priority feature. Implementation is paused until explicit approval. Do not modify implementation, tests, or dependencies. Preserve the existing user note and all compatibility contracts. Save the full current plan at .opencode/plans/qa-current.md and return the complete Markdown plan, then stop for a requirement revision.';
const revisionSuffix = ' Implementation remains paused. Save a complete replacement plan at .opencode/plans/qa-current.md, return the full plan, and wait for approval.';

export function createQaRetrievalDiagnosticMatrix({ evidenceRoot, providerId = 'xai', modelId = 'grok-4.6', timeoutMs = 1_200_000 } = {}) {
  return { schemaVersion: 1, evidenceRoot, cells: [['control', 'compacted'], ['compacted', 'control'], ['control', 'compacted']]
    .flatMap((arms, index) => arms.map(arm => ({
      id: 'retrieval-pair-' + (index + 1) + '-' + arm, runtime: 'electron', transport: 'live', providerId, modelId,
      agent: 'builder', planMode: false, variant: null, scenarioIds: ['compaction-retrieval-' + arm], repetitions: 1, timeoutMs,
    }))) };
}

// These are conservative evidence candidates for a human to classify, never a
// semantic claim that compaction caused loss. Empty glob results alone are not failure.
export function projectQaRetrievalBehavior(rows, { previousIds = new Set(), directory, planExists, planUnchanged } = {}) {
  const tools = [];
  const claims = [];
  let order = 0;
  for (const row of rows) {
    if (previousIds.has(row.info?.id) || row.info?.role !== 'assistant' || row.info.summary) continue;
    for (const part of row.parts ?? []) {
      order++;
      if (part.type === 'tool') {
        const input = part.state?.input ?? {};
        const target = ['filePath', 'file_path', 'path'].map(key => input[key]).find(value => typeof value === 'string');
        const exactPlan = ['read', 'oc_read', 'file_read'].includes(part.tool) && typeof target === 'string'
          && path.resolve(directory, target) === path.join(directory, QA_RETRIEVAL_PLAN);
        const hiddenPlanGlob = part.tool === 'glob' && typeof input.pattern === 'string' && input.pattern.includes('.opencode');
        tools.push({ order, messageID: row.info.id, callID: part.callID, tool: part.tool, status: part.state?.status,
          exactPlanRead: exactPlan, hiddenPlanGlob, pattern: hiddenPlanGlob ? input.pattern : null,
          emptyGlob: hiddenPlanGlob && part.state?.status === 'completed' && part.state.output?.trim() === 'No files found' });
      }
      const texts = part.type === 'text' ? [part.text ?? ''] : part.type === 'tool' && part.tool === 'question'
        ? (part.state?.input?.questions ?? []).map(item => item.question ?? '') : [];
      for (const text of texts) {
        const target = /(?:saved plan|\.opencode\/plans\/)/i.test(text);
        const absence = /(?:\bis gone\b|\bis missing\b|\bdoes not exist\b|\bno\s+[\x60"']?\.opencode\/plans\/|\b(?:cannot|could not|can't)\s+find\s+(?:the\s+)?(?:saved\s+)?plan\b)/i.test(text);
        const conditional = /\b(?:if|unless|whether|in case)\b[^.!?\n]{0,80}(?:saved plan|\.opencode\/plans\/)/i.test(text);
        if (target && absence && !conditional) claims.push({ order, messageID: row.info.id, callID: part.callID ?? null,
          source: part.type === 'text' ? 'assistant-text' : 'question' });
      }
    }
  }
  const globOnlyClaims = claims.filter(claim => tools.some(tool => tool.emptyGlob && tool.messageID !== claim.messageID && tool.order < claim.order)
    && !tools.some(tool => tool.exactPlanRead && tool.order < claim.order));
  const unresolvedClaims = globOnlyClaims.filter(claim => !tools.some(tool => tool.exactPlanRead
    && tool.status === 'completed' && tool.order > claim.order));
  return { tools, claims, planExists: planExists === true, planUnchanged: planUnchanged === true,
    missingPathInferenceCandidate: planExists === true && planUnchanged === true && unresolvedClaims.length > 0,
    candidateClaims: unresolvedClaims, globOnlyClaims, classificationRequiresHumanReview: true, ...excludedAcceptance };
}

export function projectQaDiagnosticQuestions(questions, { sessionID, assistants }) {
  return questions.filter(item => item.sessionID === sessionID).map(item => ({
    ...item, correlated: assistants.some(row => row.info?.sessionID === sessionID && row.info.id === item.tool?.messageID
      && row.parts?.some(part => part.type === 'tool' && part.tool === 'question' && part.callID === item.tool?.callID
        && ['pending', 'running'].includes(part.state?.status))),
  }));
}

export function compareQaRetrievalPair(control, compacted) {
  const reasons = [];
  if (!control || !compacted) reasons.push('Both fresh arms must be retained');
  if (control?.arm !== 'control' || compacted?.arm !== 'compacted') reasons.push('Arm identities differ');
  if (control?.precondition?.passed !== true || compacted?.precondition?.passed !== true) reasons.push('At least one authoritative precondition failed');
  if (!control?.identity || !compacted?.identity || JSON.stringify(control.identity) !== JSON.stringify(compacted.identity)) reasons.push('Candidate, profile, fixture, policy or submitted inputs differ');
  if (control?.evidenceComplete !== true || compacted?.evidenceComplete !== true) reasons.push('Evidence is incomplete or journal health failed');
  if (control?.probeSubmitted !== true || compacted?.probeSubmitted !== true) reasons.push('Both neutral continuation inputs were not observed');
  if (control?.manipulation?.passed !== true || compacted?.manipulation?.passed !== true) reasons.push('The compaction/control boundary was not established');
  const c = control?.behavior?.missingPathInferenceCandidate === true;
  const k = compacted?.behavior?.missingPathInferenceCandidate === true;
  let candidates = 'neither-arm';
  if (c && k) candidates = 'both-arms';
  else if (c) candidates = 'control-only';
  else if (k) candidates = 'compacted-only';
  let classification = 'awaiting-human-classification';
  if (reasons.length) classification = 'incomparable';
  else if ([control?.observationOutcome, compacted?.observationOutcome].some(value => !['settled', 'pending-question'].includes(value))) {
    classification = 'generic-failure-unresolved';
  }
  return { comparable: reasons.length === 0, reasons, retrievalEvidenceCandidates: candidates,
    classification,
    outcomes: { control: control?.observationOutcome ?? 'missing', compacted: compacted?.observationOutcome ?? 'missing' },
    generatedPlanHashes: { control: control?.precondition?.plan?.sha256 ?? null, compacted: compacted?.precondition?.plan?.sha256 ?? null },
    differingGeneratedPlansRetained: true, ...excludedAcceptance };
}

export function summarizeQaRetrievalStudy(arms) {
  const expected = createQaRetrievalDiagnosticMatrix({ evidenceRoot: '.cache/qa/diagnostic' }).cells.map(cell => cell.id);
  const duplicateIDs = arms.filter((arm, index) => arms.findIndex(item => item.id === arm.id) !== index).map(arm => arm.id);
  const unexpectedIDs = arms.filter(arm => !expected.includes(arm.id)).map(arm => arm.id);
  const pairs = [1, 2, 3].map(pair => {
    const control = arms.find(arm => arm.id === 'retrieval-pair-' + pair + '-control');
    const compacted = arms.find(arm => arm.id === 'retrieval-pair-' + pair + '-compacted');
    return { pair, ...compareQaRetrievalPair(control?.diagnostic, compacted?.diagnostic),
      matrixOutcomes: { control: control?.outcome ?? 'missing', compacted: compacted?.outcome ?? 'missing' } };
  });
  return { purpose: 'manual-summary-retrieval-diagnostic', completedArms: arms.length,
    allArmRecordsPresent: expected.every(id => arms.some(arm => arm.id === id)) && duplicateIDs.length === 0 && unexpectedIDs.length === 0,
    counterbalancedOrder: JSON.stringify(arms.map(arm => arm.id)) === JSON.stringify(expected),
    duplicateIDs, unexpectedIDs, pairs, classificationRequiresHumanReview: true, ...excludedAcceptance };
}

export async function runQaRetrievalDiagnostic({ cell, projectFixture, ui, api, check, screenshot, sendTurn,
  messages, getSessionID, readProviderObservation, nativeOutputTokenMax, nativeAgent, identity, sanitize = value => value,
  record }) {
  assert.ok(QA_RETRIEVAL_SCENARIOS.includes(cell.scenarioId) && cell.runtime === 'electron' && cell.transport === 'live'
    && cell.agent === 'builder' && cell.planMode === false, 'Retrieval diagnostics require live Electron Builder with Plan off');
  const arm = cell.scenarioId.endsWith('-control') ? 'control' : 'compacted';
  const evidence = { schemaVersion: 1, purpose: 'manual-summary-retrieval-diagnostic', arm, ...excludedAcceptance,
    observationOutcome: 'incomplete', stage: 'diagnosis', identity, precondition: { passed: false },
    manipulation: { passed: false }, submittedUserMessageIDs: [], inputs: [], questions: [] };
  const persist = async () => {
    record(evidence);
    await writeFile(path.join(projectFixture.evidenceDirectory, 'retrieval-diagnostic.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  };
  const planState = async name => {
    const target = path.join(projectFixture.fixtureRoot, QA_RETRIEVAL_PLAN);
    try {
      assert.ok((await realpath(target)).startsWith((await realpath(projectFixture.fixtureRoot)) + path.sep), 'Plan escaped the owned fixture');
      const content = await readFile(target, 'utf8');
      const saved = { path: path.join(projectFixture.evidenceDirectory, name + '.md'), sha256: digest(content) };
      await writeFile(saved.path, content, { mode: 0o600 });
      const grade = gradeQaProject({ fixture: projectFixture, phase: 'plan', savedPlan: saved });
      return { exists: true, sha256: saved.sha256, bytes: Buffer.byteLength(content), creationOrder: /creation order/i.test(content),
        priorityFilter: /priority filter/i.test(content), pausedProject: grade.passed, changedPaths: grade.changedPaths,
        repositoryRevision: projectFixture.seed.revision, phase: 'paused-before-implementation', objectiveRevision: 2 };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { exists: false, pausedProject: false };
    }
  };
  const uncorrelatedQuestions = new Set();
  const observeQuestions = async ({ rows, submitted, assistants = rows.filter(row => !beforeProbeIds.has(row.info.id) && row.info.role === 'assistant' && !row.info.summary) }) => {
    if (submitted) {
      assertQaSubmittedPlanMode(submitted, false);
      assert.equal(submitted.info.model?.providerID, cell.providerId, 'Diagnostic provider changed');
      assert.equal(submitted.info.model?.modelID, cell.modelId, 'Diagnostic model changed');
      assert.equal(submitted.info.agent, nativeAgent, 'Diagnostic primary agent changed');
      assert.equal(submitted.info.model?.variant ?? submitted.info.variant ?? '', cell.variant ?? '', 'Diagnostic thinking changed');
      if (evidence.stage === 'probe') evidence.probeSubmitted = true;
    }
    if (submitted && !evidence.submittedUserMessageIDs.includes(submitted.info.id)) evidence.submittedUserMessageIDs.push(submitted.info.id);
    const questions = await api('/api/question?directory=' + encodeURIComponent(projectFixture.fixtureRoot));
    assert.ok(Array.isArray(questions), 'Question observation is unavailable');
    const scoped = projectQaDiagnosticQuestions(questions, { sessionID: getSessionID(), assistants });
    if (!scoped.length) return;
    // The question endpoint may lead the canonical message fetch by one poll.
    // A second unchanged unmatched request is preserved as an uncorrelated stop.
    const newlyUncorrelated = scoped.filter(item => !item.correlated && !uncorrelatedQuestions.has(item.id));
    scoped.filter(item => !item.correlated).forEach(item => uncorrelatedQuestions.add(item.id));
    if (newlyUncorrelated.length && !scoped.some(item => item.correlated)) return;
    evidence.questions = scoped.map(item => ({ id: item.id, sessionID: item.sessionID, tool: item.tool ?? null, correlated: item.correlated,
      questions: (item.questions ?? []).map(question => ({ header: sanitize(question.header ?? ''), question: sanitize(question.question ?? ''),
        options: (question.options ?? []).map(option => ({ label: sanitize(option.label ?? ''), description: sanitize(option.description ?? '') })) })) }));
    evidence.observationOutcome = scoped.every(item => item.correlated) ? 'pending-question' : 'uncorrelated-pending-question';
    evidence.questionMessageIDs = scoped.filter(item => item.correlated).map(item => item.tool.messageID);
    await persist();
    throw new Error('Retrieval diagnostic stopped at a pending question without answering');
  };
  const submit = async (name, text) => {
    evidence.stage = name;
    evidence.inputs.push({ name, sha256: digest(text), bytes: Buffer.byteLength(text) });
    await writeFile(path.join(projectFixture.evidenceDirectory, 'diagnostic-input-' + name + '.txt'), text, { mode: 0o600 });
    await persist();
    return sendTurn(text, { onTurnObservation: observeQuestions });
  };
  let beforeProbeIds = new Set();
  let observedRows = [];
  try {
    await check('diagnostic diagnosis and implementation pause', async () => {
      await ui.attach(projectFixture.attachments.map(item => item.path));
      await submit('diagnosis', diagnosis);
      evidence.firstPlan = await planState('diagnostic-plan-revision-1');
      assert.ok(evidence.firstPlan.exists && evidence.firstPlan.pausedProject, 'Diagnosis failed to preserve a saved paused plan');
      await screenshot('diagnostic-diagnosis');
    });
    await check('diagnostic revision 2', async () => {
      await submit('revision', projectFixture.prompts.revision + revisionSuffix);
      const plan = await planState('diagnostic-plan-revision-2');
      evidence.precondition.plan = plan;
      assert.ok(plan.pausedProject && plan.creationOrder && plan.priorityFilter && plan.sha256 !== evidence.firstPlan.sha256,
        'Revision 2 did not establish the requested paused replacement plan');
      await screenshot('diagnostic-revised-plan');
    });
    await check('diagnostic matched ordinary audit workload', async () => {
      const workload = createQaNaturalWorkload({ batch: 1, maximumBytes: 256 * 1024 });
      await submit('audit', workload.text);
      observedRows = await messages();
      evidence.baselineActions = projectCompactionActions(observedRows, { directory: projectFixture.fixtureRoot, rootSessionID: getSessionID() });
      const plan = await planState('diagnostic-plan-before');
      const health = await api('/api/health');
      const config = await api('/api/config?directory=' + encodeURIComponent(projectFixture.fixtureRoot));
      const observation = (await readProviderObservation()).toReversed().find(item => item.kind === 'chat.params'
        && item.sessionID === getSessionID() && item.providerID === cell.providerId && item.modelID === cell.modelId);
      const policy = deriveQaNativeCompactionPolicy({ version: health.openCodeVersion, modelLimits: observation?.modelLimits,
        compaction: config.compaction, outputTokenMax: nativeOutputTokenMax });
      const latest = observedRows.toReversed().find(row => row.info?.role === 'assistant' && !row.info.summary && row.info.time?.completed && !row.info.error);
      const usage = qaNativeTokenUsage(latest?.info.tokens);
      const checks = {
        planPreserved: plan.exists && plan.pausedProject && plan.sha256 === evidence.precondition.plan.sha256,
        sourceReadObserved: evidence.baselineActions.completedInspections.some(item => item.relativePath === 'src/tasks.mjs'),
        nativeFailedTestObserved: evidence.baselineActions.failedTests.length > 0,
        noPriorCompaction: boundaryParts(observedRows).length === 0,
        belowNativeThreshold: usage !== null && usage < policy.threshold,
        builderSelected: ['build', 'builder'].includes(nativeAgent),
      };
      evidence.identity = { ...identity, selection: { providerID: cell.providerId, modelID: cell.modelId, agent: nativeAgent, planMode: false, variant: cell.variant },
        inputs: evidence.inputs, policy, neutralProbeSha256: digest(QA_RETRIEVAL_PROBE) };
      evidence.precondition = { passed: Object.values(checks).every(Boolean), checks, plan, usage, policy };
      await persist();
      assert.ok(evidence.precondition.passed, 'Diagnostic preconditions failed; this arm is retained as incomparable');
      await screenshot('diagnostic-before-manipulation');
    });
    beforeProbeIds = new Set(observedRows.map(row => row.info.id));
    await check('diagnostic ' + arm + ' manipulation', async () => {
      evidence.stage = 'manipulation';
      if (arm === 'compacted') {
        const previous = boundaryParts(observedRows).map(part => part.id);
        await ui.send('/compact');
        const boundary = await ui.waitFor('diagnostic native manual summary', async () => {
          const rows = await messages();
          await observeQuestions({ rows });
          const failure = rows.find(row => !beforeProbeIds.has(row.info.id) && row.info?.error);
          if (failure) throw new Error('Native diagnostic compaction failed: ' + (failure.info.error.name ?? 'unknown'));
          return findManualCompactionBoundary(rows, previous);
        }, cell.timeoutMs);
        await ui.waitFor('diagnostic idle after manual summary', async () => {
          const status = await api('/api/session/status?directory=' + encodeURIComponent(projectFixture.fixtureRoot));
          return !status[getSessionID()] || status[getSessionID()].type === 'idle';
        }, cell.timeoutMs);
        const observations = (await readProviderObservation()).filter(item => item.sessionID === getSessionID());
        boundary.nativeCycle = findQaNativeCompactionCycle(observations, boundary.observedAt);
        evidence.boundary = boundary;
        assert.ok(boundary.nativeCycle && boundary.auto === false && !boundary.overflow, 'Native manual boundary was not established');
        const row = (await messages()).find(item => item.info.id === boundary.summaryMessageId);
        const summary = textOf(row);
        evidence.summary = { messageID: row.info.id, sha256: digest(summary), bytes: Buffer.byteLength(summary),
          containsPlanPath: summary.includes(QA_RETRIEVAL_PLAN), content: sanitize(summary) };
      }
      observedRows = await messages();
      assert.equal(boundaryParts(observedRows).length, arm === 'compacted' ? 1 : 0, 'Unexpected compaction contaminated the control or compacted arm');
      const plan = await planState('diagnostic-plan-after-manipulation');
      evidence.manipulation = { passed: plan.pausedProject && plan.sha256 === evidence.precondition.plan.sha256, plan,
        boundaryCount: boundaryParts(observedRows).length };
      await persist();
      assert.ok(evidence.manipulation.passed, 'Manipulation changed the saved plan or paused project');
      await screenshot('diagnostic-after-manipulation');
    });
    await check('diagnostic identical neutral continuation', async () => {
      await submit('probe', QA_RETRIEVAL_PROBE);
      evidence.observationOutcome = 'settled';
      await screenshot('diagnostic-continuation');
    });
  } catch (error) {
    if (!['pending-question', 'uncorrelated-pending-question'].includes(evidence.observationOutcome)) evidence.observationOutcome = 'native-provider-permission-or-precondition-failure';
    evidence.functionalObservation = 'failed';
    evidence.failure = { stage: evidence.stage, message: sanitize(error.message) };
    throw error;
  } finally {
    try {
      observedRows = await messages();
      const after = await planState('diagnostic-plan-after');
      evidence.after = after;
      const probe = findQaSubmittedUser(observedRows, beforeProbeIds, QA_RETRIEVAL_PROBE);
      evidence.probeSubmitted = !!probe;
      evidence.probeUserMessageID = probe?.info.id ?? null;
      if (probe && !evidence.submittedUserMessageIDs.includes(probe.info.id)) evidence.submittedUserMessageIDs.push(probe.info.id);
      evidence.behavior = projectQaRetrievalBehavior(observedRows, { previousIds: beforeProbeIds, directory: projectFixture.fixtureRoot,
        planExists: after.exists, planUnchanged: after.sha256 === evidence.precondition.plan?.sha256 });
      evidence.behavior.scope = beforeProbeIds.size ? 'post-prefix manipulation and neutral continuation' : 'failed precondition; no comparison probe';
      evidence.canonicalEvidence = observedRows.filter(row => row.info?.role === 'assistant').map(row => ({
        messageID: row.info.id, parentID: row.info.parentID, time: row.info.time ?? null, summary: row.info.summary === true, errorName: row.info.error?.name ?? null,
        text: sanitize(textOf(row)).slice(0, 32768), textBytes: Buffer.byteLength(textOf(row)), textTruncated: textOf(row).length > 32768,
        tools: (row.parts ?? []).filter(part => part.type === 'tool').map(part => ({
          callID: part.callID, tool: part.tool, status: part.state?.status, time: part.state?.time ?? null,
          input: sanitize(JSON.stringify(part.state?.input ?? {})).slice(0, 32768),
          output: sanitize(part.state?.output ?? part.state?.error ?? '').slice(0, 32768),
          outputBytes: Buffer.byteLength(part.state?.output ?? part.state?.error ?? ''),
          outputTruncated: (part.state?.output ?? part.state?.error ?? '').length > 32768,
        })),
      }));
      evidence.pausedActions = projectCompactionActions(observedRows, { directory: projectFixture.fixtureRoot, rootSessionID: getSessionID() });
      const baseline = [...(evidence.baselineActions?.completedInspections ?? []), ...(evidence.baselineActions?.failedTests ?? [])];
      const known = new Set(baseline.map(item => item.callId));
      const actions = new Set(baseline.map(item => item.actionId));
      evidence.repeatedCompletedActions = [...evidence.pausedActions.completedInspections, ...evidence.pausedActions.failedTests]
        .filter(item => !known.has(item.callId) && actions.has(item.actionId));
      evidence.journalHealth = await api('/api/diagnostics/status');
      evidence.evidenceComplete = evidence.journalHealth.gapRecords === 0 && !evidence.journalHealth.lastError;
    } catch (error) {
      evidence.captureFailure = sanitize(error.message);
      evidence.evidenceComplete = false;
    }
    await persist();
  }
  try {
  assert.ok(evidence.evidenceComplete, 'Diagnostic evidence has a capture failure or journal gap');
  assert.ok(evidence.after.pausedProject && evidence.after.sha256 === evidence.precondition.plan.sha256, 'Neutral continuation changed the paused project');
  assert.equal(evidence.repeatedCompletedActions.length, 0, 'Neutral continuation repeated a completed source inspection or failed test');
    evidence.functionalObservation = evidence.behavior.missingPathInferenceCandidate ? 'review-required' : 'passed';
    if (evidence.functionalObservation === 'review-required') evidence.reviewReason = 'Unresolved canonical missing-path inference candidate; semantic classification is reserved for human review';
  } catch (error) {
    evidence.functionalObservation = 'failed';
    evidence.failure = { stage: 'post-continuation-verification', message: sanitize(error.message) };
    throw error;
  } finally { await persist(); }
  return evidence;
}
