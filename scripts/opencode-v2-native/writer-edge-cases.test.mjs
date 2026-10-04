import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameFileWriterTurn } from './writer-edge-cases.mjs';

test('same-file driver requires both exact native results before continuation', () => {
  const turn = sameFileWriterTurn('same');
  const issued = turn.responder({ body: { messages: [{ role: 'user', content: turn.marker }], tools: [{ function: { name: 'write' } }] } });
  assert.equal(issued.items.length, 2);
  assert.equal(issued.items[0].input.path, issued.items[1].input.path);
  assert.ok(issued.items.every(item => item.input.content.startsWith('\0')));
  assert.throws(turn.complete, /incomplete/);
  const results = turn.calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'actual result' }));
  assert.throws(() => turn.responder({ body: { messages: results.slice(0, 1) } }), /omitted/);
  assert.throws(() => turn.responder({ body: { messages: [results[0], results[0]] } }));
  turn.responder({ body: { messages: results } });
  assert.deepEqual(turn.complete().callIDs, turn.calls.map(call => call.id));
  assert.throws(() => turn.responder({ body: { messages: results } }), /replayed/);
});
