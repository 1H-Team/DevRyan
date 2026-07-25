import { describe, expect, it, vi } from 'vitest';

import {
  fetchMeridianClaudeQuota,
  resolveSafeClaudeQuotaUrl,
  transformMeridianClaudeQuota,
} from './claude-meridian.js';

describe('Claude Meridian quota', () => {
  it('accepts only explicit loopback HTTP ports and fixes the quota path', () => {
    expect(resolveSafeClaudeQuotaUrl('http://127.0.0.1:3456/v1')).toBe('http://127.0.0.1:3456/v1/usage/quota');
    expect(resolveSafeClaudeQuotaUrl('http://localhost:55201')).toBe('http://localhost:55201/v1/usage/quota');
    expect(resolveSafeClaudeQuotaUrl('https://127.0.0.1:3456')).toBeNull();
    expect(resolveSafeClaudeQuotaUrl('http://192.168.1.3:3456')).toBeNull();
    expect(resolveSafeClaudeQuotaUrl('http://127.0.0.1')).toBeNull();
    expect(resolveSafeClaudeQuotaUrl('http://user:pass@127.0.0.1:3456')).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(transformMeridianClaudeQuota({ buckets: 'bad' }).ok).toBe(false);
    expect(transformMeridianClaudeQuota({ buckets: [{ type: 'unknown', utilization: 1 }] }).ok).toBe(false);
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
});
