import { describe, expect, test } from 'bun:test';
import { formatCacheSize } from './applicationCache';

describe('formatCacheSize', () => {
  test('formats bytes using compact binary units', () => {
    expect(formatCacheSize(0)).toBe('0 B');
    expect(formatCacheSize(512)).toBe('512 B');
    expect(formatCacheSize(1_536)).toBe('1.5 KB');
    expect(formatCacheSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatCacheSize(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });

  test('normalizes invalid sizes to zero', () => {
    expect(formatCacheSize(-1)).toBe('0 B');
    expect(formatCacheSize(Number.NaN)).toBe('0 B');
  });
});
