import { expect, test } from 'bun:test';
import { normalizeUsageTokens, normalizeUsageObservation, runtimeUsageObservation, estimateApiEquivalent,
  nativeClaudeUsageObservation, nativeCodexUsageObservation } from './usage-observation.js';

test('normalizes inclusive OpenAI, disjoint runtime/Anthropic, and separate xAI reasoning', () => {
  const openai = normalizeUsageTokens({ input: 10000, cacheRead: 6000, cacheWrite: 3000, output: 100, reasoning: 60 }, { input: 'inclusive', output: 'inclusive' });
  expect(openai).toMatchObject({ totalInput: 10000, uncachedInput: 1000, totalOutput: 100, output: 40, reasoning: 60 });
  expect(normalizeUsageTokens({ input: 2, cacheRead: 1000, cacheWrite: 500, output: 100 }, { input: 'uncached', output: 'inclusive' }))
    .toMatchObject({ totalInput: 1502, totalOutput: 100, output: null, reasoning: null });
  expect(normalizeUsageTokens({ input: 32, output: 9, reasoning: 94 }, { input: 'inclusive', output: 'exclusive' }))
    .toMatchObject({ totalInput: 32, totalOutput: 103, output: 9, reasoning: 94, cacheRead: null });
});
test('never coerces unknown, malformed or contradictory counts to zero', () => {
  expect(normalizeUsageTokens({ input: '12', cacheRead: -1, output: NaN })).toMatchObject({ totalInput: null, cacheRead: null, output: null });
  expect(normalizeUsageTokens({ input: 10, cacheRead: 11, cacheWrite: 0 }, { input: 'inclusive' }).uncachedInput).toBeNull();
  expect(normalizeUsageTokens({ input: 10, cacheRead: 1 }, { input: 'uncached' }).totalInput).toBeNull();
});
test('runtime identity cannot masquerade as response identity, unknown lifetime stays unknown', () => {
  const row = runtimeUsageObservation({ type: 'open_code_event', at: 100, payload: { type: 'message.updated', properties: { info: {
    id: 'm1', role: 'assistant', sessionID: 's1', modelID: 'opus-5', time: { completed: 99 }, tokens: { input: 2, cache: { read: 4, write: 5 } },
  } } } });
  expect(row).toMatchObject({ source: 'message_aggregate', requestedModel: 'opus-5', responseModel: null,
    tokens: { cacheWrite: 5, cacheWrite1h: null }, timing: { dispatch: { at: null }, completion: { at: 99, origin: 'runtime' } } });
  expect(normalizeUsageObservation({ source: 'provider_request', observationID: 'a1', prompt: 'private', raw: { input: 10 }, semantics: { input: 'inclusive' } })).not.toHaveProperty('prompt');
});
test('requires explicit prices and write lifetime for API-equivalent estimates', () => {
  const tokens = normalizeUsageTokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5 }, { input: 'uncached', output: 'exclusive' });
  const prices = { currency: 'USD', input: 1, cacheRead: 0.1, output: 2, reasoning: 2, cacheWrite1h: 2 };
  expect(estimateApiEquivalent(tokens, prices)).toBeNull();
  expect(estimateApiEquivalent({ ...tokens, cacheWrite1h: 3, cacheWrite5m: 0, cacheWrite30m: 0 }, prices))
    .toMatchObject({ amount: 0.0000252, provenance: 'api_price_equivalent' });
});
test('native evidence retains actual Claude identity/lifetime and leaves ambiguous Codex writes unknown', () => {
  const row = nativeClaudeUsageObservation({ id: 'response1', model: 'claude-opus-4-8', usage: {
    input_tokens: 2, output_tokens: 7, cache_creation_input_tokens: 9617, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 9617, ephemeral_5m_input_tokens: 0 },
  } }, { requestedModel: 'claude-opus-5', totalCostUsd: 42 });
  expect(row).toMatchObject({ responseModel: 'claude-opus-4-8', requestedModel: 'claude-opus-5',
    tokens: { cacheWrite1h: 9617, totalInput: 9619, totalOutput: 7, reasoning: null }, cost: { amount: null } });
  expect(estimateApiEquivalent(row.tokens, { currency: 'USD', input: 1, cacheRead: 0.1, cacheWrite1h: 2, output: 3, reasoning: 3 })?.amount).toBeCloseTo(0.019257);
  const native = { last: { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2 } };
  expect(nativeCodexUsageObservation(native, { observationID: 'n1', requestedModel: 'sol' })).toMatchObject({ source: 'runtime_step',
    responseModel: null, tokens: { totalInput: 100, cacheRead: 80, cacheWrite: null, output: null } });
});
