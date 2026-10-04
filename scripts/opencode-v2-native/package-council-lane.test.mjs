import test from 'node:test';
import assert from 'node:assert/strict';
import { compiledCouncilMembers, createCompiledCouncilResponder } from './package-council-lane.mjs';
import { attachReviewedSetup } from './reviewed-setup.mjs';
const members = compiledCouncilMembers.map(member => ({ providerId: 'devryan-smoke',
  modelId: member.model.split('/')[1], variant: member.variant }));
const childText = ['You are one councillor in a multi-model council.',
  'Answer independently and concisely. Do not ask follow-up questions.',
  'State assumptions and uncertainty when needed.', '',
  '[devryan-council-local-qualification] Compare two isolated local designs.'].join('\n');
const child = model => ({ body: { model, messages: [{ role: 'user', content: childText }] } });

test('local seat responses are independent and parent continuation retains its original responder', () => {
  const parents = [], responder = createCompiledCouncilResponder(request => { parents.push(request); return 'parent'; }, members);
  const parent = { body: { model: 'smoke-write', messages: [{ role: 'user', content: '[devryan-native-case:compiled-ordered-council]' }] } };
  assert.equal(responder.responder(parent), 'parent');
  assert.equal(responder.responder(child('gpt-5-native-smoke')).items[0].text, 'Local seat two independently prefers design B.');
  assert.equal(responder.responder(child('smoke-write')).items[0].text, 'Local seat one independently prefers design A.');
  assert.deepEqual(responder.requests, [1, 1]); assert.deepEqual(parents, [parent]);
  assert.throws(() => responder.responder(child('smoke-write')), /repeated a physical member request/);
});

test('undeclared model and reordered fixture tuple cannot produce a diagnostic seat response', () => {
  assert.throws(() => createCompiledCouncilResponder(() => {}, members.toReversed()));
  const responder = createCompiledCouncilResponder(() => {}, members);
  assert.throws(() => responder.responder(child('unreviewed')), /undeclared diagnostic model/);
  assert.deepEqual(responder.requests, [0, 0]);
});

test('optional Council fixture input refuses arbitrary saved graph replacement', () => {
  const configuration = { providers: { 'devryan-smoke': { models: {
    'smoke-write': { limit: {} }, 'gpt-5-native-smoke': { limit: {} },
  } } } };
  const bundle = { reviewedConfiguration: { resolveSlimAgents: () => {}, ponytailCommands: { ponytail: { template: 'Original bytes' } } } };
  assert.throws(() => attachReviewedSetup({ bundle, binding: {}, registrationBytes: Buffer.from('[]'), configuration,
    councilMembers: [{ model: 'unreviewed/model' }] }), /Only declared local Council/);
  assert.doesNotThrow(() => attachReviewedSetup({ bundle, binding: {}, registrationBytes: Buffer.from('[]'), configuration,
    councilMembers: compiledCouncilMembers }));
  assert.equal(configuration.providers['devryan-smoke'].models['smoke-write'].limit.context, undefined);
});

const councilResult = () => ({
  disposition: 'unacknowledged', results: ['dvr_task_one', 'dvr_task_two'].map((taskId, index) => ({
    taskId, resultEnvelope: { envelopeId: `dvr_result_${index}`, taskId,
      rootSessionId: 'ses_root', directory: '/fixture', status: 'completed', action: null },
  })),
});
const toolResult = (id, value) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(value) });
const parentRequest = tools => ({ body: { messages: [{ role: 'user', content: 'Parent input' }, ...tools] } });

test('Council collects each task through policy-supported native waits before durable continuation', () => {
  let parentCalls = 0;
  const final = { items: [{ type: 'textDelta', text: 'completed compiled-ordered-council' }], reason: 'stop' };
  const responder = createCompiledCouncilResponder(() => { parentCalls++; return final; }, members);
  const council = councilResult();
  const tools = [toolResult('native_compiled-ordered-council', council)];
  let response = responder.responder(parentRequest(tools));
  for (const row of council.results) {
    assert.deepEqual(response.items[0].input, { action: 'wait', task_id: row.taskId });
    tools.push(toolResult(response.items[0].id, { task: { taskId: row.taskId, status: 'completed' }, resultEnvelope: row.resultEnvelope }));
    response = responder.responder(parentRequest(tools));
    assert.deepEqual(response.items[0].input, { action: 'continue', task_id: row.taskId });
    tools.push(toolResult(response.items[0].id, { resultEnvelope: { ...row.resultEnvelope, action: 'continue', acknowledgedAt: 123 } }));
    response = responder.responder(parentRequest(tools));
  }
  assert.equal(response, final); assert.equal(parentCalls, 1);
  assert.equal(responder.dispositionCallIDs.length, 4);
});

test('failed collection or foreign acknowledgement cannot advance Council completion', () => {
  for (const failure of ['harness_policy_disabled', { resultEnvelope: { ...councilResult().results[0].resultEnvelope, taskId: 'dvr_task_foreign' } }]) {
    const responder = createCompiledCouncilResponder(() => ({ reason: 'stop' }), members);
    const tools = [toolResult('native_compiled-ordered-council', councilResult())];
    const wait = responder.responder(parentRequest(tools));
    tools.push(typeof failure === 'string' ? { role: 'tool', tool_call_id: wait.items[0].id, content: failure }
      : toolResult(wait.items[0].id, failure));
    assert.throws(() => responder.responder(parentRequest(tools)));
  }
});

test('uncommitted continue response cannot advance to the next seat', () => {
  const responder = createCompiledCouncilResponder(() => ({ reason: 'stop' }), members);
  const council = councilResult(), row = council.results[0];
  const tools = [toolResult('native_compiled-ordered-council', council)];
  const wait = responder.responder(parentRequest(tools));
  tools.push(toolResult(wait.items[0].id, { task: { taskId: row.taskId, status: 'completed' }, resultEnvelope: row.resultEnvelope }));
  const continuation = responder.responder(parentRequest(tools));
  tools.push(toolResult(continuation.items[0].id, { resultEnvelope: row.resultEnvelope }));
  assert.throws(() => responder.responder(parentRequest(tools)), /acknowledgement did not commit/);
});
