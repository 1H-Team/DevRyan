import { describe, expect, test } from 'bun:test';
import {
  resolveAvailableProviderModel,
  getProviderModelUnavailability,
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
    })).toBe('This model is unavailable with Sign in with ChatGPT. Connect OpenAI with an API key to use it.');
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

test('distinguishes unknown account models, denied plan usage and legacy reconnect without inferring API entitlement', () => {
  expect(getProviderModelUnavailableMessage({ available: false, unavailableReason: 'account_models_unavailable' })).toBe('ChatGPT account models could not be loaded. Retry before choosing a model.');
  expect(getProviderModelUnavailableMessage({ available: false, unavailableReason: 'plan_usage_disabled' })).toBe('You are signed in, but ChatGPT plan usage is disabled. Authorize plan usage or explicitly choose API-key authentication in Providers.');
  expect(getProviderModelUnavailableMessage({ available: false, unavailableReason: 'reauthorization_required' })).toBe('Reconnect with Sign in with ChatGPT in Providers to use ChatGPT plan usage.');
});

test('marks only account lookup failures as retryable', () => {
  expect(getProviderModelUnavailability({ available: false, unavailableReason: 'account_models_unavailable' })).toEqual({
    message: 'ChatGPT account models could not be loaded. Retry before choosing a model.',
    retryable: true,
  });
  expect(getProviderModelUnavailability({ available: false, unavailableReason: 'reauthorization_required' })?.retryable).toBe(false);
  expect(getProviderModelUnavailability({ id: 'gpt-5.6' })).toBeUndefined();
});
