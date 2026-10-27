import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundQueueResponder } from './package-human-queue-lane.mjs';

test('background queue responder uses the actual start result, holds the child and never emits a parent wait', async () => {
  let release, entered = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = createBackgroundQueueResponder({ caseID: 'queue-unit', holdChild: () => gate, onChild: () => { entered++; } });
  const request = messages => ({ body: { model: 'smoke-write', messages, tools: [{ function: { name: 'devryan_task' } }, { function: { name: 'write' } }] } });
  const user = { role: 'user', content: fixture.marker };
  const start = await fixture.responder(request([user]));
  assert.equal(start.items[0].name, 'devryan_task'); assert.equal(start.items[0].input.action, 'start');
  const realResult = { role: 'tool', tool_call_id: fixture.callIDs.startID, content: JSON.stringify({ task: { taskId: 'dvr_task_fixture' } }) };
  const parent = await fixture.responder(request([user, realResult]));
  assert.equal(parent.items[0].type, 'textDelta'); assert.equal(parent.reason, 'stop');
  assert.equal(fixture.inspect().taskID, 'dvr_task_fixture');
  let answered = false;
  const child = fixture.responder(request([{ role: 'user', content: fixture.childMarker },
    { role: 'user', content: 'Native location presentation context' }])).then(reply => { answered = true; return reply; });
  await Promise.resolve(); assert.equal(entered, 1); assert.equal(answered, false);
  release(); const writer = await child;
  assert.equal(writer.items[0].id, fixture.callIDs.writerID); assert.equal(writer.items[0].name, 'write');
  const final = await fixture.responder(request([{ role: 'user', content: fixture.childMarker },
    { role: 'tool', tool_call_id: fixture.callIDs.writerID, content: 'Actual writer output' }]));
  assert.equal(final.reason, 'stop');
  const queued = request([user, realResult, { role: 'user', content: fixture.queueMarker }]);
  assert.equal((await fixture.responder(queued)).items[0].type, 'textDelta');
  await assert.rejects(fixture.responder(queued), /inferred more than once/);
  assert.equal(fixture.inspect().parentReplies, 1);
});
