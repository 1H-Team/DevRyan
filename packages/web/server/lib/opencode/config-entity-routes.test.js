import { describe, expect, it } from 'vitest';

import { sanitizeAgentRuntimeMetadata } from './config-entity-routes.js';

describe('restricted agent runtime metadata', () => {
  it('preserves effective model and safe Slim preset provenance', () => {
    expect(sanitizeAgentRuntimeMetadata({
      name: 'orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      variant: 'high',
      prompt: 'private host prompt',
      modelResolution: {
        presetName: 'openai',
        source: 'root-override',
        presetModelRef: 'openai/gpt-5.5',
        presetVariant: 'medium',
      },
    })).toEqual({
      name: 'orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      variant: 'high',
      modelResolution: {
        presetName: 'openai',
        source: 'root-override',
        presetModelRef: 'openai/gpt-5.5',
        presetVariant: 'medium',
      },
    });
  });
});
