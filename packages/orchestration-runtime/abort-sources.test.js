import { describe, expect, test } from 'bun:test';
import { ABORT_SOURCE_HEADER, ABORT_SOURCES, normalizeAbortSource } from './index.js';

describe('abort sources', () => {
  test('normalizes only known sources', () => {
    for (const source of ABORT_SOURCES) expect(normalizeAbortSource(source)).toBe(source);
    expect(normalizeAbortSource('rm -rf')).toBe('unknown');
    expect(normalizeAbortSource(undefined)).toBe('unknown');
    expect(normalizeAbortSource(['stop_button'])).toBe('unknown');
  });

  test('is a frozen contract with a stable header name', () => {
    expect(Object.isFrozen(ABORT_SOURCES)).toBe(true);
    expect(ABORT_SOURCE_HEADER).toBe('X-DevRyan-Abort-Source');
  });
});
