import { describe, expect, test } from 'bun:test';
import { parseAgentModelSelections } from './agentModelSelection';

describe('parseAgentModelSelections', () => {
  test('preserves a trimmed per-agent model and variant', () => {
    expect(parseAgentModelSelections({
      ' Orchestrator ': {
        providerId: ' openai ',
        modelId: ' gpt-5.6-sol ',
        variant: ' high ',
      },
    })).toEqual({
      Orchestrator: {
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'high',
      },
    });
  });

  test('keeps legacy model-only selections backward compatible', () => {
    expect(parseAgentModelSelections({
      Orchestrator: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
    })).toEqual({
      Orchestrator: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
    });
  });

  test('drops malformed rows and empty variants', () => {
    expect(parseAgentModelSelections({
      Builder: { providerId: 'openai', modelId: 'gpt-5.6', variant: ' ' },
      Broken: { providerId: '', modelId: 'missing-provider', variant: 'high' },
    })).toEqual({
      Builder: { providerId: 'openai', modelId: 'gpt-5.6' },
    });
  });
});
