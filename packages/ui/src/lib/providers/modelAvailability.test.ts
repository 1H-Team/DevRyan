import { describe, expect, test } from 'bun:test';
import {
  resolveAvailableProviderModel,
  getProviderModelUnavailableMessage,
  isProviderModelAvailable,
} from './modelAvailability';

describe('provider model availability', () => {
  test('treats explicitly unavailable models as non-selectable', () => {
    expect(isProviderModelAvailable({ id: 'gpt-5.6-luna', available: false })).toBe(false);
    expect(isProviderModelAvailable({ id: 'gpt-5.6' })).toBe(true);
  });

  test('explains the API-key requirement for OAuth-incompatible models', () => {
    expect(getProviderModelUnavailableMessage({
      id: 'gpt-5.6-luna',
      available: false,
      unavailableReason: 'auth_type_unsupported',
      requiredAuthType: 'api',
    })).toBe('This model is unavailable with ChatGPT/Codex OAuth. Connect OpenAI with an API key to use it.');
  });

  test('falls back within the preferred provider before using another provider', () => {
    const providers = [
      {
        id: 'openai',
        models: [
          { id: 'gpt-5.6', available: false },
          { id: 'gpt-5.6-sol' },
        ],
      },
      {
        id: 'anthropic',
        models: [{ id: 'claude' }],
      },
    ];

    expect(resolveAvailableProviderModel(providers, 'openai', 'gpt-5.6')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
    });
    expect(resolveAvailableProviderModel(providers, 'missing', 'missing')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
    });
  });
});
