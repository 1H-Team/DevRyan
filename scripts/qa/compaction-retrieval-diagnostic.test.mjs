import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQaProjectFixture } from './project-fixture.mjs';
import { compareQaRetrievalPair, createQaRetrievalDiagnosticMatrix, projectQaDiagnosticQuestions, projectQaRetrievalBehavior,
  QA_RETRIEVAL_PLAN, QA_RETRIEVAL_PROBE, runQaRetrievalDiagnostic, summarizeQaRetrievalStudy } from './compaction-retrieval-diagnostic.mjs';
import { expandQaMatrix, validateQaMatrixConfig } from './matrix-config.mjs';

const directory = '/fixture/project';
const assistant = (id, parts, extra = {}) => ({ info: { id, role: 'assistant', ...extra }, parts });
const glob = () => ({ type: 'tool', tool: 'glob', callID: 'call_glob', state: {
  status: 'completed', input: { pattern: '.opencode/plans/**/*' }, output: 'No files found',
} });
const question = text => ({ type: 'tool', tool: 'question', callID: 'call_question', state: {
  status: 'running', input: { questions: [{ question: text }] },
} });
const claim = 'The saved plan is gone. There is no .opencode/plans/ file.';
const projection = (rows, patch = {}) => projectQaRetrievalBehavior(rows, { directory, planExists: true, planUnchanged: true, ...patch });
const arm = kind => ({ arm: kind, identity: { artifact: 'fixed', inputs: ['same'], policy: { threshold: 468000 } },
  precondition: { passed: true, plan: { sha256: kind + '-generated-plan' } }, manipulation: { passed: true },
  evidenceComplete: true, probeSubmitted: true, observationOutcome: 'settled', behavior: { missingPathInferenceCandidate: false } });

test('three diagnostic pairs are fresh, pinned, counterbalanced and use one isolated scenario each', () => {
  const config = createQaRetrievalDiagnosticMatrix({ evidenceRoot: '.cache/qa/retrieval-test' });
  const cells = expandQaMatrix(config);
  assert.equal(cells.length, 6);
  assert.deepEqual(cells.map(cell => cell.scenarioId), ['control', 'compacted', 'compacted', 'control', 'control', 'compacted'].map(arm => 'compaction-retrieval-' + arm));
  assert.equal(new Set(cells.map(cell => cell.runId)).size, 6);
  assert.ok(cells.every(cell => cell.providerId === 'xai' && cell.modelId === 'grok-4.6' && cell.runtime === 'electron'
    && cell.agent === 'builder' && cell.variant === null && cell.planMode === false && cell.transport === 'live'));
  assert.equal(QA_RETRIEVAL_PROBE, 'Continue with the next permitted step from the current state.');
  for (const patch of [{ runtime: 'web' }, { transport: 'fixture', providerId: 'fixture' }, { agent: 'orchestrator' }, { planMode: true }]) {
    const changed = structuredClone(config);
    Object.assign(changed.cells[0], patch);
    assert.throws(() => validateQaMatrixConfig(changed), /live Electron Builder/);
  }
});

test('glob-only missing-path inference requires preserved file, ordered canonical empty glob and actual claim', () => {
  const rows = [assistant('msg_tools', [glob()]), assistant('msg_claim', [question(claim)])];
  const evidence = projection(rows);
  assert.equal(evidence.missingPathInferenceCandidate, true);
  assert.equal(evidence.candidateClaims[0].callID, 'call_question');
  assert.equal(evidence.classificationRequiresHumanReview, true);
  assert.equal(evidence.retentionAcceptance, false);
  assert.equal(projection(rows, { planExists: false }).missingPathInferenceCandidate, false);
  assert.equal(projection(rows, { planUnchanged: false }).missingPathInferenceCandidate, false);
  assert.equal(projection(rows.toReversed()).missingPathInferenceCandidate, false);
  assert.equal(projection([assistant('same_parallel_step', [glob(), question(claim)])]).missingPathInferenceCandidate, false);
  assert.equal(projection(rows, { previousIds: new Set(['msg_tools']) }).missingPathInferenceCandidate, false);
  assert.equal(projection([assistant('msg_tools', [glob()])]).missingPathInferenceCandidate, false);
});

test('exact-path reads prevent a glob-only inference claim and unrelated read/search/error state does not qualify', () => {
  const read = { type: 'tool', tool: 'read', callID: 'call_read', state: { status: 'completed',
    input: { filePath: directory + '/' + QA_RETRIEVAL_PLAN }, output: 'The full current plan' } };
  const rows = [assistant('msg_tools', [glob(), read]), assistant('msg_claim', [question(claim)])];
  assert.equal(projection(rows).missingPathInferenceCandidate, false);
  rows[0].parts[1].state.input.filePath = directory + '/README.md';
  assert.equal(projection(rows).missingPathInferenceCandidate, true);
  rows[0].parts[0].state.status = 'error';
  assert.equal(projection(rows).missingPathInferenceCandidate, false);
  rows[0].parts[0] = glob(); rows[0].parts[0].state.input.pattern = 'src/**/*';
  assert.equal(projection(rows).missingPathInferenceCandidate, false);
});

test('historical summaries and generic permission/provider questions cannot fabricate retrieval failure', () => {
  const rows = [assistant('summary', [{ type: 'text', text: claim }], { summary: true }),
    assistant('tools', [glob()]), assistant('generic', [question('The provider failed. Should I retry?')])];
  assert.equal(projection(rows).missingPathInferenceCandidate, false);
  assert.equal(projection([assistant('tools', [glob()]), assistant('claim', [question('If the saved plan is missing, should I stop?')])]).missingPathInferenceCandidate, false);
});

test('a later successful exact read resolves the triage candidate while retaining the original claim ordering', () => {
  const rows = [assistant('tools', [glob()]), assistant('claim', [question(claim)]),
    assistant('resolved', [{ type: 'tool', tool: 'read', callID: 'read_later',
      state: { status: 'completed', input: { filePath: directory + '/' + QA_RETRIEVAL_PLAN }, output: 'Plan content' } }])];
  const result = projection(rows);
  assert.equal(result.missingPathInferenceCandidate, false);
  assert.equal(result.globOnlyClaims.length, 1);
  assert.equal(result.claims.length, 1);
  assert.equal(result.tools.at(-1).exactPlanRead, true);
});

test('questions correlate only to the current root assistant and exact pending call', () => {
  const current = assistant('current', [question(claim)], { sessionID: 'root' });
  const requests = [
    { id: 'fresh', sessionID: 'root', tool: { messageID: 'current', callID: 'call_question' } },
    { id: 'old', sessionID: 'root', tool: { messageID: 'historical', callID: 'call_question' } },
    { id: 'wrong-call', sessionID: 'root', tool: { messageID: 'current', callID: 'different' } },
    { id: 'missing-parent', sessionID: 'root' },
    { id: 'other-root', sessionID: 'other', tool: { messageID: 'current', callID: 'call_question' } },
  ];
  const result = projectQaDiagnosticQuestions(requests, { sessionID: 'root', assistants: [current] });
  assert.deepEqual(result.map(item => [item.id, item.correlated]), [['fresh', true], ['old', false], ['wrong-call', false], ['missing-parent', false]]);
  current.parts[0].state.status = 'completed';
  assert.equal(projectQaDiagnosticQuestions(requests, { sessionID: 'root', assistants: [current] })[0].correlated, false);
});

test('matched pairs retain different generated plans and distinguish compacted/control/both candidates', () => {
  const c = arm('control'); const k = arm('compacted');
  let result = compareQaRetrievalPair(c, k);
  assert.equal(result.comparable, true);
  assert.deepEqual(result.generatedPlanHashes, { control: 'control-generated-plan', compacted: 'compacted-generated-plan' });
  assert.equal(result.retrievalEvidenceCandidates, 'neither-arm');
  k.behavior.missingPathInferenceCandidate = true;
  assert.equal(compareQaRetrievalPair(c, k).retrievalEvidenceCandidates, 'compacted-only');
  c.behavior.missingPathInferenceCandidate = true;
  assert.equal(compareQaRetrievalPair(c, k).retrievalEvidenceCandidates, 'both-arms');
  k.behavior.missingPathInferenceCandidate = false;
  assert.equal(compareQaRetrievalPair(c, k).retrievalEvidenceCandidates, 'control-only');
});

test('incomparable preconditions and generic failures remain visible and never establish retention acceptance', () => {
  for (const modify of [
    value => { value.precondition.passed = false; }, value => { value.identity.inputs = ['different']; },
    value => { value.manipulation.passed = false; }, value => { value.evidenceComplete = false; },
    value => { value.probeSubmitted = false; },
  ]) {
    const c = arm('control'); modify(c);
    const result = compareQaRetrievalPair(c, arm('compacted'));
    assert.equal(result.comparable, false);
    assert.equal(result.classification, 'incomparable');
    assert.equal(result.naturalCompactionAcceptance, false);
  }
  const failed = arm('compacted'); failed.observationOutcome = 'native-provider-permission-or-precondition-failure';
  const result = compareQaRetrievalPair(arm('control'), failed);
  assert.equal(result.classification, 'generic-failure-unresolved');
  assert.equal(result.retrievalEvidenceCandidates, 'neither-arm');
  assert.equal(result.outcomes.compacted, failed.observationOutcome);
  assert.equal(result.automaticContinuationAcceptance, false);
});

test('study aggregation retains all three pairs, matrix failures, missing arms and execution order', () => {
  const records = createQaRetrievalDiagnosticMatrix({ evidenceRoot: '.cache/qa/retrieval-test' }).cells.map(cell => ({
    id: cell.id, outcome: cell.id === 'retrieval-pair-1-compacted' ? 'failed' : 'passed',
    diagnostic: arm(cell.id.endsWith('-control') ? 'control' : 'compacted'),
  }));
  const result = summarizeQaRetrievalStudy(records);
  assert.equal(result.allArmRecordsPresent, true);
  assert.equal(result.counterbalancedOrder, true);
  assert.equal(result.pairs.length, 3);
  assert.equal(result.pairs[0].matrixOutcomes.compacted, 'failed');
  assert.equal(result.retentionAcceptance, false);
  assert.equal(summarizeQaRetrievalStudy(records.toReversed()).counterbalancedOrder, false);
  assert.equal(summarizeQaRetrievalStudy(records.slice(1)).allArmRecordsPresent, false);
  assert.equal(summarizeQaRetrievalStudy([...records, records[0]]).allArmRecordsPresent, false);
});

test('diagnostic adapter cannot be used as a manual/natural/fixture acceptance adapter', async () => {
  for (const cell of [
    { scenarioId: 'compaction-natural', transport: 'live', runtime: 'electron', agent: 'builder', planMode: false },
    { scenarioId: 'compaction-retrieval-control', transport: 'fixture', runtime: 'electron', agent: 'builder', planMode: false },
    { scenarioId: 'compaction-retrieval-compacted', transport: 'live', runtime: 'electron', agent: 'orchestrator', planMode: false },
  ]) await assert.rejects(runQaRetrievalDiagnostic({ cell }), /live Electron Builder/);
});

async function exerciseAdapter(kind, { pendingQuestion = false, uncorrelated = false } = {}) {
  const fixture = createQaProjectFixture({ outputRoot: fileURLToPath(new URL('../../.cache/qa/retrieval-diagnostic-unit', import.meta.url)), runId: 'adapter-' + kind });
  const rows = [];
  const prompts = [];
  const commands = [];
  const screenshots = [];
  const sessionID = 'ses_diagnostic';
  let questions = [];
  let recorded;
  const cell = { scenarioId: 'compaction-retrieval-' + kind, runtime: 'electron', transport: 'live',
    agent: 'builder', providerId: 'xai', modelId: 'grok-4.6', variant: null, planMode: false, timeoutMs: 1000 };
  const api = async (route, options) => {
    assert.equal(options, undefined, 'The diagnostic must not send API mutations');
    if (route.startsWith('/api/question')) return questions;
    if (route.startsWith('/api/session/status')) return {};
    if (route === '/api/health') return { openCodeVersion: '1.18.29' };
    if (route.startsWith('/api/config?')) return {};
    if (route === '/api/diagnostics/status') return { gapRecords: 0, lastError: null };
    throw new Error('Unexpected diagnostic API: ' + route);
  };
  try {
    let failure;
    try {
      await runQaRetrievalDiagnostic({
        cell, projectFixture: fixture, nativeAgent: 'builder', identity: { source: 'fixed', fixture: fixture.seedManifestSha256 },
        record: value => { recorded = structuredClone(value); }, api, screenshot: async name => { screenshots.push(name); },
        check: async (_name, action) => action(), messages: async () => rows, getSessionID: () => sessionID,
        readProviderObservation: async () => [
          { kind: 'chat.params', sessionID, providerID: 'xai', modelID: 'grok-4.6', modelLimits: { context: 500000, output: 32000 } },
          ...(commands.length ? [{ kind: 'native.compacting', sessionID, at: 100 }, { kind: 'native.session.compacted', sessionID, at: 205 }] : []),
        ],
        ui: {
          attach: async files => assert.equal(files.length, 2),
          send: async text => {
            commands.push(text);
            assert.equal(text, '/compact');
            rows.push({ info: { id: 'msg_boundary', role: 'user', sessionID }, parts: [{ id: 'prt_boundary', type: 'compaction', auto: false }] });
            rows.push(assistant('msg_summary', [{ type: 'text', text: 'Revision 2 remains paused at ' + QA_RETRIEVAL_PLAN }], {
              sessionID, parentID: 'msg_boundary', summary: true, time: { completed: 200 },
            }));
          },
          waitFor: async (_name, observe) => {
            const result = await observe();
            assert.ok(result, 'The mocked native lifecycle must settle without extra polling');
            return result;
          },
        },
        sendTurn: async (text, { onTurnObservation }) => {
          prompts.push(text);
          const id = 'msg_user_' + prompts.length;
          const user = { info: { id, sessionID, role: 'user', agent: 'builder', model: { providerID: 'xai', modelID: 'grok-4.6', variant: '' } },
            parts: [{ type: 'text', text }] };
          rows.push(user);
          if (prompts.length <= 2) {
            await mkdir(path.join(fixture.fixtureRoot, '.opencode/plans'), { recursive: true });
            await writeFile(path.join(fixture.fixtureRoot, QA_RETRIEVAL_PLAN),
              prompts.length === 1 ? 'Revision 1 plan' : 'Revision 2 plan: creation order and Priority filter. Implementation paused.');
          }
          const parts = prompts.length === 1 ? [
            { type: 'tool', tool: 'read', callID: 'call_source', state: { status: 'completed', input: { filePath: path.join(fixture.fixtureRoot, 'src/tasks.mjs') } } },
            { type: 'tool', tool: 'bash', callID: 'call_initial_test', state: { status: 'completed', input: { command: 'node --test test/tasks.test.mjs' }, metadata: { exit: 1 } } },
          ] : [{ type: 'text', text: 'Implementation remains paused.' }];
          const response = assistant('msg_assistant_' + prompts.length, parts, { sessionID, parentID: id, time: { completed: 50 }, tokens: { total: 10000 } });
          if (text === QA_RETRIEVAL_PROBE && pendingQuestion) {
            rows.push(assistant('msg_probe_glob', [glob()], { sessionID, parentID: id }));
            response.parts = [question(claim)];
            questions = [{ id: 'que_current', sessionID, tool: { messageID: uncorrelated ? 'msg_previous' : response.info.id, callID: 'call_question' },
              questions: [{ question: claim, options: [{ label: 'Keep waiting' }] }] }];
          }
          rows.push(response);
          await onTurnObservation({ rows, submitted: user, assistants: [response] });
          // The grace observation is exercised without an actual network or provider.
          if (uncorrelated && questions.length) await onTurnObservation({ rows, submitted: user, assistants: [response] });
          return rows;
        },
      });
    } catch (error) { failure = error; }
    const persisted = JSON.parse(await readFile(path.join(fixture.evidenceDirectory, 'retrieval-diagnostic.json'), 'utf8'));
    return { prompts, commands, screenshots, evidence: recorded, persisted, failure };
  } finally { await rm(fixture.evidenceDirectory, { recursive: true, force: true }); }
}

test('adapter uses identical ordinary prompts and only compacted arm invokes the real UI compact contract', async () => {
  const c = await exerciseAdapter('control');
  const k = await exerciseAdapter('compacted');
  assert.equal(c.failure, undefined);
  assert.equal(k.failure, undefined);
  assert.deepEqual(c.prompts, k.prompts);
  assert.equal(c.prompts.length, 4);
  assert.equal(c.prompts.at(-1), QA_RETRIEVAL_PROBE);
  assert.deepEqual(c.commands, []);
  assert.deepEqual(k.commands, ['/compact']);
  assert.equal(c.evidence.manipulation.boundaryCount, 0);
  assert.equal(k.evidence.manipulation.boundaryCount, 1);
  assert.equal(k.evidence.summary.containsPlanPath, true);
  assert.equal(k.evidence.probeSubmitted, true);
  assert.equal(k.evidence.evidenceComplete, true);
  assert.equal(k.evidence.functionalObservation, 'passed');
  assert.equal(k.evidence.retentionAcceptance, false);
});

test('adapter stops on exact current questions, preserves their evidence and never submits a reply or repair', async () => {
  for (const uncorrelated of [false, true]) {
    const run = await exerciseAdapter('compacted', { pendingQuestion: true, uncorrelated });
    assert.match(run.failure.message, /pending question without answering/);
    assert.equal(run.prompts.length, 4);
    assert.deepEqual(run.commands, ['/compact']);
    assert.equal(run.persisted.observationOutcome, uncorrelated ? 'uncorrelated-pending-question' : 'pending-question');
    assert.equal(run.persisted.questions[0].correlated, !uncorrelated);
    assert.equal(run.persisted.after.sha256, run.persisted.precondition.plan.sha256);
    assert.equal(run.persisted.behavior.missingPathInferenceCandidate, true);
    assert.equal(run.persisted.functionalObservation, 'failed');
    assert.equal(run.persisted.probeSubmitted, true);
  }
});
