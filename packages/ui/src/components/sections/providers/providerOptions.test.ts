import { describe, expect, test } from 'bun:test';

import { parseProvidersPayload } from './providerOptions';

describe('provider options', () => {
  test('adds GitHub Copilot to available providers when the API omits it', () => {
    const providers = parseProvidersPayload({
      providers: [
        { id: 'openai', name: 'OpenAI' },
      ],
    });

    expect(providers.some((provider) => (
      provider.id === 'github-copilot' && provider.name === 'GitHub Copilot'
    ))).toBe(true);
  });

  test('normalizes legacy Copilot provider aliases to GitHub Copilot', () => {
    const providers = parseProvidersPayload({
      providers: [
        { id: 'copilot', name: 'Copilot' },
      ],
    });

    expect(providers.some((provider) => provider.id === 'copilot')).toBe(false);
    expect(providers.filter((provider) => provider.id === 'github-copilot')).toHaveLength(1);
  });
});
