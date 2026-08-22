import { afterEach, describe, expect, mock, test } from 'bun:test';

import { getClaudePromptMode, setClaudeCompatibilityMode } from './claudePromptModeApi';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Claude prompt mode API', () => {
  test('reads the safe prompt-mode state', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      mode: 'combined',
      compatibilityMode: false,
      editable: true,
    }), { status: 200 })) as typeof fetch;

    expect(await getClaudePromptMode()).toEqual({
      mode: 'combined',
      compatibilityMode: false,
      editable: true,
    });
  });

  test('writes only the compatibility boolean with CSRF protection', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      captured = init;
      return new Response(JSON.stringify({
        mode: 'claude-only',
        compatibilityMode: true,
        editable: true,
        changed: true,
      }), { status: 200 });
    }) as typeof fetch;

    await setClaudeCompatibilityMode(true);

    expect(captured?.method).toBe('PUT');
    expect(new Headers(captured?.headers).get('X-DevRyan-CSRF')).toBe('1');
    expect(JSON.parse(String(captured?.body))).toEqual({ compatibilityMode: true });
  });

  test('surfaces server write failures', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: 'Meridian settings are read-only' }),
      { status: 500 },
    )) as typeof fetch;

    let message = '';
    try {
      await setClaudeCompatibilityMode(true);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Meridian settings are read-only');
  });
});
