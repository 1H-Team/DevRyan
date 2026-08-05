import { describe, expect, test } from 'bun:test';

import { isBenignNavigationAbort } from '../browser-navigation-error.mjs';

describe('isBenignNavigationAbort', () => {
  test('accepts Electron abort errors by errno', () => {
    expect(isBenignNavigationAbort({ errno: -3 })).toBe(true);
  });

  test('accepts Electron abort errors by symbolic message', () => {
    expect(isBenignNavigationAbort(new Error("ERR_ABORTED (-3) loading 'https://example.com/'"))).toBe(true);
  });

  test('accepts Electron abort errors by numeric loading message', () => {
    expect(isBenignNavigationAbort(new Error("Navigation failed (-3) loading 'https://example.com/'"))).toBe(true);
  });

  test('rejects unrelated errors and invalid inputs', () => {
    expect(isBenignNavigationAbort(new Error('ERR_NAME_NOT_RESOLVED'))).toBe(false);
    expect(isBenignNavigationAbort({ errno: -105 })).toBe(false);
    expect(isBenignNavigationAbort(null)).toBe(false);
    expect(isBenignNavigationAbort('ERR_ABORTED')).toBe(false);
  });
});
