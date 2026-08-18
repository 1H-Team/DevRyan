import { describe, expect, test } from 'bun:test';

import { getProviderDisplayName, isAnthropicOAuthProviderId } from './display';

describe('provider display branding', () => {
  test('presents every Anthropic-compatible provider id as Claude', () => {
    for (const id of ['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude']) {
      expect(isAnthropicOAuthProviderId(id)).toBe(true);
      expect(getProviderDisplayName({ id, name: 'Anthropic' })).toBe('Claude');
    }
  });

  test('preserves unrelated provider display names', () => {
    expect(getProviderDisplayName({ id: 'openai', name: 'OpenAI' })).toBe('OpenAI');
  });
});
