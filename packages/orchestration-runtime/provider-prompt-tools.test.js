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

  test('keeps Orchestrator root prompts on the managed harness surface', () => {
    expect(resolveProviderPromptTools('openai', 'orchestrator')).toEqual({
      task: false,
      invalid: false,
      'mcp__*': false,
      'resend_*': false,
    });
    expect(resolveProviderPromptTools('cursor-acp', ' Orchestrator ')).toEqual({
      task: false,
      invalid: false,
      'mcp__*': false,
      'resend_*': false,
    });
  });

  test('merges Orchestrator and Copilot tool restrictions', () => {
    expect(resolveProviderPromptTools('github-copilot', 'orchestrator')).toEqual({
      'resend_*': false,
      'mcp__resend__*': false,
      task: false,
      invalid: false,
      'mcp__*': false,
    });
  });
});
