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
});
