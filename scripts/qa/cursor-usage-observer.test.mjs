import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeCursorSdk } from './cursor-usage-observer.mjs';

test('observer preserves native arguments, duplicate tools, results, and private-class receivers', async () => {
  const rows = []; const events = []; const calls = [];
  const usage = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 40, cacheWriteTokens: 0 };
  const result = { status: 'finished', usage };
  const run = { id: 'run', agentId: 'agent', requestId: 'request', wait: async () => result };
  class NativeAgent {
    #value = 'native';
    agentId = 'agent';
    get marker() { return this.#value; }
    close() { return this.#value; }
    async send(message, options) {
      calls.push({ message, model: options.model });
      options.onDelta({ type: 'tool-call-started', callId: 'call', toolCall: { name: 'read', args: { path: 'fixture.ts' } } });
      options.onDelta({ type: 'tool-call-started', callId: 'call', toolCall: { name: 'read', args: { path: 'fixture.ts' } } });
      return run;
    }
  }
  const native = new NativeAgent();
  const sdk = observeCursorSdk({ Agent: { create: async () => native, resume: async () => native }, Cursor: {} }, row => rows.push(row));
  const agent = await sdk.Agent.create({ apiKey: 'secret', model: { id: 'fixture' } });
  assert.equal(agent.marker, 'native'); assert.equal(agent.close(), 'native');
  assert.equal(await sdk.Agent.resume('agent', {}), agent);
  const model = { id: 'fixture', params: [{ id: 'effort', value: 'high' }] };
  const message = { text: 'fixture-only text' };
  assert.equal(await agent.send(message, { model, onDelta: event => events.push(event) }), run);
  await Promise.resolve();
  assert.equal(calls[0].message, message); assert.equal(calls[0].model, model); assert.equal(events.length, 2);
  assert.equal(rows.filter(row => row.kind === 'tool-started').length, 1);
  assert.equal(rows.filter(row => row.kind === 'run-ended').length, 1);
  assert.ok(!JSON.stringify(rows).includes('secret')); assert.ok(!JSON.stringify(rows).includes('fixture-only text'));
});

test('one-shot title inference is observed without changing options or hiding failure', async () => {
  const rows = [];
  const result = { id: 'title-run', status: 'finished', result: 'Private source title',
    usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  const options = { apiKey: 'private-key', model: { id: 'auto' }, local: { settingSources: [] } };
  const sdk = observeCursorSdk({ Agent: { prompt: async (message, actual) => {
    assert.equal(actual, options);
    if (message === 'fail') throw new Error('private error content');
    return result;
  } } }, row => rows.push(row));
  assert.equal(await sdk.Agent.prompt('private source', options), result);
  await assert.rejects(sdk.Agent.prompt('fail', options), /private error content/);
  assert.equal(rows.filter(row => row.kind === 'one-shot-started').length, 2);
  assert.equal(rows.filter(row => row.kind === 'one-shot-ended').length, 2);
  assert.equal(rows.find(row => row.runID === 'title-run').tokens.totalTokens, 16);
  assert.ok(!JSON.stringify(rows).includes('private'));
});
