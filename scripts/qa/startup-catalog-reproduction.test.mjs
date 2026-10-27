import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticCursorProvider, syntheticAnthropicProvider } from './startup-catalog-reproduction.mjs';

test('Anthropic overlay preserves only credential presence and uses a loopback fixture', () => {
  assert.deepEqual(syntheticAnthropicProvider({ provider: { anthropic: { options: { apiKey: 'private', baseURL: 'https://private.invalid' } } } }),
    { anthropic: { options: { baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' } } });
  assert.deepEqual(syntheticAnthropicProvider({ provider: { anthropic: { options: {} } } }), { anthropic: { options: { baseURL: 'http://127.0.0.1:1' } } });
  assert.deepEqual(syntheticAnthropicProvider({}), {});
});

test('provider shape fixture preserves model and cost structure while excluding user data', () => {
  const source = { agent: { builder: { prompt: 'private prompt' } }, provider: { 'cursor-acp': {
    name: 'private name', options: { apiKey: 'secret', baseURL: 'https://private.invalid' },
    models: { 'gpt-5.5-fast': { name: 'private model label', cost: { input: 5, output: 30,
      context_over_200k: { input: 10, output: 45 } }, options: { cursorModel: 'gpt-5.5-high', apiKey: 'secret' },
      variants: { medium: { cursorModel: 'gpt-5.5-medium', cost: { input: 5, cache_read: 0.5 }, token: 'secret' } },
      prompt: 'private prompt' } } } } };
  const result = syntheticCursorProvider(source);
  const model = result['cursor-acp'].models['gpt-5.5-fast'];
  assert.deepEqual(model.cost, source.provider['cursor-acp'].models['gpt-5.5-fast'].cost);
  assert.deepEqual(model.options, { cursorModel: 'gpt-5.5-high' });
  assert.deepEqual(model.variants.medium, { cursorModel: 'gpt-5.5-medium', cost: { input: 5, cache_read: 0.5 } });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result['cursor-acp'].options.baseURL, 'http://127.0.0.1:1/v1');
  assert.throws(() => syntheticCursorProvider({ provider: { 'cursor-acp': { models: { 'invalid value': {} } } } }));
});
