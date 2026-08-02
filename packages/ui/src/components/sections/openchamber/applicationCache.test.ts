import { describe, expect, test } from 'bun:test';
import { formatBytes } from '@/lib/formatBytes';

describe('formatBytes', () => {
  test('formats bytes using compact binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_536)).toBe('1.5 KiB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MiB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GiB');
  });

  test('normalizes invalid sizes to zero', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});
