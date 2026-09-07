import { describe, expect, it } from 'vitest';
import { annotateModelDefaultThinking, resolveModelDefaultThinking } from './model-default-thinking.js';

const model = (overrides = {}) => ({
  id: 'gpt-5.5', api: { id: 'gpt-5.5', npm: '@ai-sdk/openai' },
  options: {}, variants: { low: {}, medium: {}, high: {} }, ...overrides,
});

describe('effective default thinking metadata', () => {
  it('labels the verified OpenCode GPT-5 default without changing request options', () => {
    const original = model();
    const payload = { providers: [{ id: 'openai', models: { 'gpt-5.5': original } }], default: { openai: 'gpt-5.5' } };
    const result = annotateModelDefaultThinking(payload);
    expect(result.providers[0].models['gpt-5.5'].defaultThinkingLevel).toBe('medium');
    expect(result.providers[0].models['gpt-5.5'].options).toBe(original.options);
    expect(result.default).toBe(payload.default);
    expect(original).not.toHaveProperty('defaultThinkingLevel');
    expect(annotateModelDefaultThinking(result)).toBe(result);
  });

  it('honors configured adapter options and explicit provider metadata', () => {
    expect(resolveModelDefaultThinking({}, model({ options: { reasoningEffort: 'high' } }))).toBe('high');
    expect(resolveModelDefaultThinking({}, model({ defaultThinkingLevel: 'low' }))).toBe('low');
    expect(resolveModelDefaultThinking({}, model({ options: { reasoningEffort: 'unknown' } }))).toBeUndefined();
    expect(resolveModelDefaultThinking({}, model({ options: { reasoningEffort: null } }))).toBeUndefined();
  });

  it('does not infer defaults from variant order, unknown adapters, or a model name alone', () => {
    expect(resolveModelDefaultThinking({}, model({ api: { id: 'custom', npm: '@ai-sdk/openai' } }))).toBeUndefined();
    expect(resolveModelDefaultThinking({}, model({ api: { id: 'gpt-5.5', npm: 'custom-sdk' } }))).toBeUndefined();
    expect(resolveModelDefaultThinking({}, model({ variants: { low: {}, high: {} } }))).toBeUndefined();
    expect(resolveModelDefaultThinking({}, model({ api: { id: 'gpt-5-pro', npm: '@ai-sdk/openai' } }))).toBeUndefined();
    expect(resolveModelDefaultThinking({}, model({ api: { id: 'gpt-5-chat-latest', npm: '@ai-sdk/openai' } }))).toBeUndefined();
  });

  it('preserves the Azure completions exception', () => {
    expect(resolveModelDefaultThinking({ options: { useCompletionUrls: true } }, model({ api: { id: 'gpt-5.5', npm: '@ai-sdk/azure' } }))).toBeUndefined();
  });

  it('uses the Gemini runtime default and configuration override', () => {
    const gemini = model({ api: { id: 'gemini-3-pro', npm: '@ai-sdk/google' }, capabilities: { reasoning: true } });
    expect(resolveModelDefaultThinking({}, gemini)).toBe('high');
    expect(resolveModelDefaultThinking({}, { ...gemini, options: { thinkingConfig: { thinkingLevel: 'low' } } })).toBe('low');
  });

  it('does not guess a Meridian SDK/profile default from the raw Claude API', () => {
    const claude = model({ api: { id: 'claude-opus-4-8', npm: '@ai-sdk/anthropic', url: 'http://127.0.0.1:3456' } });
    expect(resolveModelDefaultThinking({}, claude)).toBeUndefined();
    expect(resolveModelDefaultThinking({}, { ...claude, options: { effort: 'high' } })).toBe('high');
  });

  it('preserves references for catalogs it cannot enrich', () => {
    const payload = { providers: [{ id: 'custom', models: { custom: { id: 'custom' } } }] };
    expect(annotateModelDefaultThinking(payload)).toBe(payload);
  });
});
