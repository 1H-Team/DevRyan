import assert from 'node:assert/strict';
import test from 'node:test';
import { gradePrefixRequests, withoutCacheMarkers } from './meridian-prefix.mjs';

const expected = [0, 1].map(step => ({ step, id: `tool-${step}`, content: `Actual result ${step}` }));
const user = content => ({ role: 'user', content });
const assistant = id => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: {} }] });
const result = value => user([{ type: 'tool_result', tool_use_id: value.id, content: value.content }]);
const request = (step, messages) => ({ primary: true, step, body: {
  system: [{ type: 'text', text: 'Stable instructions' }], tools: [{ name: 'read', input_schema: {} }], messages,
} });
const history = () => {
  const initial = user('Read and edit the fixture');
  return [request(0, [initial]), request(1, [initial, assistant('tool-0'), result(expected[0])]),
    request(2, [initial, assistant('tool-0'), result(expected[0]), assistant('tool-1'), result(expected[1])])];
};

test('prefix evidence accepts append-only tool results and ordinary cache marker movement', () => {
  const requests = history();
  requests[1].body.messages[2].content[0].cache_control = { type: 'ephemeral' };
  requests[2].body.messages[4].content[0].cache_control = { type: 'ephemeral' };
  assert.equal(gradePrefixRequests(requests, expected).passed, true);
});

test('prefix evidence detects a real result reverting to a denial on a later resume', () => {
  const requests = history();
  requests[2].body.messages[2].content[0] = { type: 'tool_result', tool_use_id: 'tool-0', content: 'Forwarded to client', is_error: true };
  const grade = gradePrefixRequests(requests, expected);
  assert.equal(grade.passed, false);
  assert.equal(grade.checks[2].previousMessagesStable, false);
  assert.deepEqual(grade.checks[2].missingResults, ['tool-0']);
});

test('prefix evidence distinguishes changed instructions, tool schemas, and missing history', () => {
  const requests = history();
  requests[1].body.system = [{ type: 'text', text: 'Changed Git snapshot' }];
  requests[2].body.tools[0].input_schema = { type: 'object' };
  requests[2].body.messages = [user('History was replayed as text')];
  const grade = gradePrefixRequests(requests, expected);
  assert.equal(grade.passed, false);
  assert.equal(grade.checks[1].systemStable, false);
  assert.equal(grade.checks[2].toolsStable, false);
  assert.equal(grade.checks[2].previousMessagesStable, false);
  assert.deepEqual(grade.checks[2].missingResults, ['tool-0', 'tool-1']);
});

test('hidden provider requests are counted separately from client requests', () => {
  const requests = history();
  requests.splice(1, 0, { ...requests[0], primary: false });
  const grade = gradePrefixRequests(requests, expected);
  assert.equal(grade.passed, true);
  assert.equal(grade.providerRequests, 4);
  assert.equal(grade.clientRequests, 3);
  assert.equal(grade.hiddenRequests, 1);
  assert.deepEqual(withoutCacheMarkers({ text: 'cache_control', content: { cache_control: {}, text: 'kept' } }),
    { text: 'cache_control', content: { text: 'kept' } });
});
