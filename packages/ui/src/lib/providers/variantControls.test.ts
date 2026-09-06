import { describe, expect, test } from 'bun:test';

import {
  getModelVariantDisplayState,
  getModelVariantControlState,
  getOrderedThinkingVariants,
  resolveProviderModelVariant,
  resolveModelVariantSelection,
  resolveThinkingVariant,
  shouldHidePairedFastModel,
} from './variantControls';

describe('provider variant controls', () => {
  test('orders concrete thinking variants without inventing a default option', () => {
    expect(getOrderedThinkingVariants({
      high: {},
      low: {},
      custom: {},
      aaa: {},
      none: {},
      xhigh: {},
      max: {},
      ultra: {},
      medium: {},
      minimal: {},
    })).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'aaa', 'custom']);
  });

  test('keeps OpenAI Extra High and Ultra as separate advertised wire values', () => {
    const provider = {
      id: 'openai',
      models: [
        { id: 'gpt-5.6', variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {}, ultra: {} } },
        { id: 'gpt-5.5', variants: { low: {}, medium: {}, high: {}, xhigh: {} } },
      ],
    };

    expect(getModelVariantControlState(provider, 'gpt-5.6', 'xhigh')?.visibleVariantOptions)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(resolveModelVariantSelection(provider, 'gpt-5.6', 'xhigh', { variant: 'ultra' }))
      .toEqual({ modelId: 'gpt-5.6', variant: 'ultra' });
    expect(resolveModelVariantSelection(provider, 'gpt-5.6', 'ultra', { variant: 'xhigh' }))
      .toEqual({ modelId: 'gpt-5.6', variant: 'xhigh' });
    expect(getModelVariantControlState(provider, 'gpt-5.5', 'xhigh')?.visibleVariantOptions)
      .toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  test('leaves missing thinking at provider default and rejects unknown variants', () => {
    expect(resolveThinkingVariant(undefined, ['low', 'medium', 'high'])).toBeUndefined();
    expect(resolveThinkingVariant(null, ['low', 'medium', 'high'])).toBeUndefined();
    expect(resolveThinkingVariant(undefined, ['low', 'high'])).toBeUndefined();
    expect(resolveThinkingVariant('stale', ['low', 'medium'])).toBeUndefined();
  });

  test('keeps none visible only when provider metadata advertises it', () => {
    expect(getOrderedThinkingVariants({ low: {}, medium: {} })).toEqual(['low', 'medium']);
    expect(getOrderedThinkingVariants({ none: {}, low: {}, medium: {} })).toEqual(['none', 'low', 'medium']);
  });

  test('removes none from OpenAI thinking variants while preserving other providers', () => {
    const variants = { none: {}, low: {}, medium: {}, high: {} };

    expect(getOrderedThinkingVariants(variants, { providerId: ' OpenAI ' }))
      .toEqual(['low', 'medium', 'high']);
    expect(getOrderedThinkingVariants(variants, { providerId: 'custom' }))
      .toEqual(['none', 'low', 'medium', 'high']);
  });

  test('migrates stale OpenAI none selections to Light', () => {
    const provider = {
      id: 'openai',
      models: [{ id: 'gpt-5.6-luna', variants: { none: {}, low: {}, medium: {}, high: {} } }],
    };

    const state = getModelVariantControlState(provider, 'gpt-5.6-luna', 'none');
    expect(state?.selectedVariant).toBe('low');
    expect(state?.visibleVariantOptions).toEqual(['low', 'medium', 'high']);
    expect(resolveProviderModelVariant(provider, 'gpt-5.6-luna', 'none')).toBe('low');
  });

  test('never returns OpenAI none when a malformed catalog has no Light variant', () => {
    const provider = {
      id: 'openai',
      models: [{ id: 'gpt-5.6-custom', variants: { none: {}, high: {} } }],
    };

    const state = getModelVariantControlState(provider, 'gpt-5.6-custom', 'none');
    expect(state?.selectedVariant).toBe('high');
    expect(state?.visibleVariantOptions).toEqual(['high']);
    expect(resolveProviderModelVariant(provider, 'gpt-5.6-custom', 'none')).toBe('high');
  });

  test('derives a fast toggle from an explicit paired fast model and preserves thinking when possible', () => {
    const provider = {
      id: 'openai',
      models: [
        { id: 'gpt-5.4', variants: { low: {}, medium: {}, high: {} } },
        { id: 'gpt-5.4-fast', variants: { low: {}, medium: {} } },
      ],
    };

    const state = getModelVariantControlState(provider, 'gpt-5.4', undefined);

    expect(state?.visibleVariantOptions).toEqual(['low', 'medium', 'high']);
    expect(state?.selectedVariant).toBeUndefined();
    expect(state?.canToggleFast).toBe(true);
    expect(state?.fastEnabled).toBe(false);
    expect(resolveModelVariantSelection(provider, 'gpt-5.4', 'medium', { fastEnabled: true })).toEqual({
      modelId: 'gpt-5.4-fast',
      variant: 'medium',
    });
    expect(getModelVariantDisplayState(provider, 'gpt-5.4-fast', 'medium')).toEqual({
      displayModelId: 'gpt-5.4',
      fastEnabled: true,
      selectedVariant: 'medium',
      visibleVariantOptions: ['low', 'medium'],
    });
  });

  test('preserves the advertised GPT-5.6 reasoning levels across paired Fast rows', () => {
    const provider = {
      id: 'openai',
      models: [
        { id: 'gpt-5.6-sol', variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {}, ultra: {} } },
        { id: 'gpt-5.6-sol-fast', variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {}, ultra: {} } },
        { id: 'gpt-5.6-luna', variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} } },
        { id: 'gpt-5.6-luna-fast', variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} } },
      ],
    };

    expect(resolveModelVariantSelection(provider, 'gpt-5.6-sol', 'max', { fastEnabled: true })).toEqual({
      modelId: 'gpt-5.6-sol-fast',
      variant: 'max',
    });
    expect(resolveModelVariantSelection(provider, 'gpt-5.6-sol-fast', 'ultra', { fastEnabled: false })).toEqual({
      modelId: 'gpt-5.6-sol',
      variant: 'ultra',
    });
    expect(getModelVariantControlState(provider, 'gpt-5.6-luna', 'max')?.visibleVariantOptions).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(resolveModelVariantSelection(provider, 'gpt-5.6-luna', 'max', { fastEnabled: true })).toEqual({
      modelId: 'gpt-5.6-luna-fast',
      variant: 'max',
    });
    expect(resolveModelVariantSelection(provider, 'gpt-5.6-luna-fast', 'max', { fastEnabled: false })).toEqual({
      modelId: 'gpt-5.6-luna',
      variant: 'max',
    });
  });

  test('does not treat mini or nano model families as a fast toggle', () => {
    const provider = {
      id: 'openai',
      models: [
        { id: 'gpt-5.4-mini', variants: { low: {}, medium: {} } },
        { id: 'gpt-5.4-nano', variants: { low: {} } },
      ],
    };

    const state = getModelVariantControlState(provider, 'gpt-5.4-mini', undefined);

    expect(state?.canToggleFast).toBe(false);
    expect(state?.fastModelId).toBe(undefined);
  });

  test('does not derive an implicit fast toggle for regular OpenAI GPT models without advertised variants', () => {
    const provider = {
      id: 'openai',
      models: [
        { id: 'gpt-5.5' },
      ],
    };

    const state = getModelVariantControlState(provider, 'gpt-5.5', undefined);

    expect(state).toBeNull();
    expect(resolveModelVariantSelection(provider, 'gpt-5.5', undefined, { fastEnabled: true })).toEqual({
      modelId: 'gpt-5.5',
      variant: undefined,
    });
    expect(resolveModelVariantSelection(provider, 'gpt-5.5', 'fast', { fastEnabled: false })).toEqual({
      modelId: 'gpt-5.5',
      variant: 'fast',
    });
    expect(resolveProviderModelVariant(provider, 'gpt-5.5', 'fast')).toBe(undefined);
  });

  test('does not derive implicit OpenAI fast toggles for mini or nano model families', () => {
    const provider = {
      id: 'openai',
      models: [
        { id: 'gpt-5.5-mini' },
        { id: 'gpt-5.5-nano' },
      ],
    };

    expect(getModelVariantControlState(provider, 'gpt-5.5-mini', undefined)).toBeNull();
    expect(getModelVariantControlState(provider, 'gpt-5.5-nano', undefined)).toBeNull();
    expect(resolveProviderModelVariant(provider, 'gpt-5.5-mini', 'fast')).toBe(undefined);
    expect(resolveProviderModelVariant(provider, 'gpt-5.5-nano', 'fast')).toBe(undefined);
  });

  test('treats a real fast variant as a toggle instead of a thinking level', () => {
    const provider = {
      id: 'custom',
      models: [
        { id: 'agent-model', variants: { low: {}, medium: {}, fast: {} } },
      ],
    };

    const state = getModelVariantControlState(provider, 'agent-model', 'fast');

    expect(state?.visibleVariantOptions).toEqual(['low', 'medium']);
    expect(state?.selectedVariant).toBeUndefined();
    expect(state?.fastEnabled).toBe(true);
    expect(getModelVariantDisplayState(provider, 'agent-model', 'fast')).toEqual({
      displayModelId: 'agent-model',
      fastEnabled: true,
      selectedVariant: undefined,
      visibleVariantOptions: ['low', 'medium'],
    });
    expect(resolveModelVariantSelection(provider, 'agent-model', 'medium', { fastEnabled: true })).toEqual({
      modelId: 'agent-model',
      variant: 'fast',
    });
    expect(resolveProviderModelVariant(provider, 'agent-model', 'fast')).toBe('fast');
  });

  test('drops stale fast variants for paired fast models because fast is represented by model id', () => {
    const provider = {
      id: 'custom',
      models: [
        { id: 'agent-model', variants: { low: {}, medium: {} } },
        { id: 'agent-model-fast', variants: { low: {}, medium: {} } },
      ],
    };

    expect(resolveModelVariantSelection(provider, 'agent-model', 'medium', { fastEnabled: true })).toEqual({
      modelId: 'agent-model-fast',
      variant: 'medium',
    });
    expect(resolveProviderModelVariant(provider, 'agent-model', 'fast')).toBeUndefined();
    expect(resolveProviderModelVariant(provider, 'agent-model-fast', 'fast')).toBeUndefined();
  });

  test('hides paired fast models only when the base model exists', () => {
    const provider = {
      id: 'custom',
      models: [
        { id: 'agent-model', variants: { low: {}, medium: {} } },
        { id: 'agent-model-fast', variants: { low: {}, medium: {} } },
        { id: 'standalone-fast', variants: { low: {}, medium: {} } },
      ],
    };

    expect(shouldHidePairedFastModel(provider, 'agent-model-fast')).toBe(true);
    expect(shouldHidePairedFastModel(provider, 'agent-model')).toBe(false);
    expect(shouldHidePairedFastModel(provider, 'standalone-fast')).toBe(false);
  });

  test('drops unsupported fast variants for providers without fast metadata', () => {
    const provider = {
      id: 'anthropic',
      models: [
        { id: 'claude-sonnet-4-5' },
      ],
    };

    expect(resolveProviderModelVariant(provider, 'claude-sonnet-4-5', 'fast')).toBe(undefined);
  });
});
