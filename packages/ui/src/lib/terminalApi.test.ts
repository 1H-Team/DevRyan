import { describe, expect, test } from 'bun:test';

import { getTerminalCapabilities, keepAliveTerminal } from './terminalApi';

const originalFetch = globalThis.fetch;

test('terminal capability reads require a complete explicit grant and never accept a malformed replacement', async () => {
  try {
    for (const value of [
      { available: true, code: null },
      { available: false, code: 'terminal_platform_unsupported' },
    ]) {
      globalThis.fetch = (async (input, init) => {
        expect(input).toBe('/api/terminal/capabilities');
        expect(init?.cache).toBe('no-store');
        return Response.json(value);
      }) as typeof fetch;
      expect(await getTerminalCapabilities()).toEqual(value);
    }
    for (const value of [null, [], {}, { available: 'true', code: null }, { available: true },
      { available: true, code: 'terminal_platform_unsupported' }, { available: false, code: null }]) {
      globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
      await expect(getTerminalCapabilities()).rejects.toThrow('Invalid terminal capabilities.');
    }
    globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
    await expect(getTerminalCapabilities()).rejects.toThrow('Terminal availability could not be checked.');
  } finally { globalThis.fetch = originalFetch; }
});

describe('terminal API keepalive', () => {
  test('returns true when the terminal touch endpoint succeeds', async () => {
    const requested: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push([input, init]);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    try {
      expect(await keepAliveTerminal('session-1')).toBe(true);

      expect(requested).toEqual([[
        '/api/terminal/session-1/touch',
        { method: 'POST' },
      ]]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns false when the terminal session is missing', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Terminal session not found' }), { status: 404 })) as typeof fetch;

    try {
      expect(await keepAliveTerminal('missing-session')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws for non-404 touch failures', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'touch failed' }), { status: 500 })) as typeof fetch;

    try {
      let error: unknown = null;
      try {
        await keepAliveTerminal('session-1');
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('touch failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
