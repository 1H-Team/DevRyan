import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCompiledParentDeathProbe } from './package-parent-death.mjs';

test('parent-death probe explicitly admits its canonical selected agent before acquiring a real lease', async () => {
  const calls = [], sessionID = 'ses_owned', directory = '/owned/project';
  const boundary = Error('actual_lease_boundary');
  const client = { sessions: { get: async (id, options) => {
    assert.equal(id, sessionID);assert.deepEqual(options, { directory });calls.push('selection');
    return { id, directory, agent: 'fixture-selected' };
  } }, prompts: { prompt: async (id, input, options) => {
    assert.equal(id, sessionID);assert.equal(input.agent, 'fixture-selected');
    assert.deepEqual(input.model, { providerID: 'devryan-smoke', modelID: 'smoke-write' });
    assert.equal(input.variant, 'default');assert.match(input.messageID, /^msg_[A-Za-z0-9]+$/);
    assert.deepEqual(input.parts, [{ type: 'text', text: '[devryan-native-case:compiled-parent-death]' }]);
    assert.deepEqual(options, { directory, origin: 'native_acceptance', timeoutMs: 30000 });calls.push('prompt');
  } } };
  await assert.rejects(prepareCompiledParentDeathProbe({ client, directory, sessionID,
    provider: { setResponder: async responder => { assert.equal(typeof responder, 'function');calls.push('provider'); } },
    host: { runtime: { leaseForCall: async input => {
      assert.deepEqual(input, { directory, sessionID, callID: 'native_compiled-parent-death' });calls.push('lease');throw boundary;
    } } },
  }), error => error === boundary);
  assert.deepEqual(calls, ['selection', 'provider', 'prompt', 'lease']);
});

test('parent-death probe refuses absent canonical selection before model or process effects', async () => {
  await assert.rejects(prepareCompiledParentDeathProbe({ sessionID: 'ses_owned', directory: '/owned/project',
    client: { sessions: { get: async () => ({ id: 'ses_owned', directory: '/owned/project' }) } },
    provider: { setResponder: () => assert.fail('Missing selection reached provider') },
  }), /canonical selected agent/);
});
