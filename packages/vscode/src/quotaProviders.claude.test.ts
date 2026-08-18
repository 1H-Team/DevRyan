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
      readAuth: () => ({}),
    })).toContain('claude');
    expect(listConfiguredQuotaProviders({
      claudeProxyConfigured: true,
      isExternalRuntime: true,
      readAuth: () => ({}),
    })).not.toContain('claude');
  });

  it('discovers every supported Anthropic auth alias only for managed runtimes', () => {
    for (const alias of ['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude']) {
      expect(listConfiguredQuotaProviders({
        readAuth: () => ({ [alias]: { access: 'token' } }),
      })).toContain('claude');
      expect(listConfiguredQuotaProviders({
        readAuth: () => ({ [alias]: { access: 'token' } }),
        isExternalRuntime: true,
      })).not.toContain('claude');
    }
  });

  it('maps direct OAuth primary and model-specific windows', async () => {
    const result = await fetchClaudeQuota({
      readAuth: () => ({ 'anthropic-oauth': { access: 'token' } }),
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          five_hour: { utilization: 12, resets_at: '2026-08-01T00:00:00.000Z' },
          seven_day: { utilization: 5, resets_at: '2026-08-08T00:00:00.000Z' },
          seven_day_fable: { utilization: 2, resets_at: '2026-08-08T00:00:00.000Z' },
        }),
      })),
    });

    expect(result.ok).toBe(true);
    expect(result.providerName).toBe('Claude');
    expect(result.usage?.windows['5h'].usedPercent).toBe(12);
    expect(result.usage?.windows['7d'].usedPercent).toBe(5);
    expect(result.usage?.windows['7d-fable'].usedPercent).toBe(2);
  });

  it('falls through from failed OAuth usage to Meridian', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          buckets: [
            { type: 'five_hour', utilization: 0.24, resetsAt: 1_800_000_000_000 },
            { type: 'seven_day', utilization: 0.06, resetsAt: 1_800_100_000_000 },
          ],
        }),
        json: async () => ({}),
      });
    const result = await fetchClaudeQuota({
      readAuth: () => ({ anthropic: { access: 'stale-token' } }),
      claudeProxyConfigured: true,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201',
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.usage?.windows['5h'].usedPercent).toBe(24);
  });

  it('falls through from empty OAuth usage to Claude Code usage', async () => {
    const fetchClaudeCodeUsage = vi.fn(async () => ({
      ok: true as const,
      usage: {
        windows: {
          '5h': {
            usedPercent: 18,
            remainingPercent: 82,
            windowSeconds: 18_000,
            resetAfterSeconds: 60,
            resetAt: 1_800_000_000_000,
            resetAtFormatted: 'later',
            resetAfterFormatted: 'later',
          },
          '7d': {
            usedPercent: 4,
            remainingPercent: 96,
            windowSeconds: 604_800,
            resetAfterSeconds: 120,
            resetAt: 1_800_100_000_000,
            resetAtFormatted: 'later',
            resetAfterFormatted: 'later',
          },
        },
      },
      usageUpdatedAt: 1234,
    }));
    const result = await fetchClaudeQuota({
      readAuth: () => ({ 'opencode-with-claude': { access: 'token' } }),
      claudeProxyConfigured: true,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ five_hour: { utilization: 'invalid' } }),
      })),
      fetchClaudeCodeUsage,
    });

    expect(result.ok).toBe(true);
    expect(fetchClaudeCodeUsage).toHaveBeenCalledTimes(1);
    expect(result.usage?.windows['5h'].usedPercent).toBe(18);
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
          { type: 'seven_day_fable', utilization: 0.01, resetsAt: 1_800_100_000_000, observedAt: 1_700_000_000_000 },
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
    expect(result.usage?.windows['7d-fable'].usedPercent).toBe(1);
  });

  it('parses the non-billable Claude /usage result', () => {
    const result = parseClaudeCodeUsageOutput(JSON.stringify({
      is_error: false,
      result: 'Current session: 31% used · resets Jul 24 at 7:39pm\nCurrent week (all models): 3% used · resets Jul 29 at 10:59pm\nCurrent week (Fable): 1% used · resets Jul 29 at 10:59pm',
    }), new Date('2026-07-24T16:00:00+01:00').getTime());
    expect(result.ok).toBe(true);
    expect(result.usage?.windows['5h'].usedPercent).toBe(31);
    expect(result.usage?.windows['7d'].usedPercent).toBe(3);
    expect(result.usage?.windows['7d-fable'].usedPercent).toBe(1);
  });

  it('does not use local Anthropic sources for external runtimes', async () => {
    const fetchImpl = vi.fn();
    const fetchClaudeCodeUsage = vi.fn();
    const result = await fetchClaudeQuota({
      readAuth: () => ({ anthropic: { access: 'local-token' } }),
      claudeProxyConfigured: true,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201',
      isExternalRuntime: true,
      fetchImpl,
      fetchClaudeCodeUsage,
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetchClaudeCodeUsage).not.toHaveBeenCalled();
  });

  it('keeps Anthropic visible as configured when every live source fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({}),
      });
    const result = await fetchClaudeQuota({
      readAuth: () => ({ anthropic: { access: 'stale-token' } }),
      claudeProxyConfigured: true,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201',
      fetchImpl,
      fetchClaudeCodeUsage: async () => ({
        ok: false,
        error: 'Claude Code usage unavailable',
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Claude Code usage unavailable');
  });
});
