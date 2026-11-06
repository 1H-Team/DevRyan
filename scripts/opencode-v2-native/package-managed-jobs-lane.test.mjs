import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectedManagedJobTurn } from './package-managed-jobs-lane.mjs';

test('a completed managed fixture collects the exact envelope from a later tool Step before its parent ends', () => {
  const turn = createCollectedManagedJobTurn('collected-job-unit');
  const request = messages => ({ body: { messages, tools: [{ function: { name: 'devryan_task' } }, { function: { name: 'write' } }] } });
  const user = { role: 'user', content: turn.marker };
  const task = { taskId: 'dvr_task_fixture', rootSessionId: 'ses_root', childSessionId: 'ses_child', directory: '/owned/project', status: 'completed' };
  const tool = (id, value) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(value) });
  assert.equal(turn.responder(request([user])).items[0].input.action, 'start');
  const started = tool(turn.callIDs.startID, { task: { ...task, status: 'running' } });
  assert.equal(turn.responder(request([user, started])).items[0].input.action, 'wait');
  turn.responder(request([{ role: 'user', content: turn.childMarker }]));
  turn.responder(request([tool(turn.callIDs.writerID, { content: 'Original child writer result' })]));
  const envelope = { ...task, owner: 'devryan', envelopeId: 'dvr_result_fixture', action: null, acknowledgedAt: null, followUpTaskId: null };
  const waited = tool(turn.callIDs.waitID, { task, resultEnvelope: envelope, resultReference: { complete: true } });
  const continued = turn.responder(request([user, started, waited]));
  assert.equal(continued.items[0].input.action, 'continue'); assert.equal(continued.items[0].input.task_id, task.taskId);
  assert.throws(() => turn.complete(), /not collected/);
  const response = { committed: true, taskId: task.taskId, envelopeId: envelope.envelopeId, action: 'continue' };
  for (const field of ['envelopeId', 'taskId']) {
    const changed = { ...response, [field]: 'foreign' };
    assert.throws(() => turn.responder(request([user, started, waited, tool(continued.items[0].id, changed)])), /Managed collection changed/);
  }
  for (const changed of [{ ...response, committed: false }, { ...response, action: 'abandon' },
    { ...response, projectionError: 'native_task_post_commit_fenced' }, { resultEnvelope: { ...envelope, action: 'continue', acknowledgedAt: 123 } }]) {
    assert.throws(() => turn.responder(request([user, started, waited, tool(continued.items[0].id, changed)])));
  }
  const final = turn.responder(request([user, started, waited, tool(continued.items[0].id, response)]));
  assert.deepEqual(final, { items: [{ type: 'textDelta', text: 'completed collected-job-unit' }], reason: 'stop' });
  assert.equal(turn.complete().taskID, task.taskId);
  assert.deepEqual(turn.complete().collectionReceipt, response); assert.deepEqual(turn.complete().collectedEnvelope, envelope);
  assert.throws(() => turn.responder(request([user, started, waited, tool(continued.items[0].id, response)])), /repeated/);
});

test('a confined managed child runs one held shell, never continues after it and accepts only its exact stopped result', async () => {
  const { createConfinedChildTurn } = await import('./package-managed-jobs-lane.mjs');
  const { MANAGED_RECOVERY_INSTRUCTIONS } = await import('../../packages/orchestration-runtime/managed-recovery-instruction.js');
  for (const mode of ['cancel', 'restart']) {
    const caseID = `confined-unit-${mode}`, turn = createConfinedChildTurn(caseID, mode), status = mode === 'cancel' ? 'aborted' : 'interrupted';
    const tools = [{ function: { name: 'devryan_task' } }, { function: { name: 'shell' } }];
    const request = (messages, available = tools) => ({ body: { messages, tools: available } });
    const user = { role: 'user', content: turn.marker }, child = { role: 'user', content: `${turn.childMarker} Run the held confined shell, then report.` };
    const tool = (id, value) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(value) });
    assert.throws(() => turn.responder(request([{ role: 'user', content: 'unrelated' }])), /Unrelated/);
    const start = turn.responder(request([user])).items[0];
    assert.deepEqual([start.id, start.input.action, start.input.agent], [turn.callIDs.startID, 'start', 'fixer']);
    assert.ok(start.input.prompt.includes(turn.childMarker));
    const task = { taskId: 'dvr_task_fixture', rootSessionId: 'ses_root', childSessionId: 'ses_child', directory: '/owned/project', status: 'running' };
    const started = tool(turn.callIDs.startID, { task });
    assert.deepEqual(turn.responder(request([user, started])).items[0].input, { action: 'wait', task_id: task.taskId });
    assert.throws(() => turn.responder(request([child], [{ function: { name: 'devryan_task' } }])), /native shell missing/);
    const shell = turn.responder(request([child])).items[0];
    assert.deepEqual([shell.id, shell.name, shell.input.timeout], [turn.callIDs.shellID, 'shell', 600_000]);
    assert.ok(shell.input.command.includes(`> ${turn.files.ready}`) && shell.input.command.includes(`>> ${turn.files.growth}`) && shell.input.command.endsWith('; wait'));
    assert.throws(() => turn.responder(request([child])), /replayed/);
    assert.throws(() => turn.responder(request([child, tool(turn.callIDs.shellID, { output: '' })])), /continued after its shell/);
    const stopped = { ...task, status, ...(mode === 'cancel' ? { stoppedRecoveryAvailable: true } : {}) };
    const envelope = { owner: 'devryan', envelopeId: 'dvr_result_fixture', ...stopped, action: null, acknowledgedAt: null };
    const result = { task: stopped, resultEnvelope: envelope, ...(mode === 'cancel' ? { instruction: MANAGED_RECOVERY_INSTRUCTIONS.manual } : {}) };
    assert.throws(() => turn.responder(request([user, started, tool(turn.callIDs.waitID, { ...result, task: { ...stopped, status: 'running' } })])), /before the confined child settled/);
    assert.throws(() => turn.responder(request([user, started, tool(turn.callIDs.waitID, { ...result, resultEnvelope: { ...envelope, childSessionId: 'ses_other' } })])), /changed childSessionId/);
    assert.throws(() => turn.responder(request([user, started, tool(turn.callIDs.waitID, { ...result, resultEnvelope: { ...envelope, action: 'abandon' } })])));
    if (mode === 'cancel') assert.throws(() => turn.responder(request([user, started, tool(turn.callIDs.waitID, { ...result, instruction: 'resume' })])));
    assert.deepEqual(turn.responder(request([user, started, tool(turn.callIDs.waitID, result)])),
      { items: [{ type: 'textDelta', text: `observed ${status} ${caseID}` }], reason: 'stop' });
    assert.throws(() => turn.responder(request([user, started, tool(turn.callIDs.waitID, result)])), /repeated/);
    // Refused replays still count, so a lane sees every repeated request.
    assert.deepEqual(turn.inspect(), { taskID: task.taskId, childRequests: 2, waitResults: 2 });
  }
  assert.throws(() => createConfinedChildTurn('confined-unit', 'deadline'));
});
