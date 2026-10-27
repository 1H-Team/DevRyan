import { describe, expect, test } from 'bun:test';

import { mergeProviderConnectionOptions, parseProvidersPayload } from './providerOptions';

describe('provider options', () => {
  test('offers advertised authentication when the account-backed catalog has no models', () => {
    const payload = { all: [], connected: [] };
    const catalog = parseProvidersPayload(payload);
    const options = mergeProviderConnectionOptions(catalog, {
      openai: [{ type: 'api' }, { type: 'oauth' }],
      xai: [{ type: 'oauth' }],
      'opencode-go': [{ type: 'api' }],
      absent: [],
      unsupported: [{ type: 'unknown' }],
      malformed: [{}],
    });

    expect(options.map((provider) => provider.id)).toEqual([
      'anthropic', 'cursor-acp', 'github-copilot', 'openai', 'xai', 'opencode-go',
    ]);
    expect(options.slice(0, catalog.length)).toEqual(catalog);
    expect(options[0]).toBe(catalog[0]);
    expect(payload).toEqual({ all: [], connected: [] });
    expect(catalog).toHaveLength(3);
    expect(options.every((option) => Object.keys(option).every((key) => key === 'id' || key === 'name'))).toBe(true);
  });

  test('preserves catalog labels and references when authentication repeats providers', () => {
    const catalog = parseProvidersPayload({ all: [
      { id: 'openai', name: 'OpenAI' },
      { id: 'anthropic', name: 'Anthropic' },
    ] });
    expect(mergeProviderConnectionOptions(catalog, {
      openai: [{ type: 'oauth' }],
      anthropic: [{ type: 'api' }],
      copilot: [{ type: 'oauth' }],
      'cursor-acp': [{ type: 'api' }],
    })).toBe(catalog);
    expect(catalog[0].name).toBe('OpenAI');
    expect(catalog[1].name).toBe('Claude');
  });

  test('presents Anthropic-compatible provider options as Claude', () => {
    const providers = parseProvidersPayload({
      providers: [{ id: 'anthropic', name: 'Anthropic' }],
    });

    expect(providers.find((provider) => provider.id === 'anthropic')?.name).toBe('Claude');
  });

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
