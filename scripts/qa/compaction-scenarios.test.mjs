import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { requireQaCompactionPlanSource } from './compaction-approval.mjs';
import { findManualCompactionBoundary, findQaNativeCompactionCycle, findQaPlanApprovalUser, projectCompactionTaskSnapshot, runQaManualCompaction } from './compaction-scenarios.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';

const rows = () => [
  { info: { id: 'msg_compact', role: 'user', time: { created: 100 } }, parts: [{ id: 'prt_compact', type: 'compaction', auto: false }] },
  { info: { id: 'msg_summary', role: 'assistant', parentID: 'msg_compact', summary: true, time: { created: 101, completed: 200 } }, parts: [{ type: 'text', text: 'Saved revision 2 and remaining obligations.' }] },
];

test('manual boundary requires a new native part and an exact completed summary parent', () => {
  const boundary = findManualCompactionBoundary(rows());
  assert.equal(boundary.eventId, 'prt_compact');
  assert.equal(boundary.summaryMessageId, 'msg_summary');
  assert.match(boundary.summarySha256, /^[a-f0-9]{64}$/);
  assert.equal(boundary.observedAt, 200);
  assert.equal(findManualCompactionBoundary(rows(), ['prt_compact']), null);
  for (const mutation of [
    value => { value[0].parts = [{ type: 'text', text: '/compact' }]; },
    value => { value[0].parts[0].auto = true; },
    value => { value[1].info.parentID = 'other-turn'; },
    value => { value[1].info.summary = false; },
    value => { delete value[1].info.time.completed; },
    value => { value[1].info.error = { name: 'APIError' }; },
    value => { value[1].parts[0].text = ' '; },
  ]) {
    const value = rows(); mutation(value);
    assert.equal(findManualCompactionBoundary(value), null);
  }
});

test('managed boundary evidence distinguishes live and undispositioned tasks using exact root identities', () => {
  const value = projectCompactionTaskSnapshot({ available: true, bridgeReady: true, recoveryWarning: null,
    tasks: [
      { rootSessionId: 'ses_root', taskId: 'active', status: 'running' },
      { rootSessionId: 'ses_root', taskId: 'waiting', status: 'completed' },
      { rootSessionId: 'ses_root', taskId: 'settled', status: 'completed' },
      { rootSessionId: 'ses_root', taskId: 'missing', status: 'completed' },
      { rootSessionId: 'ses_root', taskId: 'failed', status: 'failed' },
      { rootSessionId: 'ses_root', taskId: 'failed-envelope', status: 'completed' },
      { rootSessionId: 'ses_other', taskId: 'other', status: 'running' },
    ], resultEnvelopes: [
      { rootSessionId: 'ses_root', taskId: 'waiting', envelopeId: 'envelope_waiting', status: 'completed', action: null },
      { rootSessionId: 'ses_root', taskId: 'settled', envelopeId: 'envelope_settled', status: 'completed', action: 'continue' },
      { rootSessionId: 'ses_root', taskId: 'failed', envelopeId: 'envelope_failed', status: 'failed', action: null },
      { rootSessionId: 'ses_root', taskId: 'failed-envelope', envelopeId: 'envelope_invalid', status: 'failed', action: null },
    ],
  }, 'ses_root');
  assert.deepEqual(value.activeTaskIds, ['active']);
  assert.deepEqual(value.awaitingDispositionTaskIds, ['waiting']);
  assert.equal(value.tasks.length, 6);
  assert.equal(projectCompactionTaskSnapshot({ tasks: [], resultEnvelopes: [], available: false }, 'ses_root').state, 'unavailable');
  assert.equal(projectCompactionTaskSnapshot({ tasks: [] }, 'ses_root').state, 'unavailable');
});

test('manual adapter cannot stand in for natural or fixture compaction', async () => {
  await assert.rejects(runQaManualCompaction({ cell: { transport: 'fixture', scenarioId: 'compaction-manual' } }), /live manual/);
  await assert.rejects(runQaManualCompaction({ cell: { transport: 'live', scenarioId: 'compaction-natural' } }), /live manual/);
});

test('manual Plan-mode adapter captures initial and revised plans for the exact submitted human requests', async () => {
  const fixture = createQaProjectFixture({ runId: 'manual-plan-submitted-users', agent: 'orchestrator', planMode: true });
  const sessionID = 'ses_manual_plan';
  const requestIDs = ['msg_human_initial', 'msg_human_revision'];
  const contents = ['# Initial repair plan\n', '# Revised repair plan\n\nKeep creation order and add a Priority filter.\n'];
  const history = [{ info: { id: 'msg_historical', sessionID, role: 'user' }, parts: [{ type: 'text', text: '' }] }];
  const captures = [], screenshots = [], completedChecks = [], revisionReads = [];
  const stoppedAfterPlans = new Error('test stopped before compaction witnesses');
  let turnCount = 0;
  try {
    await assert.rejects(runQaManualCompaction({
      cell: { transport: 'live', runtime: 'electron', scenarioId: 'project-work', projectCompaction: 'manual',
        agent: 'orchestrator', planMode: true, timeoutMs: 10_000 },
      projectFixture: fixture, runDeadline: Date.now() + 10_000, getSessionID: () => sessionID,
      cdp: { send: async (method, params) => {
        assert.equal(method, 'Runtime.evaluate'); assert.equal(params.expression, 'location.origin');
        return { result: { value: 'http://127.0.0.1:3101' } };
      } },
      ui: { click: async () => {},
        waitExpression: async label => label.startsWith('authoritative Queue')
          ? { enabled: true, checked: 'true', pressed: 'true' } : true,
        attach: async paths => assert.deepEqual(paths, fixture.attachments.map(item => item.path)) },
      api: async route => {
        assert.ok(route.startsWith('/api/orchestration/snapshot?'));
        return { available: true, bridgeReady: true, recoveryWarning: null, tasks: [], resultEnvelopes: [] };
      },
      messages: async () => structuredClone(history),
      sendTurn: async text => {
        const index = turnCount++;
        assert.ok(index < 2, 'The test must stop before another live turn');
        history[0].parts[0].text = text;
        history.push(
          { info: { id: requestIDs[index], sessionID, role: 'user' }, parts: [
            { type: 'text', text }, { type: 'text', synthetic: true, text: 'User has requested to enter plan mode.' }] },
          { info: { id: `msg_plan_${index}`, sessionID, role: 'assistant', parentID: requestIDs[index],
            time: { created: 10, completed: 20 }, finish: 'stop' },
          parts: [{ type: 'text', text: `<!--plan-->\n${contents[index]}` }] },
          { info: { id: `msg_synthetic_${index}`, sessionID, role: 'user' }, parts: [{ type: 'text', synthetic: true, text }] },
          { info: { id: `msg_compaction_${index}`, sessionID, role: 'user' }, parts: [{ type: 'text', text }, { type: 'compaction' }] },
          { info: { id: `msg_other_${index}`, sessionID, role: 'user' }, parts: [{ type: 'text', text: 'Unrelated later request' }] },
        );
        return structuredClone(history);
      },
      captureSavedPlan: async (name, { userMessageID }) => {
        const index = captures.length;
        assert.equal(name, `compaction-plan-revision-${index + 1}`);
        assert.equal(userMessageID, requestIDs[index]);
        const source = requireQaCompactionPlanSource(history, { sessionID, userMessageID, content: contents[index] });
        const savedPath = path.join(fixture.evidenceDirectory, `${name}.md`);
        await writeFile(savedPath, contents[index]);
        const saved = { path: savedPath, canonicalPath: savedPath, userMessageID, sourceMessageID: source.info.id,
          sha256: createHash('sha256').update(contents[index]).digest('hex'),
          revision: { sessionId: sessionID, sourceMessageId: source.info.id, directory: fixture.fixtureRoot,
            sessionCreated: 1_750_000_000_000, sessionSlug: 'manual-plan' } };
        captures.push(saved);
        return saved;
      },
      readSavedRevision: async identity => {
        assert.deepEqual(identity, captures[1].revision);
        revisionReads.push(identity);
        return { identity, canonicalPath: captures[1].canonicalPath, content: await readFile(captures[1].path, 'utf8') };
      },
      screenshot: async name => { screenshots.push(name); },
      check: async (name, action) => {
        if (completedChecks.length === 3) throw stoppedAfterPlans;
        await action(); completedChecks.push(name);
      },
    }), error => error === stoppedAfterPlans);
    assert.equal(turnCount, 2);
    assert.deepEqual(captures.map(item => item.userMessageID), requestIDs);
    assert.equal(revisionReads.length, 1);
    assert.deepEqual(screenshots, ['compaction-diagnosis', 'compaction-revised-plan']);
    const evidence = JSON.parse(await readFile(path.join(fixture.evidenceDirectory, 'compaction-evidence.json'), 'utf8'));
    assert.equal(evidence.initialPlanGrade.passed, true);
    assert.equal(evidence.revisedPlanGrade.passed, true);
    assert.equal(evidence.expectedPausedState.planReference.userMessageID, requestIDs[1]);
    assert.deepEqual(evidence.plans.map(item => item.sourceMessageID), ['msg_plan_0', 'msg_plan_1']);
  } finally {
    removeQaProjectFixture(fixture);
    await rm(fixture.evidenceDirectory, { recursive: true, force: true });
  }
});

test('Plan approval selects its exact UI source request and enforces canonical selection after native continuation', () => {
  const cell={providerId:'openai',modelId:'fixture-model',agent:'builder',variant:null};
  const marker={action:'implement',sourceSessionId:'ses_root',sourceMessageId:'msg_plan',planIndex:0};
  const user={info:{id:'msg_approval',sessionID:'ses_root',role:'user',agent:'build',model:{providerID:'openai',modelID:'fixture-model',variant:''}},
    parts:[{type:'text',synthetic:true,text:'[openchamber-plan-action:v1] '+JSON.stringify(marker)}]};
  const continuation={info:{id:'msg_continue',role:'user'},parts:[{type:'text',synthetic:true,text:'Continue from where the previous response left off.'}]};
  const options={sessionID:'ses_root',sourceMessageID:'msg_plan',cell,nativeAgent:'build'};
  assert.equal(findQaPlanApprovalUser([user,...rows(),continuation],new Set(),options),user);
  assert.equal(findQaPlanApprovalUser([...rows(),continuation],new Set(),options),null);
  assert.equal(findQaPlanApprovalUser([user],new Set(['msg_approval']),options),null);
  const builder=structuredClone(user);builder.info.agent='builder';
  assert.equal(findQaPlanApprovalUser([builder],new Set(),{...options,nativeAgent:'builder'}),builder);
  assert.throws(()=>findQaPlanApprovalUser([builder],new Set(),options));
  for(const mutate of [
    value=>{value.info.model.variant='high';}, value=>{value.info.agent='orchestrator';},
    value=>{value.info.model.modelID='other';}, value=>{value.parts[0].text=value.parts[0].text.replace('msg_plan','msg_old');},
    value=>{value.parts.push({type:'text',synthetic:true,text:'User has requested to enter plan mode.'});},
  ]) {const changed=structuredClone(user);mutate(changed);assert.throws(()=>findQaPlanApprovalUser([changed],new Set(),options));}
});

test('native lifecycle requires one ordered cycle spanning the canonical summary', () => {
  const start=at=>({kind:'native.compacting',at});const end=at=>({kind:'native.session.compacted',at});
  assert.deepEqual(findQaNativeCompactionCycle([start(100),end(205)],200),{startedAt:100,completedAt:205});
  for(const events of [[end(110),start(190)],[start(100),end(150)],[start(210),end(220)],[start(100),end(5300)],
    [start(100),start(210),end(220)],[]]) assert.equal(findQaNativeCompactionCycle(events,200),null);
});


test('Plan capture binds the exact request and cannot fall back to an older or unrelated saved card', () => {
  const user = { info: { id: 'msg_revision2', sessionID: 'ses_root', role: 'user' },
    parts: [{ type: 'text', synthetic: true, text: 'User has requested to enter plan mode.' }] };
  const assistant = (id, parentID, text) => ({ info: { id, parentID, sessionID: 'ses_root', role: 'assistant',
    time: { created: 10, completed: 20 }, finish: 'stop' }, parts: [{ type: 'text', text: '<!--plan-->\n' + text }] });
  const older = assistant('msg_old', 'msg_revision1', '# Old plan');
  const current = assistant('msg_plan2', user.info.id, '# Revised plan');
  const latest = assistant('msg_audit', 'msg_audit_request', '# Operational audit');
  const options = { sessionID: 'ses_root', userMessageID: user.info.id };
  assert.equal(requireQaCompactionPlanSource([older, user, current, latest], options), current);
  assert.equal(requireQaCompactionPlanSource([older, user, current, latest], { ...options, content: '# Revised plan' }), current);
  assert.throws(() => requireQaCompactionPlanSource([older, user, latest], options), /no completed Plan source/);
  assert.throws(() => requireQaCompactionPlanSource([older, user, current], { ...options, content: '# Old plan' }), /differs from its exact canonical/);
  for (const mutate of [
    source => { source.info.sessionID = 'ses_other'; },
    source => { source.info.summary = true; },
    source => { source.info.error = { name: 'APIError' }; },
    source => { delete source.info.time.completed; },
    source => { source.info.finish = 'tool-calls'; },
    source => { source.parts[0].text = '# Ordinary response'; },
    source => { source.parts[0].text += '\n<!--plan-->\n# Another plan'; },
  ]) {
    const changed = structuredClone(current); mutate(changed);
    assert.throws(() => requireQaCompactionPlanSource([older, user, changed, latest], options));
  }
});
