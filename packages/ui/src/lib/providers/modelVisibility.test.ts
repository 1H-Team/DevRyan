import { describe, expect, test } from 'bun:test';
import {
  filterHiddenProviderModels,
  filterVisibleProviderModelsForPicker,
  getHiddenModelRefsForProviderModel,
  isHiddenModelRef,
  isHiddenProviderModelRef,
  type HiddenModelRef,
} from './modelVisibility';

describe('model visibility helpers', () => {
  const hiddenModels: HiddenModelRef[] = [
    { providerID: 'anthropic', modelID: 'claude-hidden' },
  ];

  test('detects hidden model refs by provider and model id', () => {
    expect(isHiddenModelRef(hiddenModels, 'anthropic', 'claude-hidden')).toBe(true);
    expect(isHiddenModelRef(hiddenModels, 'anthropic', 'claude-visible')).toBe(false);
    expect(isHiddenModelRef(hiddenModels, 'openai', 'claude-hidden')).toBe(false);
  });

  test('does not match empty provider or model ids', () => {
    expect(isHiddenModelRef(hiddenModels, '', 'claude-hidden')).toBe(false);
    expect(isHiddenModelRef(hiddenModels, 'anthropic', '')).toBe(false);
    expect(isHiddenModelRef(hiddenModels, undefined, 'claude-hidden')).toBe(false);
    expect(isHiddenModelRef(hiddenModels, 'anthropic', undefined)).toBe(false);
  });

  test('filters only hidden models from matching providers', () => {
    const filtered = filterHiddenProviderModels([
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          { id: 'claude-visible', name: 'Claude Visible' },
          { id: 'claude-hidden', name: 'Claude Hidden' },
        ],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'claude-hidden', name: 'Different Provider Same Model ID' },
        ],
      },
    ], hiddenModels);

    expect(filtered.map((provider) => ({
      id: provider.id,
      models: provider.models.map((model) => model.id),
    }))).toEqual([
      { id: 'anthropic', models: ['claude-visible'] },
      { id: 'openai', models: ['claude-hidden'] },
    ]);
  });

  test('removes providers when all models are hidden', () => {
    const filtered = filterHiddenProviderModels([
      {
        id: 'anthropic',
        models: [{ id: 'claude-hidden', name: 'Claude Hidden' }],
      },
    ], hiddenModels);

    expect(filtered).toEqual([]);
  });

  test('applies an additional model predicate after hidden filtering', () => {
    const filtered = filterHiddenProviderModels([
      {
        id: 'anthropic',
        models: [
          { id: 'claude-visible', name: 'Claude Visible' },
          { id: 'claude-fast', name: 'Claude Fast' },
        ],
      },
    ], hiddenModels, (_provider, _model, modelID) => !modelID.endsWith('-fast'));

    expect(filtered[0]?.models.map((model) => model.id)).toEqual(['claude-visible']);
  });

  test('removes unavailable models from picker providers', () => {
    const filtered = filterVisibleProviderModelsForPicker([
      {
        id: 'openai',
        models: [
          { id: 'gpt-5.6', name: 'GPT-5.6', available: false },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
        ],
      },
    ], []);

    expect(filtered[0]?.models.map((model) => model.id)).toEqual(['gpt-5.6-sol']);
  });

  test('detects hidden models by the model execution provider id', () => {
    expect(isHiddenProviderModelRef([
      { providerID: 'google', modelID: 'gemini-3-pro' },
    ], 'custom-display', {
      id: 'gemini-3-pro',
      providerID: 'google',
      name: 'Gemini 3 Pro',
    })).toBe(true);
  });

  test('returns the requested provider ref first and the execution provider as an alias', () => {
    expect(getHiddenModelRefsForProviderModel('custom-display', {
      id: 'gemini-3-pro',
      providerID: 'google',
      name: 'Gemini 3 Pro',
    })).toEqual({
      canonical: { providerID: 'custom-display', modelID: 'gemini-3-pro' },
      aliases: [
        { providerID: 'custom-display', modelID: 'gemini-3-pro' },
        { providerID: 'google', modelID: 'gemini-3-pro' },
      ],
    });
  });

  test('keeps every Google model under Google in the picker now that Antigravity is retired', () => {
    const filtered = filterVisibleProviderModelsForPicker([
      {
        id: 'google',
        name: 'Google',
        models: [
          { id: 'gemini-3-pro', providerID: 'google', name: 'Gemini 3 Pro' },
          { id: 'antigravity-gemini-3-pro', providerID: 'google', name: 'Gemini 3 Pro (Antigravity)' },
        ],
      },
    ], [
      { providerID: 'google', modelID: 'gemini-3-pro' },
    ]);

    expect(filtered.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => model.id),
    }))).toEqual([
      { id: 'google', name: 'Google', models: ['antigravity-gemini-3-pro'] },
    ]);
  });
});
