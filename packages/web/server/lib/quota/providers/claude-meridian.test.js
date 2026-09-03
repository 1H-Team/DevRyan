import { describe, expect, it, vi } from 'vitest';

import {
  createClaudeProxyBaseUrlResolver,
  createMeridianClaudeContextUsageClient,
  extractMeridianClaudeResetSignal,
  fetchMeridianClaudeQuota,
  resolveSafeClaudeMeridianUrl,
  resolveSafeClaudeQuotaUrl,
  transformMeridianClaudeContextUsage,
  transformMeridianClaudeQuota,
} from './claude-meridian.js';

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(payload),
});

describe('Claude Meridian quota', () => {
  it('accepts only explicit loopback HTTP ports and fixes the quota path', () => {
    expect(resolveSafeClaudeQuotaUrl('http://127.0.0.1:3456/v1')).toBe('http://127.0.0.1:3456/v1/usage/quota');
    expect(resolveSafeClaudeQuotaUrl('http://localhost:55201')).toBe('http://localhost:55201/v1/usage/quota');
    expect(resolveSafeClaudeQuotaUrl('https://127.0.0.1:3456')).toBeNull();
    expect(resolveSafeClaudeQuotaUrl('http://192.168.1.3:3456')).toBeNull();
    expect(resolveSafeClaudeQuotaUrl('http://127.0.0.1')).toBeNull();
    expect(resolveSafeClaudeQuotaUrl('http://user:pass@127.0.0.1:3456')).toBeNull();
    expect(resolveSafeClaudeMeridianUrl(
      'http://127.0.0.1:3456/v1',
      '/v1/sessions/session-a/recover',
    )).toBe('http://127.0.0.1:3456/v1/sessions/session-a/recover');
  });

  it('rejects malformed payloads', () => {
    expect(transformMeridianClaudeQuota({ buckets: 'bad' }).ok).toBe(false);
    expect(transformMeridianClaudeQuota({ buckets: [{ type: 'unknown', utilization: 1 }] }).ok).toBe(false);
  });

  it('extracts the auto-resume reset signal from raw buckets', () => {
    const fiveHourReset = 1_760_000_050_000;
    const sevenDayReset = 1_760_000_020_000;
    expect(extractMeridianClaudeResetSignal(null)).toBeNull();
    expect(extractMeridianClaudeResetSignal({ buckets: 'bad' })).toBeNull();
    expect(extractMeridianClaudeResetSignal({ buckets: [] })).toEqual({ limited: false, resetAt: null });
    // Nothing limited: the earliest known reset of any bucket.
    expect(extractMeridianClaudeResetSignal({
      buckets: [
        { type: 'five_hour', status: 'allowed', utilization: 0.3, resetsAt: fiveHourReset },
        { type: 'seven_day', status: 'allowed_warning', utilization: 0.8, resetsAt: sevenDayReset },
      ],
    })).toEqual({ limited: false, resetAt: sevenDayReset });
    // A rejected bucket wins even when its utilization reads below 100%, and
    // only limited buckets contribute their reset.
    expect(extractMeridianClaudeResetSignal({
      buckets: [
        { type: 'five_hour', status: 'rejected', utilization: 0.9, resetsAt: fiveHourReset },
        { type: 'seven_day', status: 'allowed', utilization: 0.2, resetsAt: sevenDayReset },
      ],
    })).toEqual({ limited: true, resetAt: fiveHourReset });
    // Utilization at or above 100% counts as limited; ISO resets are accepted;
    // the earliest limited reset is reported.
    expect(extractMeridianClaudeResetSignal({
      buckets: [
        { type: 'five_hour', status: 'allowed', utilization: 1, resetsAt: '2025-10-09T08:00:00.000Z' },
        { type: 'seven_day_opus', status: 'rejected', utilization: 1.2, resetsAt: fiveHourReset },
        null,
      ],
    })).toEqual({ limited: true, resetAt: Date.parse('2025-10-09T08:00:00.000Z') });
    expect(extractMeridianClaudeResetSignal({
      buckets: [{ type: 'five_hour', status: 'rejected' }],
    })).toEqual({ limited: true, resetAt: null });
  });

  it('caches the Claude proxy base URL per directory and single-flights concurrent lookups', async () => {
    let at = 1_000;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ providers: [{ id: 'anthropic', options: { baseURL: 'http://127.0.0.1:3456' } }] }),
    }));
    const resolver = createClaudeProxyBaseUrlResolver({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer token' }),
      fetchImpl,
      now: () => at,
      ttlMs: 60_000,
    });

    await expect(Promise.all([resolver.resolve('/workspace'), resolver.resolve('/workspace')]))
      .resolves.toEqual(['http://127.0.0.1:3456', 'http://127.0.0.1:3456']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/config/providers?directory=%2Fworkspace',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Accept: 'application/json', authorization: 'Bearer token' }),
      }),
    );
    await expect(resolver.resolve('/other')).resolves.toBe('http://127.0.0.1:3456');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe('http://127.0.0.1:4096/config/providers?directory=%2Fother');

    at += 59_000;
    await expect(resolver.resolve('/workspace')).resolves.toBe('http://127.0.0.1:3456');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    at += 2_000;
    await expect(resolver.resolve('/workspace')).resolves.toBe('http://127.0.0.1:3456');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    resolver.clear();
    await expect(resolver.resolve('/workspace')).resolves.toBe('http://127.0.0.1:3456');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('keeps a zero-TTL resolver uncached, rejects unsafe proxies, skips external runtimes, and surfaces transport errors', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ providers: [{ id: 'anthropic', baseURL: 'https://api.anthropic.com' }] }),
    }));
    const resolver = createClaudeProxyBaseUrlResolver({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      fetchImpl,
      ttlMs: 0,
    });
    await expect(resolver.resolve('')).resolves.toBeNull();
    await expect(resolver.resolve(null)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:4096/config/providers');

    const external = createClaudeProxyBaseUrlResolver({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      isExternalOpenCode: () => true,
      fetchImpl,
    });
    await expect(external.resolve('/workspace')).resolves.toBeNull();
    await expect(createClaudeProxyBaseUrlResolver({ fetchImpl }).resolve('/workspace')).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = createClaudeProxyBaseUrlResolver({
      buildOpenCodeUrl: (pathname) => pathname,
      fetchImpl: vi.fn(async () => { throw new Error('offline'); }),
    });
    await expect(failing.resolve('/workspace')).rejects.toThrow('offline');
  });

  it('bounds response bodies', async () => {
    const result = await fetchMeridianClaudeQuota({
      baseUrl: 'http://127.0.0.1:3456',
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(70 * 1024) },
        text: async () => '{}',
      })),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('safe response limit');
  });

  it('times out bounded proxy requests', async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const result = await fetchMeridianClaudeQuota({
      baseUrl: 'http://127.0.0.1:3456',
      fetchImpl,
      timeoutMs: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Timed out');
  });

  it('normalizes active Anthropic input separately from the last output', () => {
    expect(transformMeridianClaudeContextUsage({
      context_usage: {
        input_tokens: 2,
        output_tokens: 1464,
        cache_read_input_tokens: 125220,
        cache_creation_input_tokens: 1818,
      },
    }, 'session-a')).toMatchObject({
      ok: true,
      usage: {
        sessionID: 'session-a',
        source: 'meridian',
        activeInputTokens: 127040,
        lastOutputTokens: 1464,
      },
    });
    expect(transformMeridianClaudeContextUsage({
      context_usage: { input_tokens: -1 },
    }, 'session-a').ok).toBe(false);
  });

  it('caches session lineage, coalesces concurrent reads, and refreshes after compaction', async () => {
    let recoverCount = 0;
    let usageCount = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith('/recover')) {
        recoverCount += 1;
        return jsonResponse({ claudeSessionId: `claude-${recoverCount}` });
      }
      usageCount += 1;
      await Promise.resolve();
      return jsonResponse({
        context_usage: {
          input_tokens: 2,
          output_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      });
    });
    const client = createMeridianClaudeContextUsageClient({ fetchImpl });

    const firstOptions = {
      baseUrl: 'http://127.0.0.1:3456',
      sessionID: 'session-a',
    };
    const [first, duplicate] = await Promise.all([
      client.fetchContextUsage(firstOptions),
      client.fetchContextUsage(firstOptions),
    ]);
    const cached = await client.fetchContextUsage(firstOptions);
    const refreshed = await client.fetchContextUsage({ ...firstOptions, refreshSession: true });

    expect(first.usage.activeInputTokens).toBe(122);
    expect(duplicate.usage.activeInputTokens).toBe(122);
    expect(cached.usage.activeInputTokens).toBe(122);
    expect(refreshed.usage.activeInputTokens).toBe(122);
    expect(recoverCount).toBe(2);
    expect(usageCount).toBe(3);
  });

  it('queues a forced compaction refresh behind an ordinary in-flight read', async () => {
    let releaseFirstUsage;
    let recoverCount = 0;
    let usageCount = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith('/recover')) {
        recoverCount += 1;
        return jsonResponse({ claudeSessionId: `claude-${recoverCount}` });
      }
      usageCount += 1;
      if (usageCount === 1) {
        await new Promise((resolve) => { releaseFirstUsage = resolve; });
      }
      return jsonResponse({
        context_usage: {
          input_tokens: usageCount === 1 ? 190_000 : 24_000,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
    });
    const client = createMeridianClaudeContextUsageClient({ fetchImpl });
    const options = { baseUrl: 'http://127.0.0.1:3456', sessionID: 'session-a' };
    const ordinary = client.fetchContextUsage(options);
    for (let attempt = 0; attempt < 10 && !releaseFirstUsage; attempt += 1) {
      await Promise.resolve();
    }
    const compacted = client.fetchContextUsage({ ...options, refreshSession: true });
    releaseFirstUsage();

    expect((await ordinary).usage.activeInputTokens).toBe(190_000);
    expect((await compacted).usage.activeInputTokens).toBe(24_000);
    expect(recoverCount).toBe(2);
    expect(usageCount).toBe(2);
  });

  it('rejects unsafe context origins and malformed context payloads', async () => {
    const unsafeClient = createMeridianClaudeContextUsageClient({ fetchImpl: vi.fn() });
    await expect(unsafeClient.fetchContextUsage({
      baseUrl: 'https://example.com',
      sessionID: 'session-a',
    })).resolves.toMatchObject({ ok: false });

    const malformedClient = createMeridianClaudeContextUsageClient({
      fetchImpl: vi.fn(async (url) => (
        String(url).endsWith('/recover')
          ? jsonResponse({ claudeSessionId: 'claude-a' })
          : jsonResponse({ context_usage: { input_tokens: 'bad' } })
      )),
    });
    await expect(malformedClient.fetchContextUsage({
      baseUrl: 'http://localhost:3456',
      sessionID: 'session-a',
    })).resolves.toMatchObject({ ok: false });
  });
});
