import { describe, expect, test } from 'bun:test';

import {
  normalizeCursorSdkAgentDefinitions,
  pinCursorSdkSubagentModels,
} from './agent-definitions.js';

describe('Cursor SDK agent definition normalization', () => {
  test('preserves explicit model selections while pinning inherited agents', () => {
    const definitions = normalizeCursorSdkAgentDefinitions({
      fixer: {
        description: 'Fast implementation specialist',
        prompt: 'Apply the requested fix.',
        model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
      },
      explorer: {
        description: 'Read-only code explorer',
        prompt: 'Inspect the repository and report findings.',
        model: 'inherit',
      },
    });

    expect(pinCursorSdkSubagentModels(definitions, { id: 'gpt-5.5' })).toEqual({
      explorer: {
        description: 'Read-only code explorer',
        prompt: 'Inspect the repository and report findings.',
        model: { id: 'gpt-5.5' },
      },
      fixer: {
        description: 'Fast implementation specialist',
        prompt: 'Apply the requested fix.',
        model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
      },
    });
  });
});
