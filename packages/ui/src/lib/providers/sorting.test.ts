import { describe, expect, test } from 'bun:test';
import {
  sortProvidersByDisplayName,
  sortModelsByDisplayName,
  sortProviderTreeForPicker,
} from './sorting';

describe('sortProvidersByDisplayName', () => {
  test('orders providers alphabetically by the displayed name', () => {
    const providers = [
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'openai', name: 'OpenAI' },
      { id: 'github-copilot', name: 'GitHub Copilot' },
      { id: 'zen', name: 'OpenCode Zen' },
      { id: 'anthropic', name: 'Anthropic' },
    ];

    const sorted = sortProvidersByDisplayName(providers);

    expect(sorted.map((provider) => provider.name)).toEqual([
      'OpenAI',
      'Anthropic',
      'GitHub Copilot',
      'OpenCode Go',
      'OpenCode Zen',
    ]);
    expect(providers.map((provider) => provider.name)).toEqual([
      'OpenCode Go',
      'OpenAI',
      'GitHub Copilot',
      'OpenCode Zen',
      'Anthropic',
    ]);
  });

  test('names the Claude aliases Claude', () => {
    const providers = [
      { id: 'openai', name: 'OpenAI' },
      { id: 'anthropic-oauth', name: 'Anthropic OAuth' },
      { id: 'claude-agent', name: 'Claude Agent' },
    ];

    expect(sortProvidersByDisplayName(providers).map((provider) => provider.id)).toEqual(['openai', 'anthropic-oauth', 'claude-agent']);
  });

  test('is case-insensitive and tie-breaks on id for stable ordering', () => {
    const providers = [
      { id: 'b-provider', name: 'shared' },
      { id: 'a-provider', name: 'Shared' },
      { id: 'c-provider', name: 'shared' },
    ];

    const sorted = sortProvidersByDisplayName(providers);

    expect(sorted.map((provider) => provider.id)).toEqual([
      'a-provider',
      'b-provider',
      'c-provider',
    ]);
  });
});

describe('sortModelsByDisplayName', () => {
  test('orders models alphabetically by name, case-insensitive', () => {
    const models = [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'claude-3-5-sonnet', name: 'claude 3.5 sonnet' },
      { id: 'gpt-4o-mini', name: 'gpt-4o mini' },
    ];

    const sorted = sortModelsByDisplayName(models);

    expect(sorted.map((model) => model.id)).toEqual([
      'claude-3-5-sonnet',
      'gpt-4o',
      'gpt-4o-mini',
    ]);
    expect(models.map((model) => model.id)).toEqual([
      'gpt-4o',
      'claude-3-5-sonnet',
      'gpt-4o-mini',
    ]);
  });

  test('falls back to id when name is missing and tie-breaks deterministically', () => {
    const models = [
      { id: 'gamma', name: 'shared' },
      { id: 'alpha', name: 'shared' },
      { id: 'beta' },
    ];

    const sorted = sortModelsByDisplayName(models);

    expect(sorted.map((model) => model.id)).toEqual(['beta', 'alpha', 'gamma']);
  });
});

describe('sortProviderTreeForPicker', () => {
  test('sorts providers and their inner models without mutating the input', () => {
    const providers = [
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'gpt-4o-mini', name: 'gpt-4o mini' },
          { id: 'gpt-4o', name: 'GPT-4o' },
        ],
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku' },
          { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
        ],
      },
    ];

    const sorted = sortProviderTreeForPicker(providers);

    expect(sorted.map((provider) => provider.id)).toEqual(['openai', 'anthropic']);
    expect(sorted[1].models.map((model) => model.id)).toEqual([
      'claude-3-5-haiku',
      'claude-3-5-sonnet',
    ]);
    expect(sorted[0].models.map((model) => model.id)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
    expect(providers[0].id).toBe('openai');
    expect(providers[0].models[0].id).toBe('gpt-4o-mini');
  });

  test('handles providers without a models array', () => {
    const providers = [
      { id: 'beta', name: 'Beta' },
      { id: 'alpha', name: 'Alpha', models: [{ id: 'z' }, { id: 'a' }] },
    ];

    const sorted = sortProviderTreeForPicker(providers);

    expect(sorted.map((provider) => provider.id)).toEqual(['alpha', 'beta']);
    expect(sorted[0].models?.map((model) => model.id)).toEqual(['a', 'z']);
    expect(sorted[1].models).toEqual([]);
  });
});
