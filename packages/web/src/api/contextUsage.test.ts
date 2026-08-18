import { afterEach, describe, expect, test } from 'vitest';
import { createWebContextUsageAPI } from './contextUsage';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('web context usage API', () => {
  test('passes directory and compaction refresh options to the normalized endpoint', async () => {
    let requestedURL = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedURL = String(input);
      return new Response(JSON.stringify({
        sessionID: 'ses_1234567890',
        status: 'available',
        source: 'meridian',
        inputTokens: 2,
        cacheReadTokens: 125_220,
        cacheWriteTokens: 1_818,
        activeInputTokens: 127_040,
        lastOutputTokens: 1_464,
        fetchedAt: 10,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await createWebContextUsageAPI().getSessionUsage('ses_1234567890', {
      directory: '/repo with spaces',
      refreshSession: true,
    });

    expect(requestedURL).toContain('/api/session/ses_1234567890/context-usage?');
    expect(requestedURL).toContain('directory=%2Frepo+with+spaces');
    expect(requestedURL).toContain('refreshSession=true');
    expect(result.activeInputTokens).toBe(127_040);
  });

  test('fails closed to the message fallback contract', async () => {
    globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;
    const result = await createWebContextUsageAPI().getSessionUsage('ses_1234567890');
    expect(result.status).toBe('unavailable');
    expect(result.source).toBe('message-fallback');
  });
});
