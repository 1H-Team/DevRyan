import { expect, test } from 'vitest';
import { createClaudeAgentProviderResetProbe } from './provider-reset-probe.js';

const usage = windows => ({ version: 1, updatedAt: 1, windows });

test('answers only for claude-agent with recorded windows', async () => {
  const probe = createClaudeAgentProviderResetProbe({ readUsage: () => usage({ seven_day: { utilization: 0.5, resetsAt: 2000, status: 'allowed' } }) });
  expect(await probe.resolveProviderReset({ providerId: 'openai' })).toBeNull();
  expect(await probe.resolveProviderReset({ providerId: 'claude-agent' })).toEqual({ limited: false, resetAt: 2_000_000 });
  expect(await createClaudeAgentProviderResetProbe({ readUsage: () => undefined }).resolveProviderReset({ providerId: 'claude-agent' })).toBeNull();
  expect(await createClaudeAgentProviderResetProbe({ readUsage: () => { throw new Error('x'); } }).resolveProviderReset({ providerId: 'claude-agent' })).toBeNull();
});

test('a rejected or exhausted window reports the earliest limited reset', async () => {
  const probe = createClaudeAgentProviderResetProbe({ readUsage: () => usage({
    five_hour: { utilization: 1, resetsAt: 3000 },
    seven_day: { utilization: 0.9, resetsAt: 2000, status: 'rejected' },
    seven_day_opus: { utilization: 0.1, resetsAt: 1000, status: 'allowed' },
  }) });
  expect(await probe.resolveProviderReset({ providerId: 'claude-agent' })).toEqual({ limited: true, resetAt: 2_000_000 });
});
