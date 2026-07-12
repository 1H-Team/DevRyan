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

  test('hides Google-backed Antigravity models by display provider id', () => {
    const filtered = filterHiddenProviderModels([
      {
        id: 'google',
        name: 'Google',
        models: [
          { id: 'gemini-3-pro', providerID: 'google', name: 'Gemini 3 Pro' },
          { id: 'antigravity-claude-sonnet-4-6', providerID: 'google', name: 'Claude Sonnet 4.6 (Antigravity)' },
        ],
      },
    ], [
      { providerID: 'antigravity', modelID: 'antigravity-claude-sonnet-4-6' },
    ]);

    expect(filtered.map((provider) => ({
      id: provider.id,
      models: provider.models.map((model) => model.id),
    }))).toEqual([
      { id: 'google', models: ['gemini-3-pro'] },
    ]);
  });

  test('detects hidden Google-backed Antigravity models by display provider id', () => {
    expect(isHiddenProviderModelRef([
      { providerID: 'antigravity', modelID: 'antigravity-claude-sonnet-4-6' },
    ], 'google', {
      id: 'antigravity-claude-sonnet-4-6',
      providerID: 'google',
      name: 'Claude Sonnet 4.6 (Antigravity)',
    })).toBe(true);
  });

  test('detects hidden Google-backed Antigravity models by legacy execution provider id', () => {
    expect(isHiddenProviderModelRef([
      { providerID: 'google', modelID: 'antigravity-claude-sonnet-4-6' },
    ], 'antigravity', {
      id: 'antigravity-claude-sonnet-4-6',
      providerID: 'google',
      name: 'Claude Sonnet 4.6',
    })).toBe(true);
  });

  test('returns canonical display ref and execution aliases for split provider models', () => {
    expect(getHiddenModelRefsForProviderModel('antigravity', {
      id: 'antigravity-claude-sonnet-4-6',
      providerID: 'google',
      name: 'Claude Sonnet 4.6',
    })).toEqual({
      canonical: { providerID: 'antigravity', modelID: 'antigravity-claude-sonnet-4-6' },
      aliases: [
        { providerID: 'antigravity', modelID: 'antigravity-claude-sonnet-4-6' },
        { providerID: 'google', modelID: 'antigravity-claude-sonnet-4-6' },
      ],
    });
  });

  test('builds picker providers by splitting Antigravity before hidden filtering', () => {
    const filtered = filterVisibleProviderModelsForPicker([
      {
        id: 'google',
        name: 'Google',
        models: [
          { id: 'gemini-3-pro', providerID: 'google', name: 'Gemini 3 Pro' },
          { id: 'antigravity-claude-sonnet-4-6', providerID: 'google', name: 'Claude Sonnet 4.6 (Antigravity)' },
          { id: 'antigravity-gemini-3-pro', providerID: 'google', name: 'Gemini 3 Pro (Antigravity)' },
        ],
      },
    ], [
      { providerID: 'antigravity', modelID: 'antigravity-claude-sonnet-4-6' },
      { providerID: 'antigravity', modelID: 'antigravity-gemini-3-pro' },
    ]);

    expect(filtered.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => model.id),
    }))).toEqual([
      { id: 'google', name: 'Google', models: ['gemini-3-pro'] },
    ]);
  });

  test('filters display-split picker models hidden by legacy execution provider id', () => {
    const filtered = filterVisibleProviderModelsForPicker([
      {
        id: 'google',
        name: 'Google',
        models: [
          { id: 'gemini-3-pro', providerID: 'google', name: 'Gemini 3 Pro' },
          { id: 'antigravity-claude-sonnet-4-6', providerID: 'google', name: 'Claude Sonnet 4.6 (Antigravity)' },
        ],
      },
    ], [
      { providerID: 'google', modelID: 'antigravity-claude-sonnet-4-6' },
    ]);

    expect(filtered.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => model.id),
    }))).toEqual([
      { id: 'google', name: 'Google', models: ['gemini-3-pro'] },
    ]);
  });
});
