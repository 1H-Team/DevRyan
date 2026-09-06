import { describe, expect, test } from 'bun:test';

import {
  findAgentDefaultOverride,
  resolveAgentDefaultSelection,
} from './agentDefaultResolution';

const providers = [{
  id: 'openai',
  models: [{
    id: 'gpt-5.6-sol',
    variants: { low: {}, medium: {}, high: {} },
  }, {
    id: 'gpt-5.6',
    variants: { medium: {}, high: {}, xhigh: {} },
  }],
}, {
  id: 'anthropic',
  models: [{
    id: 'claude-sonnet-4-6',
    variants: { low: {}, high: {} },
  }],
}];

const orchestrator = {
  name: 'Orchestrator',
  model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
  variant: 'medium',
  modelRefs: ['openai/gpt-5.6-sol'],
};

describe('agent default resolution', () => {
  test('a personal row without a variant captures provider default instead of inheriting host effort', () => {
    const selection = resolveAgentDefaultSelection({
      agentName: 'Orchestrator',
      agents: [orchestrator],
      providers,
      personalSelections: { Orchestrator: { providerId: 'openai', modelId: 'gpt-5.6-sol' } },
    });
    expect(selection?.variant).toBeNull();
    expect(selection?.source).toBe('personal');
  });

  test('finds account overrides case-insensitively and gives them precedence over the live host default', () => {
    const personalSelections = {
      ORCHESTRATOR: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        variant: 'high',
      },
    };

    expect(findAgentDefaultOverride(personalSelections, 'orchestrator')).toEqual(personalSelections.ORCHESTRATOR);
    expect(resolveAgentDefaultSelection({
      agentName: 'orchestrator',
      agents: [orchestrator],
      providers,
      personalSelections,
    })).toEqual({
      agentName: 'Orchestrator',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      variant: 'high',
      source: 'personal',
    });
  });

  test('inherits live host changes immediately when no personal override exists', () => {
    const changedHost = {
      ...orchestrator,
      model: { providerID: 'openai', modelID: 'gpt-5.6' },
      variant: 'xhigh',
    };

    expect(resolveAgentDefaultSelection({
      agentName: 'Orchestrator',
      agents: [changedHost],
      providers,
    })).toEqual({
      agentName: 'Orchestrator',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'xhigh',
      source: 'inherited',
    });
  });

  test('falls back from a known unavailable personal model to the host default', () => {
    expect(resolveAgentDefaultSelection({
      agentName: 'Orchestrator',
      agents: [orchestrator],
      providers,
      personalSelections: {
        Orchestrator: { providerId: 'anthropic', modelId: 'retired-model', variant: 'high' },
      },
    })).toEqual({
      agentName: 'Orchestrator',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      variant: 'medium',
      source: 'inherited',
    });
  });

  test('preserves captured defaults while provider hydration is incomplete', () => {
    expect(resolveAgentDefaultSelection({
      agentName: 'Orchestrator',
      agents: [orchestrator],
      providers: [],
      personalSelections: {
        Orchestrator: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', variant: 'high' },
      },
    })).toEqual({
      agentName: 'Orchestrator',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      variant: 'high',
      source: 'personal',
    });
  });

  test('normalizes thinking when an explicitly unavailable host model uses the catalog fallback', () => {
    const unavailableHost = {
      ...orchestrator,
      model: { providerID: 'openai', modelID: 'retired-model' },
    };
    const providersWithRetired = [{
      ...providers[0],
      models: [
        { id: 'retired-model', available: false },
        ...(providers[0].models ?? []),
      ],
    }, providers[1]];

    expect(resolveAgentDefaultSelection({
      agentName: 'Orchestrator',
      agents: [unavailableHost],
      providers: providersWithRetired,
    })).toEqual({
      agentName: 'Orchestrator',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      variant: null,
      source: 'availability-fallback',
    });
  });

  test('keeps Council on its host-managed roster even if stale personal data exists', () => {
    const council = {
      name: 'Council',
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      variant: 'medium',
      modelRefs: ['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-4-6'],
    };

    expect(resolveAgentDefaultSelection({
      agentName: 'council',
      agents: [council],
      providers,
      personalSelections: {
        Council: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', variant: 'high' },
      },
    })).toEqual({
      agentName: 'Council',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      variant: 'medium',
      source: 'host-managed',
    });
  });
});
