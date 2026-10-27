import { describe, expect, test } from 'bun:test';

import { getProviderDisplayName, isAnthropicOAuthProviderId } from './display';

describe('provider display branding', () => {
  test('presents the built-in OpenAI provider as ChatGPT regardless of its supplied name', () => {
    expect(getProviderDisplayName({ id: 'openai', name: 'OpenAI' })).toBe('ChatGPT');
    expect(getProviderDisplayName({ id: 'openai' })).toBe('ChatGPT');
    expect(getProviderDisplayName({ id: 'openai', name: 'Custom label' })).toBe('ChatGPT');
  });

  test('presents every Anthropic-compatible provider id as Claude', () => {
    for (const id of ['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude']) {
      expect(isAnthropicOAuthProviderId(id)).toBe(true);
      expect(getProviderDisplayName({ id, name: 'Anthropic' })).toBe('Claude');
    }
  });

  test('preserves unrelated names and applies the OpenCode Zen label', () => {
    expect(getProviderDisplayName({ id: 'custom-openai', name: 'OpenAI' })).toBe('OpenAI');
    expect(getProviderDisplayName({ id: 'opencode', name: 'OpenCode' })).toBe('OpenCode Zen');
  });
});
