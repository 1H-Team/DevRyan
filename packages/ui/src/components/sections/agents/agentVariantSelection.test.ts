import { describe, expect, test } from 'bun:test';

import {
  resolveAgentVariantForModel,
  resolveAgentVariantForSave,
  resolveAgentVariantSelection,
} from './agentVariantSelection';

describe('agent Settings variant selection', () => {
  test('toggles paired fast models by changing the saved model ref', () => {
    const provider = {
      id: 'cursor-acp',
      models: [
        { id: 'composer-2.5', name: 'Composer 2.5' },
        { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
      ],
    };

    expect(resolveAgentVariantSelection(
      provider,
      'cursor-acp/composer-2.5',
      undefined,
      { fastEnabled: true },
    )).toEqual({
      modelRef: 'cursor-acp/composer-2.5-fast',
      variant: undefined,
    });

    expect(resolveAgentVariantSelection(
      provider,
      'cursor-acp/composer-2.5-fast',
      undefined,
      { fastEnabled: false },
    )).toEqual({
      modelRef: 'cursor-acp/composer-2.5',
      variant: undefined,
    });
  });

  test('keeps an unset variant empty instead of inventing a thinking level on save', () => {
    const provider = {
      id: 'opencode',
      models: [
        { id: 'deepseek-v4-flash-free', variants: { low: {}, medium: {}, high: {} } },
      ],
    };

    expect(resolveAgentVariantForSave(provider, 'opencode/deepseek-v4-flash-free', undefined)).toBe(undefined);
  });

  test('seeds the model fallback when an agent has no saved thinking variant', () => {
    const provider = {
      id: 'opencode',
      models: [
        { id: 'deepseek-v4-flash-free', variants: { low: {}, medium: {}, high: {} } },
      ],
    };

    expect(resolveAgentVariantForModel(
      provider,
      'opencode/deepseek-v4-flash-free',
      undefined,
    )).toBe('medium');
    expect(resolveAgentVariantForModel(
      provider,
      'opencode/deepseek-v4-flash-free',
      'stale',
    )).toBe('medium');
  });

  test('normalizes selected thinking variants by provider metadata on save', () => {
    const provider = {
      id: 'opencode',
      models: [
        { id: 'deepseek-v4-flash-free', variants: { low: {}, medium: {}, high: {} } },
      ],
    };

    expect(resolveAgentVariantForSave(provider, 'opencode/deepseek-v4-flash-free', 'HIGH')).toBe('high');
    expect(resolveAgentVariantForSave(provider, 'opencode/deepseek-v4-flash-free', 'stale')).toBe(undefined);
  });
});
