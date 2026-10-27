import assert from 'node:assert/strict';
import test from 'node:test';
import { configureManagedModelAdmission, createInvalidManagedModelTurn } from './package-managed-model-admission-lane.mjs';
import { createHttpProviderConfiguration } from './http-provider.mjs';

test('compiled admission fixture keeps the genuine Explorer role and exact supported catalog variants', () => {
  const config = createHttpProviderConfiguration('http://127.0.0.1:12345/v1');
  configureManagedModelAdmission(config, 'medium');
  assert.deepEqual(config.agents.explorer, { mode: 'subagent', model: 'devryan-smoke/smoke-write', variant: 'medium' });
  assert.deepEqual(config.providers['devryan-smoke'].models['smoke-write'].variants.map(row => row.id), ['low', 'high', 'max']);
  assert.throws(() => configureManagedModelAdmission(config, 'high'));
});

test('invalid arm requires the actual actionable tool error and refuses child inference or redispatch', () => {
  const turn = createInvalidManagedModelTurn('test');
  const request = messages => ({ body: { messages, tools: [{ function: { name: 'devryan_task' } }] } });
  const start = request([{ role: 'user', content: turn.marker }]);
  assert.equal(turn.responder(start).items[0].input.agent, 'explorer');
  assert.throws(() => turn.responder(request([{ role: 'user', content: 'unexpected child' }])));
  assert.throws(() => turn.responder(request([{ role: 'tool', tool_call_id: turn.callID, content: 'managed_agent_model_unavailable' }])));
  const error = 'explorer cannot start: medium is unsupported for Synthetic Explorer Model. Choose low, high, max or Provider default in Agents settings.';
  assert.equal(turn.responder(request([{ role: 'tool', tool_call_id: turn.callID, content: error }])).items[0].text, 'refused test');
  assert.deepEqual(turn.complete(), { observedError: error });
});
