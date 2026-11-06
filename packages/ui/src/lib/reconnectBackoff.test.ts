import { describe, expect, test } from 'bun:test';

import { createReconnectBackoff, reconnectDelayMs } from './reconnectBackoff';

describe('reconnect backoff', () => {
  test('starts at 1 s, doubles, and caps at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(reconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(reconnectDelayMs(-3)).toBe(1_000);
    expect(reconnectDelayMs(Number.NaN)).toBe(30_000);
  });

  test('advances per retry and resets after ready', () => {
    const backoff = createReconnectBackoff();
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([1_000, 2_000, 4_000]);
    expect(backoff.attempt).toBe(3);
    backoff.reset();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(1_000);
  });
});
