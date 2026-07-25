import { describe, expect, it, vi } from 'vitest';

import {
  fetchClaudeQuota,
  listConfiguredQuotaProviders,
  parseClaudeCodeUsageOutput,
  resolveClaudeProxyBaseUrlFromProviders,
  resolveSafeClaudeQuotaUrl,
} from './quotaProviders';

describe('VS Code Claude quota parity', () => {
  it('resolves only safe dynamic loopback proxy URLs from live providers', () => {
    expect(resolveClaudeProxyBaseUrlFromProviders({
      providers: [{ id: 'anthropic', options: { baseURL: 'http://127.0.0.1:55201/v1' } }],
    })).toBe('http://127.0.0.1:55201/v1');
    expect(resolveClaudeProxyBaseUrlFromProviders({
      providers: [{ id: 'anthropic', options: { baseURL: 'https://example.com' } }],
    })).toBeNull();
    expect(resolveSafeClaudeQuotaUrl('http://localhost:3456/v1')).toBe('http://localhost:3456/v1/usage/quota');
  });

  it('discovers the proxy only for managed runtimes', () => {
    expect(listConfiguredQuotaProviders({
      claudeProxyConfigured: true,
      isExternalRuntime: false,
    })).toContain('claude');
    expect(listConfiguredQuotaProviders({
      claudeProxyConfigured: true,
      isExternalRuntime: true,
    })).not.toContain('claude');
  });

  it('maps Meridian fractions and measurement time', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        buckets: [
          { type: 'five_hour', utilization: 0.31, resetsAt: 1_800_000_000_000, observedAt: 1_700_000_000_000 },
          { type: 'seven_day', utilization: 0.03, resetsAt: 1_800_100_000_000, observedAt: 1_700_000_000_000 },
        ],
        asOf: 1_700_000_000_000,
      }),
      json: async () => ({}),
    }));
    const result = await fetchClaudeQuota({
      readAuth: () => ({}),
      claudeProxyConfigured: true,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201',
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.usageUpdatedAt).toBe(1_700_000_000_000);
    expect(result.usage?.windows['5h'].usedPercent).toBe(31);
    expect(result.usage?.windows['7d'].usedPercent).toBe(3);
  });

  it('parses the non-billable Claude /usage result', () => {
    const result = parseClaudeCodeUsageOutput(JSON.stringify({
      is_error: false,
      result: 'Current session: 31% used · resets Jul 24 at 7:39pm\nCurrent week (all models): 3% used · resets Jul 29 at 10:59pm',
    }), new Date('2026-07-24T16:00:00+01:00').getTime());
    expect(result.ok).toBe(true);
    expect(result.usage?.windows['5h'].usedPercent).toBe(31);
    expect(result.usage?.windows['7d'].usedPercent).toBe(3);
  });
});
