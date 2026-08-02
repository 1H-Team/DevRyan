import { describe, expect, it, vi } from 'vitest';

import {
  fetchClaudeQuota,
  isAnthropicOAuthProxyOptions,
  isConfigured,
} from './claude.js';

const proxyFetchResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(payload),
});

describe('fetchClaudeQuota', () => {
  it('prefers direct Anthropic OAuth over proxy and CLI sources', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 12, resets_at: '2026-01-01T01:00:00.000Z' },
        seven_day: { utilization: 56, resets_at: '2026-01-08T00:00:00.000Z' },
        seven_day_sonnet: { utilization: 34, resets_at: '2026-01-08T00:00:00.000Z' },
      }),
    }));
    const fetchMeridianUsage = vi.fn();
    const fetchCliUsage = vi.fn();

    const result = await fetchClaudeQuota({
      readAuth: () => ({ anthropic: { access: 'token-123' } }),
      hasProxyConfig: () => true,
      fetchImpl,
      fetchMeridianUsage,
      fetchCliUsage,
    });

    expect(fetchImpl).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
    }));
    expect(fetchMeridianUsage).not.toHaveBeenCalled();
    expect(fetchCliUsage).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.usageUpdatedAt).toEqual(expect.any(Number));
    expect(result.usage.windows['5h'].usedPercent).toBe(12);
    expect(result.usage.windows['7d'].usedPercent).toBe(56);
    expect(result.usage.windows['7d-sonnet'].usedPercent).toBe(34);
  });

  it('falls through from failed OAuth usage to the live Meridian proxy', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(proxyFetchResponse({
        buckets: [
          { type: 'five_hour', utilization: 0.22, resetsAt: 1_800_000_000_000 },
          { type: 'seven_day', utilization: 0.05, resetsAt: 1_800_100_000_000 },
        ],
      }));

    const result = await fetchClaudeQuota({
      readAuth: () => ({ anthropic: { access: 'stale-token' } }),
      hasProxyConfig: () => true,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201/v1',
      fetchImpl,
      fetchCliUsage: vi.fn(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(22);
    expect(result.usage.windows['7d'].usedPercent).toBe(5);
  });

  it('falls through from malformed or empty OAuth usage to Claude Code usage', async () => {
    const fetchCliUsage = vi.fn(async () => ({
      ok: true,
      usage: { windows: { '5h': { usedPercent: 17 }, '7d': { usedPercent: 4 } } },
      usageUpdatedAt: 9876,
    }));
    const result = await fetchClaudeQuota({
      readAuth: () => ({ 'anthropic-oauth': { access: 'token-123' } }),
      hasProxyConfig: () => true,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => ({ five_hour: { utilization: 'not-a-number' } }),
      })),
      fetchCliUsage,
    });

    expect(fetchCliUsage).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.usageUpdatedAt).toBe(9876);
    expect(result.usage.windows['5h'].usedPercent).toBe(17);
  });

  it('uses the active Meridian proxy and maps fraction buckets and source time', async () => {
    const result = await fetchClaudeQuota({
      readAuth: () => ({}),
      hasProxyConfig: () => true,
      resolveProxyBaseUrl: async () => 'http://127.0.0.1:55201/v1',
      fetchImpl: vi.fn(async () => proxyFetchResponse({
        buckets: [
          { type: 'five_hour', utilization: 0.2, resetsAt: 1_800_000_000_000, observedAt: 1_700_000_000_000 },
          { type: 'seven_day', utilization: 0.02, resetsAt: 1_800_100_000_000, observedAt: 1_700_000_000_000 },
          { type: 'seven_day_fable', utilization: 0.01, resetsAt: 1_800_100_000_000, observedAt: 1_700_000_000_000 },
        ],
        asOf: 1_700_000_000_000,
      })),
      fetchCliUsage: vi.fn(),
    });

    expect(result.ok).toBe(true);
    expect(result.usageUpdatedAt).toBe(1_700_000_000_000);
    expect(result.usage.windows['5h'].usedPercent).toBe(20);
    expect(result.usage.windows['7d'].usedPercent).toBe(2);
    expect(result.usage.windows['7d-fable'].usedPercent).toBe(1);
  });

  it('falls back to non-billable Claude /usage when Meridian is unavailable', async () => {
    const fetchCliUsage = vi.fn(async () => ({
      ok: true,
      usage: { windows: { '5h': { usedPercent: 21 }, '7d': { usedPercent: 3 } } },
      usageUpdatedAt: 1234,
    }));
    const result = await fetchClaudeQuota({
      readAuth: () => ({}),
      hasProxyConfig: () => true,
      resolveProxyBaseUrl: async () => 'http://127.0.0.1:55201',
      fetchMeridianUsage: async () => ({ ok: false, code: 'claude_meridian_unavailable', error: '404' }),
      fetchCliUsage,
    });

    expect(fetchCliUsage).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.usageUpdatedAt).toBe(1234);
    expect(result.usage.windows['5h'].usedPercent).toBe(21);
  });

  it('returns status-line data only as a degraded failed result', async () => {
    const result = await fetchClaudeQuota({
      readAuth: () => ({}),
      hasProxyConfig: () => true,
      resolveProxyBaseUrl: async () => null,
      fetchCliUsage: async () => ({ ok: false, code: 'claude_code_usage_failed', error: 'Claude CLI failed' }),
      readStatusUsage: () => ({
        ok: true,
        usage: { windows: { '5h': { usedPercent: 6 }, '7d': { usedPercent: 1 } } },
        usageUpdatedAt: 456,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Claude CLI failed');
    expect(result.usageUpdatedAt).toBe(456);
    expect(result.usage.windows['5h'].usedPercent).toBe(6);
  });

  it('does not substitute local Claude usage for an external OpenCode runtime', async () => {
    const fetchCliUsage = vi.fn();
    const fetchImpl = vi.fn();
    const result = await fetchClaudeQuota({
      readAuth: () => ({ anthropic: { access: 'local-token' } }),
      hasProxyConfig: () => true,
      isExternalRuntime: true,
      fetchCliUsage,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(fetchCliUsage).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps Anthropic configured and reports an error when every live source fails', async () => {
    const result = await fetchClaudeQuota({
      readAuth: () => ({ anthropic: { access: 'stale-token' } }),
      hasProxyConfig: () => true,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201',
      fetchImpl: vi.fn(async () => ({ ok: false, status: 401 })),
      fetchMeridianUsage: async () => ({
        ok: false,
        code: 'claude_meridian_unavailable',
        error: 'Meridian unavailable',
      }),
      fetchCliUsage: async () => ({
        ok: false,
        code: 'claude_code_usage_failed',
        error: 'Claude Code usage unavailable',
      }),
      readStatusUsage: () => ({
        ok: false,
        code: 'claude_status_unavailable',
        error: 'No degraded status',
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Claude Code usage unavailable');
  });
});

describe('isAnthropicOAuthProxyOptions', () => {
  it('accepts dynamic local proxy ports and rejects unsafe or credentialed URLs', () => {
    expect(isAnthropicOAuthProxyOptions({ baseURL: 'http://127.0.0.1:55201', apiKey: 'dummy' })).toBe(true);
    expect(isAnthropicOAuthProxyOptions({ baseURL: 'http://localhost:3456', apiKey: 'dummy' })).toBe(true);
    expect(isAnthropicOAuthProxyOptions({ baseURL: 'https://api.anthropic.com', apiKey: 'dummy' })).toBe(false);
    expect(isAnthropicOAuthProxyOptions({ baseURL: 'http://127.0.0.1:55201', apiKey: 'sk-ant-key' })).toBe(false);
  });
});

describe('isConfigured', () => {
  it('discovers a safe live proxy without a direct OAuth entry', () => {
    expect(isConfigured({
      readAuth: () => ({}),
      hasProxyConfig: () => false,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201/v1',
    })).toBe(true);
    expect(isConfigured({
      readAuth: () => ({}),
      hasProxyConfig: () => false,
      claudeProxyBaseUrl: 'https://example.com',
    })).toBe(false);
  });

  it('ignores local Anthropic sources for external runtimes', () => {
    expect(isConfigured({
      readAuth: () => ({ anthropic: { access: 'local-token' } }),
      hasProxyConfig: () => true,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201',
      isExternalRuntime: true,
    })).toBe(false);
  });
});
