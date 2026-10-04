import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundRestartTurn } from './background-restart-turn.mjs';

test('restart driver holds only the exact existing notice before any completion chunk', async () => {
  const turn = backgroundRestartTurn('restart', { command: 'fixture' });
  const user = { role: 'user', content: turn.marker };
  const tools = [{ function: { name: 'shell' } }];
  const first = await turn.responder({ body: { messages: [user], tools } });
  assert.equal(first.items[0].name, 'shell');
  const result = { role: 'tool', tool_call_id: 'native_restart', content: 'Command moved to the background (shell ID: owned-shell).' };
  await turn.responder({ body: { messages: [user, result], tools } });
  assert.throws(turn.complete, /has not completed/);
  const notice = { role: 'user', content: '<shell id="owned-shell" state="completed">done</shell>' };
  let returned = false;
  void turn.responder({ body: { messages: [user, result, notice], tools } }).then(() => { returned = true; });
  await new Promise(setImmediate);
  assert.equal(returned, false); assert.deepEqual(turn.holding(), { held: true, shellID: 'owned-shell' });
  const resumed = backgroundRestartTurn('restart', undefined, { resumeShellID: 'owned-shell' });
  await assert.rejects(resumed.responder({ body: { messages: [user, result], tools } }), /canonical completed shell notice/);
  const completed = await resumed.responder({ body: { messages: [user, result, notice], tools } });
  assert.deepEqual(completed.items, [{ type: 'textDelta', text: 'completed restart' }]);
  assert.deepEqual(resumed.complete(), { shellID: 'owned-shell' });
  await assert.rejects(resumed.responder({ body: { messages: [user, result, notice], tools } }), /replayed/);
});
