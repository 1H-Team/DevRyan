import { afterEach, describe, expect, test } from 'bun:test';

import { openExternalUrl } from './url';

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('openExternalUrl', () => {
  test('reports a popup-blocked browser tab as not opened', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { open: () => null },
    });
    expect(await openExternalUrl('https://example.com/')).toBe(false);
  });

  test('opens HTTP(S) in a new isolated tab and rejects non-web schemes', async () => {
    const calls: unknown[][] = [];
    const replaceCalls: string[] = [];
    const opened = {
      opener: { retained: true },
      location: { replace: (value: string) => { replaceCalls.push(value); } },
      close: () => undefined,
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { open: (...args: unknown[]) => { calls.push(args); return opened; } },
    });
    expect(await openExternalUrl('https://example.com/path')).toBe(true);
    expect(calls).toEqual([['', '_blank']]);
    expect(opened.opener).toBeNull();
    expect(replaceCalls).toEqual(['https://example.com/path']);
    expect(await openExternalUrl('file:///tmp/private')).toBe(false);
  });

  test('closes a blank tab when navigation fails', async () => {
    let closeCalls = 0;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        open: () => ({
          opener: null,
          location: { replace: () => { throw new Error('navigation denied'); } },
          close: () => { closeCalls += 1; },
        }),
      },
    });

    expect(await openExternalUrl('https://example.com/')).toBe(false);
    expect(closeCalls).toBe(1);
  });
});
