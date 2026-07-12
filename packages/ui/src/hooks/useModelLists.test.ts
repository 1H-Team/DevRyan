import { describe, expect, test } from 'bun:test';

import {
  buildFavoriteModelsList,
  getNextFavoriteModelRef,
  type ModelRef,
  type ProviderWithModelList,
} from './useModelLists';

const providers = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', available: false },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet', name: 'Claude Sonnet' },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    models: [
      { id: 'cursor-base', name: 'Cursor Base', variants: { fast: {} } },
      { id: 'cursor-base-fast', name: 'Cursor Base Fast' },
    ],
  },
] as unknown as ProviderWithModelList[];

describe('buildFavoriteModelsList', () => {
  test('skips raw favorites that are unavailable, hidden, or paired fast models', () => {
    const favorites: ModelRef[] = [
      { providerID: 'missing-provider', modelID: 'missing-model' },
      { providerID: 'openai', modelID: 'missing-model' },
      { providerID: 'openai', modelID: 'gpt-5' },
      { providerID: 'openai', modelID: 'gpt-5-mini' },
      { providerID: 'openai', modelID: 'gpt-5.6-luna' },
      { providerID: 'cursor', modelID: 'cursor-base-fast' },
      { providerID: 'anthropic', modelID: 'claude-sonnet' },
    ];

    expect(buildFavoriteModelsList({
      favoriteModels: favorites,
      hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5-mini' }],
      providers,
    }).map(({ providerID, modelID }) => ({ providerID, modelID }))).toEqual([
      { providerID: 'openai', modelID: 'gpt-5' },
      { providerID: 'anthropic', modelID: 'claude-sonnet' },
    ]);
  });
});

describe('getNextFavoriteModelRef', () => {
  const visibleFavorites: ModelRef[] = [
    { providerID: 'openai', modelID: 'gpt-5' },
    { providerID: 'anthropic', modelID: 'claude-sonnet' },
    { providerID: 'openai', modelID: 'gpt-5-mini' },
  ];

  test('cycles forward through only visible favorites', () => {
    expect(getNextFavoriteModelRef({
      favoriteModels: visibleFavorites,
      currentProviderId: 'openai',
      currentModelId: 'gpt-5',
      direction: 1,
    })).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet' });
  });

  test('cycles backward through only visible favorites', () => {
    expect(getNextFavoriteModelRef({
      favoriteModels: visibleFavorites,
      currentProviderId: 'openai',
      currentModelId: 'gpt-5',
      direction: -1,
    })).toEqual({ providerID: 'openai', modelID: 'gpt-5-mini' });
  });

  test('selects first or last visible favorite when current model is not visible', () => {
    expect(getNextFavoriteModelRef({
      favoriteModels: visibleFavorites,
      currentProviderId: 'missing',
      currentModelId: 'missing',
      direction: 1,
    })).toEqual({ providerID: 'openai', modelID: 'gpt-5' });

    expect(getNextFavoriteModelRef({
      favoriteModels: visibleFavorites,
      currentProviderId: 'missing',
      currentModelId: 'missing',
      direction: -1,
    })).toEqual({ providerID: 'openai', modelID: 'gpt-5-mini' });
  });

  test('returns null when there are no visible favorites', () => {
    expect(getNextFavoriteModelRef({
      favoriteModels: [],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5',
      direction: 1,
    })).toBeNull();
  });
});
