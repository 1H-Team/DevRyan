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
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { open: (...args: unknown[]) => { calls.push(args); return {}; } },
    });
    expect(await openExternalUrl('https://example.com/path')).toBe(true);
    expect(calls).toEqual([['https://example.com/path', '_blank', 'noopener,noreferrer']]);
    expect(await openExternalUrl('file:///tmp/private')).toBe(false);
  });
});
