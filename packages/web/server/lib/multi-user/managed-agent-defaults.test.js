import { describe, expect, it } from 'vitest';

import {
  getPersonalAgentDefault,
  resolveManagedAgentExecution,
  validatePersonalAgentDefault,
} from './managed-agent-defaults.js';

const agents = [{
  name: 'Orchestrator',
  model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
  variant: 'medium',
  modelRefs: ['openai/gpt-5.6-sol'],
}, {
  name: 'Council',
  model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
  modelRefs: ['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-4-6'],
}];

describe('managed agent defaults', () => {
  it('resolves personal defaults case-insensitively ahead of live host config', () => {
    expect(resolveManagedAgentExecution({
      agents,
      agentName: 'orchestrator',
      settingsOverrides: {
        agentModelSelections: {
          ORCHESTRATOR: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', variant: 'high' },
        },
      },
    })).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      variant: 'high',
      agentName: 'Orchestrator',
      source: 'personal',
    });
  });

  it('inherits host changes after reset and leaves Council host-managed', () => {
    expect(resolveManagedAgentExecution({ agents, agentName: 'Orchestrator', settingsOverrides: {} }))
      .toMatchObject({ modelId: 'gpt-5.6-sol', variant: 'medium', source: 'inherited' });
    expect(resolveManagedAgentExecution({
      agents,
      agentName: 'Council',
      settingsOverrides: {
        agentModelSelections: { Council: { providerId: 'other', modelId: 'forbidden' } },
      },
    })).toMatchObject({ modelId: 'gpt-5.6-sol', source: 'host-managed' });
  });

  it('rejects malformed payloads and composite agents', () => {
    expect(() => validatePersonalAgentDefault({
      agentName: 'Orchestrator',
      payload: { providerId: 'openai', modelId: 'gpt-5.6-sol', unexpected: true },
      agents,
    })).toThrow('Unknown agent default field');
    expect(() => validatePersonalAgentDefault({
      agentName: 'Council',
      payload: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      agents,
    })).toThrow('managed by the host');
    expect(() => validatePersonalAgentDefault({
      agentName: 'Orchestrator',
      payload: { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'high;rm' },
      agents,
    })).toThrow('Thinking value is invalid');
  });

  it('ignores malformed stored values', () => {
    expect(getPersonalAgentDefault({
      agentModelSelections: { Orchestrator: { providerId: '', modelId: 'model' } },
    }, 'orchestrator')).toBeNull();
  });
});
