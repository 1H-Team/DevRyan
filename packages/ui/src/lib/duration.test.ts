import { describe, expect, test } from 'bun:test';

import { formatDurationMilliseconds, formatElapsedDuration } from './duration';

describe('shared duration formatting', () => {
  test('formats seconds, minutes, and uncapped hour-scale durations', () => {
    expect(formatDurationMilliseconds(12_340).label).toBe('12.3s');
    expect(formatDurationMilliseconds(4 * 60_000 + 18_900).label).toBe('4m 18s');
    expect(formatDurationMilliseconds(2 * 3_600_000 + 7 * 60_000 + 4_900).label).toBe('2h 7m 4s');
    expect(formatDurationMilliseconds(17 * 60_000).label).toBe('17m 0s');
  });

  test('rounds only positive finalized sub-tenth durations up to 0.1 seconds', () => {
    expect(formatElapsedDuration(1_000, 1_001).label).toBe('0.1s');
    expect(formatElapsedDuration(1_000, 1_000).label).toBe('0.0s');
    expect(formatElapsedDuration(1_000, undefined, 1_001).label).toBe('0.0s');
  });

  test('returns an explicit unavailable state for invalid ranges', () => {
    expect(formatElapsedDuration(Number.NaN, 2_000)).toEqual({
      available: false,
      label: 'Unavailable',
      milliseconds: null,
    });
    expect(formatElapsedDuration(2_000, 1_000).available).toBe(false);
    expect(formatDurationMilliseconds(Number.POSITIVE_INFINITY).available).toBe(false);
  });
});
