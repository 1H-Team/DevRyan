import { describe, expect, mock, test } from 'bun:test';

import {
  executeClaudeAwareProviderRecovery,
  prepareClaudeCompatibilityRecovery,
  requiresClaudeCompatibilityRecovery,
} from './claudeCompatibilityRecovery';

const reason = 'API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.';

describe('Claude compatibility recovery', () => {
  test('requires compatibility only for an exact classifier error retried with Claude', () => {
    expect(requiresClaudeCompatibilityRecovery(reason, 'anthropic')).toBe(true);
    expect(requiresClaudeCompatibilityRecovery(reason, 'openai')).toBe(false);
    expect(requiresClaudeCompatibilityRecovery("You've hit your limit", 'anthropic')).toBe(false);
  });

  test('waits for compatibility mode before allowing the caller to retry', async () => {
    const events: string[] = [];
    const setter = mock(async () => {
      events.push('configured');
      return { mode: 'claude-only' as const, compatibilityMode: true, editable: true };
    });

    expect(await prepareClaudeCompatibilityRecovery(reason, 'anthropic', setter)).toBe(true);
    expect(events).toEqual(['configured']);
  });

  test('propagates configuration failures and does not configure non-Claude retries', async () => {
    let calls = 0;
    const setter = mock(async () => {
      calls += 1;
      throw new Error('Prompt mode update failed');
    });

    let message = '';
    try {
      await prepareClaudeCompatibilityRecovery(reason, 'anthropic', setter);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Prompt mode update failed');
    expect(await prepareClaudeCompatibilityRecovery(reason, 'openai', setter)).toBe(false);
    expect(calls).toBe(1);
  });

  test('does not resend when compatibility configuration fails', async () => {
    let retries = 0;
    const execute = mock(async () => {
      retries += 1;
      return true;
    });
    const failingSetter = mock(async () => {
      throw new Error('Prompt mode update failed');
    });
    const record = { reason, selection: { providerId: 'anthropic' } };

    try {
      await executeClaudeAwareProviderRecovery(record, execute, failingSetter);
    } catch {
      // Expected: configuration is a required preflight.
    }
    expect(retries).toBe(0);

    const nonClaude = { reason, selection: { providerId: 'openai' } };
    expect(await executeClaudeAwareProviderRecovery(nonClaude, execute, failingSetter)).toBe(true);
    expect(retries).toBe(1);
  });
});
