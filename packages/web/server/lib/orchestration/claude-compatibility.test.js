import { describe, expect, it, vi } from 'vitest';

import { MANAGED_AGENT_CONTRACT_TAG } from '@openchamber/orchestration-runtime';

import {
  DEFAULT_MANAGED_TURN_BUDGET,
  DEFAULT_PROMPT_MODE_MEMO_MS,
  createClaudeCompatibilityPreambleResolver,
  isAnthropicProviderId,
  resolveManagedTaskTurnBudget,
} from './claude-compatibility.js';

const promptMode = (mode) => ({ ok: true, mode, compatibilityMode: mode === 'claude-only' });

describe('claude compatibility preamble resolver', () => {
  it('injects the agent contract only for Anthropic-routed tasks in claude-only mode', () => {
    const readPromptMode = vi.fn(() => promptMode('claude-only'));
    const resolve = createClaudeCompatibilityPreambleResolver({ readPromptMode, now: () => 0 });

    const designer = resolve({ providerId: 'anthropic', agent: 'designer' });
    expect(designer.startsWith(MANAGED_AGENT_CONTRACT_TAG)).toBe(true);
    expect(designer).toContain('managed designer task');
    expect(designer).toContain('**Status:** complete');

    expect(resolve({ providerId: 'anthropic-oauth', agent: 'fixer' })).toContain('managed fixer task');
    expect(resolve({ providerId: 'opencode-with-claude', agent: 'explorer' })).toContain('Read-only role');
    expect(resolve({ providerId: 'claude', agent: 'builder' })).toContain('managed sub-agent task');

    // Non-Anthropic tasks never consult the prompt mode at all.
    expect(resolve({ providerId: 'openai', agent: 'designer' })).toBeNull();
    expect(resolve({ providerId: 'github-copilot', agent: 'fixer' })).toBeNull();
    expect(resolve({ providerId: 'cursor-acp', agent: 'designer' })).toBeNull();
    expect(readPromptMode).toHaveBeenCalledTimes(1);
  });

  it('returns null outside claude-only mode', () => {
    for (const mode of ['combined', 'client-only', 'none', 'custom']) {
      const resolve = createClaudeCompatibilityPreambleResolver({
        readPromptMode: () => promptMode(mode),
        now: () => 0,
      });
      expect(resolve({ providerId: 'anthropic', agent: 'designer' })).toBeNull();
    }
  });

  it('returns null when the prompt mode cannot be read', () => {
    const failing = createClaudeCompatibilityPreambleResolver({
      readPromptMode: () => ({ ok: false, code: 'meridian_sdk_features_missing', error: 'missing' }),
      now: () => 0,
    });
    expect(failing({ providerId: 'anthropic', agent: 'designer' })).toBeNull();

    const throwing = createClaudeCompatibilityPreambleResolver({
      readPromptMode: () => { throw new Error('EACCES'); },
      now: () => 0,
    });
    expect(throwing({ providerId: 'anthropic', agent: 'designer' })).toBeNull();
  });

  it('memoizes the prompt mode for five seconds and then re-reads it', () => {
    let clock = 0;
    let mode = 'combined';
    const readPromptMode = vi.fn(() => promptMode(mode));
    const resolve = createClaudeCompatibilityPreambleResolver({ readPromptMode, now: () => clock });
    const task = { providerId: 'anthropic', agent: 'designer' };

    expect(resolve(task)).toBeNull();
    mode = 'claude-only';
    clock = DEFAULT_PROMPT_MODE_MEMO_MS - 1;
    expect(resolve(task)).toBeNull();
    expect(readPromptMode).toHaveBeenCalledTimes(1);

    clock = DEFAULT_PROMPT_MODE_MEMO_MS;
    expect(resolve(task)).toContain(MANAGED_AGENT_CONTRACT_TAG);
    expect(readPromptMode).toHaveBeenCalledTimes(2);

    mode = 'combined';
    clock = DEFAULT_PROMPT_MODE_MEMO_MS * 2;
    expect(resolve(task)).toBeNull();
    expect(readPromptMode).toHaveBeenCalledTimes(3);
  });

  it('recognizes the Anthropic provider aliases case-insensitively', () => {
    expect(isAnthropicProviderId('Anthropic')).toBe(true);
    expect(isAnthropicProviderId(' claude ')).toBe(true);
    expect(isAnthropicProviderId('openai')).toBe(false);
    expect(isAnthropicProviderId(null)).toBe(false);
  });
});

describe('managed task turn budget', () => {
  it('budgets designer and fixer tasks only', () => {
    expect(resolveManagedTaskTurnBudget({ agent: 'designer' })).toBe(DEFAULT_MANAGED_TURN_BUDGET);
    expect(resolveManagedTaskTurnBudget({ agent: 'fixer' })).toBe(150);
    expect(resolveManagedTaskTurnBudget({ agent: ' Designer ' })).toBe(150);
    for (const agent of ['explorer', 'librarian', 'oracle', 'builder', undefined]) {
      expect(resolveManagedTaskTurnBudget({ agent })).toBeNull();
    }
    expect(resolveManagedTaskTurnBudget(null)).toBeNull();
  });
});
