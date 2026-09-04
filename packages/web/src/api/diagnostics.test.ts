import { afterEach, describe, expect, test, vi } from 'vitest';

import { createWebDiagnosticsAPI } from './diagnostics';

const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

describe('createWebDiagnosticsAPI', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('sends task exports with CSRF protection and surfaces structured errors', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json(
        { error: 'Authentication required', authenticated: false },
        { status: 401 },
      );
    }) as typeof fetch;

    await expect(createWebDiagnosticsAPI().export({
      scope: 'task',
      sessionID: 'session-a',
    })).rejects.toThrow('Authentication required');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/diagnostics/export');
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      scope: 'task',
      sessionID: 'session-a',
    });
  });

  test('reads OpenCode storage and posts compaction requests with CSRF protection', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/compact')) {
        return Response.json({ scheduled: true }, { status: 202 });
      }
      return Response.json({ dbBytes: 10, eventRows: 2, lastRun: null });
    }) as typeof fetch;

    const api = createWebDiagnosticsAPI();
    await expect(api.getOpenCodeStorage?.()).resolves.toMatchObject({ dbBytes: 10, eventRows: 2 });
    await expect(api.compactOpenCodeStorage?.({ dryRun: true })).resolves.toEqual({ scheduled: true });
    await expect(api.compactOpenCodeStorage?.()).resolves.toEqual({ scheduled: true });

    expect(calls.map((call) => call.url)).toEqual([
      '/api/storage/opencode-db',
      '/api/storage/opencode-db/compact',
      '/api/storage/opencode-db/compact',
    ]);
    expect(calls[0].init?.cache).toBe('no-store');
    expect(calls[1].init?.method).toBe('POST');
    expect(new Headers(calls[1].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ dryRun: true });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ dryRun: false });

    globalThis.fetch = vi.fn(async () => Response.json({ error: 'external runtime', code: 'external_runtime' }, { status: 409 })) as typeof fetch;
    await expect(createWebDiagnosticsAPI().compactOpenCodeStorage?.()).rejects.toThrow('external runtime');
  });
});
