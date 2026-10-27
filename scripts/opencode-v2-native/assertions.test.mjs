import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCancelledNativeState, assertTerminatedBeforeOutcome, toolTurn, parallelWriterTurn, managedTaskTurn, backgroundShellTurn } from './assertions.mjs';

test('native cancellation requires its own later interrupted idle and released runner claim', () => {
  const state = { assistantID: 'assistant', assistantSequence: 10, assistantCompleted: 1000,
    assistantError: 'aborted', toolError: 'aborted', idleID: 'idle', idleSequence: 11,
    idleOutcome: 'interrupted', sessionOutcome: 'interrupted', timeSuspended: null, resumeAttempts: 0 };
  assertCancelledNativeState(state);
  for (const changed of [{ idleSequence: 9 }, { idleOutcome: 'succeeded' }, { sessionOutcome: 'succeeded' },
    { timeSuspended: 100 }, { resumeAttempts: 1 }, { assistantCompleted: null }, { toolError: null }]) {
    assert.throws(() => assertCancelledNativeState({ ...state, ...changed }));
  }
});

test('publication cannot precede real confined termination evidence', () => {
  const termination = { callID: 'call', phase: 'termination_verified', receipt: { terminated: true, confined: true } };
  const publication = { callID: 'call', phase: 'published' };
  assertTerminatedBeforeOutcome([termination, publication], 'call', 'published');
  assert.throws(() => assertTerminatedBeforeOutcome([publication, termination], 'call', 'published'), /preceded/);
  assert.throws(() => assertTerminatedBeforeOutcome([{ ...termination, receipt: { terminated: true, confined: false } }, publication], 'call', 'published'));
});

test('scripted turn requires real native registry and exact provider continuation', () => {
  const turn = toolTurn('write', { path: 'fixture', content: 'x' }, 'one');
  const call = turn.responder({ body: { messages: [{ role: 'user', content: turn.marker }], tools: [{ function: { name: 'write' } }] } });
  assert.equal(call.items[0].id, turn.callID);
  assert.throws(turn.complete, /did not settle/);
  assert.throws(() => turn.responder({ body: { messages: [{ role: 'tool', tool_call_id: 'other', content: 'fake' }] } }), /exact result/);
  turn.responder({ body: { messages: [{ role: 'tool', tool_call_id: turn.callID, content: 'native-result' }] } });
  assert.equal(turn.complete(), 'native-result');
});

test('parallel continuation requires every one of the eight exact results', () => {
  const turn = parallelWriterTurn('parallel');
  turn.responder({ body: { messages: [{ role: 'user', content: turn.marker }], tools: [{ function: { name: 'write' } }] } });
  const results = turn.calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'native-result' }));
  assert.throws(() => turn.responder({ body: { messages: results.slice(0, 7) } }), /omitted/);
  turn.responder({ body: { messages: results.reverse() } }); turn.complete();
});

test('denied turn requires a filtered native catalog before adversarial invocation', () => {
  const turn = toolTurn('write', { path: 'forbidden', content: 'x' }, 'denied', { deniedInventory: true });
  const user = { role: 'user', content: turn.marker };
  assert.throws(() => turn.responder({ body: { messages: [user], tools: [{ function: { name: 'write' } }] } }), /still exposed/);
  assert.equal(turn.responder({ body: { messages: [user], tools: [{ function: { name: 'read' } }] } }).items[0].name, 'write');
  assert.throws(turn.complete, /did not settle/);
  turn.responder({ body: { messages: [{ role: 'tool', tool_call_id: turn.callID, content: 'Unknown tool: write' }] } });
  assert.equal(turn.complete(), 'Unknown tool: write');
});

test('managed driver waits for product task identity and actual child before parent completion', () => {
  const turn = managedTaskTurn('managed', 'builder');
  const tools = ['write', 'devryan_task'].map(name => ({ function: { name } }));
  const root = { role: 'user', content: turn.marker };
  const first = turn.responder({ body: { messages: [root], tools } });
  assert.equal(first.items[0].input.action, 'start');
  assert.equal(first.items[0].id, turn.callIDs.startID);
  const started = { role: 'tool', tool_call_id: turn.callIDs.startID, content: JSON.stringify({ task: { taskId: 'product-task', status: 'running' } }) };
  const wait = turn.responder({ body: { messages: [root, started], tools } });
  assert.equal(wait.items[0].input.task_id, 'product-task');
  const done = { role: 'tool', tool_call_id: turn.callIDs.waitID, content: JSON.stringify({ task: { taskId: 'product-task', status: 'completed' } }) };
  assert.throws(() => turn.responder({ body: { messages: [root, started, done], tools } }), /before actual/);
  const write = turn.responder({ body: { messages: [{ role: 'user', content: turn.childMarker }], tools } });
  assert.equal(write.items[0].name, 'write');
  assert.throws(turn.complete, /incomplete/);
  turn.responder({ body: { messages: [{ role: 'tool', tool_call_id: turn.callIDs.writerID, content: 'native write receipt' }], tools } });
  turn.responder({ body: { messages: [root, started, done], tools } });
  assert.equal(turn.complete().taskID, 'product-task');
});

test('background driver requires its exact native shell completion notification', () => {
  const turn = backgroundShellTurn('background', { command: 'fixture command' });
  const tools = [{ function: { name: 'shell' } }];
  const user = { role: 'user', content: turn.marker };
  turn.responder({ body: { messages: [user], tools } });
  const result = { role: 'tool', tool_call_id: 'native_background', content: 'Command moved to the background (shell ID: actual-shell).' };
  const first = turn.responder({ body: { messages: [user, result], tools } });
  assert.equal(first.items[0].text, 'background launched background');
  assert.throws(turn.complete, /owned completion wake/);
  assert.throws(() => turn.responder({ body: { messages: [user, result, { role: 'user', content: '<shell id="wrong-shell" state="completed">done</shell>' }], tools } }), /completion identity missing/);
  turn.responder({ body: { messages: [user, result, { role: 'user', content: [{ type: 'text', text: '<shell id="actual-shell" state="completed">done</shell>' }] }], tools } });
  assert.equal(turn.complete().shellID, 'actual-shell');
});
