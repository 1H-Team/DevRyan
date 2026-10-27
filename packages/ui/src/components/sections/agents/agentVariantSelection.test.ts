import { describe, expect, test } from 'bun:test';

import {
  resolveAgentVariantForModel,
  resolveAgentVariantForSave,
  resolveAgentVariantSelection,
  getAgentVariantSelectionError,
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

  test('preserves provider default or an explicit unlisted saved thinking variant', () => {
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
    )).toBeUndefined();
    expect(resolveAgentVariantForModel(
      provider,
      'opencode/deepseek-v4-flash-free',
      'stale',
    )).toBe('stale');
  });

  test('normalizes selected thinking variants by provider metadata on save', () => {
    const provider = {
      id: 'opencode',
      models: [
        { id: 'deepseek-v4-flash-free', variants: { low: {}, medium: {}, high: {} } },
      ],
    };

    expect(resolveAgentVariantForSave(provider, 'opencode/deepseek-v4-flash-free', 'HIGH')).toBe('high');
    expect(() => resolveAgentVariantForSave(provider, 'opencode/deepseek-v4-flash-free', 'stale')).toThrow('Choose a supported thinking level before saving');
  });

  test('requires catalog confirmation even when the selected effort is provider default', () => {
    expect(getAgentVariantSelectionError(undefined, 'example/model', undefined)).toContain('Refresh the model catalog');
    expect(() => resolveAgentVariantForSave({ id: 'example', models: [] }, 'example/model', 'high')).toThrow('Model availability');
  });

  test('model changes retain unsupported intent until the user explicitly selects a replacement', () => {
    const provider = { id: 'example', models: [
      { id: 'source', variants: { high: {} } },
      { id: 'target', variants: { medium: {} } },
    ] };
    const retained = resolveAgentVariantForModel(provider, 'example/target', 'high');
    expect(retained).toBe('high');
    expect(getAgentVariantSelectionError(provider, 'example/target', retained)).toContain('unavailable');
    expect(resolveAgentVariantForSave(provider, 'example/target', 'medium')).toBe('medium');
    expect(resolveAgentVariantForSave(provider, 'example/target', undefined)).toBeUndefined();
  });

  test('fast model changes do not silently discard unsupported effort', () => {
    const provider = { id: 'example', models: [
      { id: 'model', variants: { high: {} } },
      { id: 'model-fast', variants: { medium: {} } },
    ] };
    expect(resolveAgentVariantSelection(provider, 'example/model', 'high', { fastEnabled: true }))
      .toEqual({ modelRef: 'example/model-fast', variant: 'high' });
  });

  test('does not reinterpret a saved invalid OpenAI none as another effort', () => {
    const provider = { id: 'openai', models: [{ id: 'model', variants: { low: {}, high: {} } }] };
    expect(resolveAgentVariantForModel(provider, 'openai/model', 'none')).toBe('none');
    expect(() => resolveAgentVariantForSave(provider, 'openai/model', 'none')).toThrow('unavailable');
  });

  test('an explicit fast variant toggle still replaces the thinking variant', () => {
    const provider = { id: 'example', models: [{ id: 'model', variants: { high: {}, fast: {} } }] };
    expect(resolveAgentVariantSelection(provider, 'example/model', 'high', { fastEnabled: true }))
      .toEqual({ modelRef: 'example/model', variant: 'fast' });
  });

  test('a persisted default sentinel displays and saves as provider default', () => {
    const provider = { id: 'example', models: [{ id: 'model', variants: { high: {} } }] };
    expect(resolveAgentVariantForModel(provider, 'example/model', 'default')).toBeUndefined();
    expect(resolveAgentVariantForSave(provider, 'example/model', 'default')).toBeUndefined();
    expect(getAgentVariantSelectionError(provider, 'example/model', 'default')).toBeUndefined();
  });

  test('a model without thinking levels drops a saved level instead of rejecting it', () => {
    const provider = { id: 'opencode', models: [{ id: 'nemotron-3.5-lightning-free', variants: {} }, { id: 'no-variants' }] };
    for (const modelRef of ['opencode/nemotron-3.5-lightning-free', 'opencode/no-variants']) {
      expect(resolveAgentVariantForModel(provider, modelRef, 'medium')).toBeUndefined();
      expect(getAgentVariantSelectionError(provider, modelRef, 'medium')).toBeUndefined();
      expect(resolveAgentVariantForSave(provider, modelRef, 'medium')).toBeUndefined();
    }
  });

  test('a model explicitly marked unavailable cannot be saved', () => {
    const provider = { id: 'example', models: [{ id: 'model', available: false }] };
    expect(getAgentVariantSelectionError(provider, 'example/model', undefined)).toContain('Model availability');
  });
});
