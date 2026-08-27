import { afterEach, describe, expect, test, vi } from 'vitest';

import { createWebSettingsAPI } from './settings';

const originalFetch = globalThis.fetch;

describe('createWebSettingsAPI', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('restarts OpenCode with CSRF protection', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ success: true });
    }) as typeof fetch;

    const settings = createWebSettingsAPI();
    if (!settings.restartOpenCode) {
      throw new Error('restartOpenCode is required');
    }
    await expect(settings.restartOpenCode()).resolves.toEqual({ restarted: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/config/reload');
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
  });

  test('saves personal settings with CSRF protection', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ nativeNotificationsEnabled: true });
    }) as typeof fetch;

    const settings = createWebSettingsAPI();
    await expect(settings.save({ nativeNotificationsEnabled: true })).resolves.toMatchObject({
      nativeNotificationsEnabled: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/config/settings');
    expect(calls[0].init?.method).toBe('PUT');
    expect(new Headers(calls[0].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
  });
});
