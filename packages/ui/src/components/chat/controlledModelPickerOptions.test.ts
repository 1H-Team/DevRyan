import { describe, expect, test } from 'bun:test';

import { getControlledModelOptions } from './controlledModelPickerOptions';

describe('controlled model picker provider branding', () => {
  test('uses ChatGPT as the OpenAI provider group label without changing execution ids', () => {
    const options = getControlledModelOptions([
      {
        id: 'openai',
        name: 'OpenAI',
        models: [{ id: 'gpt-6', name: 'GPT-6' }],
      },
    ], []);

    expect(options).toHaveLength(1);
    expect(options[0]?.providerId).toBe('openai');
    expect(options[0]?.providerName).toBe('ChatGPT');
    expect(options[0]?.modelId).toBe('gpt-6');
    expect(options[0]?.provider.name).toBe('OpenAI');
  });

  test('uses Claude as the Anthropic provider group label without changing execution ids', () => {
    const options = getControlledModelOptions([
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }],
      },
    ], []);

    expect(options).toHaveLength(1);
    expect(options[0]?.providerId).toBe('anthropic');
    expect(options[0]?.providerName).toBe('Claude');
    expect(options[0]?.modelId).toBe('claude-sonnet');
  });
});
