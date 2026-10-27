import { describe, expect, test } from 'bun:test';
import { getProviderModelsForDisplay } from './providerSorting';

describe('getProviderModelsForDisplay', () => {
  test('returns provider models alphabetically by display name without mutating input', () => {
    const models = [
      { id: 'gpt-4o-mini', name: 'gpt-4o mini' },
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'gpt-4o', name: 'GPT-4o' },
    ];

    const sorted = getProviderModelsForDisplay({ models });

    expect(sorted.map((model) => model.id)).toEqual([
      'claude-3-5-sonnet',
      'gpt-4o',
      'gpt-4o-mini',
    ]);
    expect(models.map((model) => model.id)).toEqual([
      'gpt-4o-mini',
      'claude-3-5-sonnet',
      'gpt-4o',
    ]);
  });

  test('returns an empty list when the provider has no model array', () => {
    expect(getProviderModelsForDisplay({})).toEqual([]);
  });

  test('hides paired fast model rows for any provider', () => {
    const sorted = getProviderModelsForDisplay({
      id: 'anthropic',
      models: [
        { id: 'claude-sonnet-4-fast', name: 'Claude Sonnet 4 Fast' },
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      ],
    }, { hidePairedFastModels: true });

    expect(sorted.map((model) => model.id)).toEqual([
      'claude-sonnet-4',
    ]);
  });

  test('keeps unpaired fast model rows visible', () => {
    const sorted = getProviderModelsForDisplay({
      id: 'anthropic',
      models: [
        { id: 'claude-sonnet-4-fast', name: 'Claude Sonnet 4 Fast' },
        { id: 'claude-opus-4', name: 'Claude Opus 4' },
      ],
    }, { hidePairedFastModels: true });

    expect(sorted.map((model) => model.id)).toEqual([
      'claude-opus-4',
      'claude-sonnet-4-fast',
    ]);
  });

  test('hides paired Cursor fast rows when requested', () => {
    const sorted = getProviderModelsForDisplay({
      id: 'cursor-acp',
      models: [
        { id: 'composer-2-fast', name: 'Composer 2 Fast' },
        { id: 'claude-sonnet-4-fast', name: 'Claude Sonnet 4 Fast' },
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      ],
    }, { hidePairedFastModels: true });

    expect(sorted.map((model) => model.id)).toEqual([
      'claude-sonnet-4',
      'composer-2-fast',
    ]);
  });

  test('hides unavailable models only when asked', () => {
    const models = [
      { id: 'a', name: 'A', available: false },
      { id: 'b', name: 'B', available: true },
      { id: 'c', name: 'C' },
    ];
    expect(getProviderModelsForDisplay({ models }).map((model) => model.id)).toEqual(['a', 'b', 'c']);
    expect(getProviderModelsForDisplay({ models }, { hideUnavailable: true }).map((model) => model.id)).toEqual(['b', 'c']);
  });
});
