import { describe, expect, test } from 'bun:test';

import { getControlledModelOptions } from './controlledModelPickerOptions';

describe('controlled model picker provider branding', () => {
  test('uses Claude as the Anthropic provider group label without changing execution ids', () => {
    const options = getControlledModelOptions([
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }],
      },
    ], []);

    expect(options).toHaveLength(1);
    expect(options[0]?.providerId).toBe('anthropic');
    expect(options[0]?.providerName).toBe('Claude');
    expect(options[0]?.modelId).toBe('claude-sonnet');
  });
});
