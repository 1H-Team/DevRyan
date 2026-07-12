import { describe, expect, test } from 'bun:test';

import { resolveProviderPromptTools } from './provider-prompt-tools.js';

describe('provider prompt tool policy', () => {
  test('caps GitHub Copilot tool discovery for canonical and legacy provider IDs', () => {
    expect(resolveProviderPromptTools('github-copilot')).toEqual({
      'resend_*': false,
      'mcp__resend__*': false,
    });
    expect(resolveProviderPromptTools('  COPILOT ')).toEqual({
      'resend_*': false,
      'mcp__resend__*': false,
    });
  });

  test('does not restrict providers without a confirmed tool limit', () => {
    expect(resolveProviderPromptTools('openai')).toBeUndefined();
    expect(resolveProviderPromptTools('cursor-acp')).toBeUndefined();
  });
});
