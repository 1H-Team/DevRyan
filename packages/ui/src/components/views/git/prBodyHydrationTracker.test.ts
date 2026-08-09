import { describe, expect, test } from 'bun:test';
import { PrBodyHydrationTracker } from './prBodyHydrationTracker';

describe('PrBodyHydrationTracker', () => {
  test('a cancelled refresh cannot clear the replacement body request', () => {
    const tracker = new PrBodyHydrationTracker();
    const first = tracker.begin('/repo#owner/repo#7023');

    expect(tracker.cancel(first)).toBe(true);

    const replacement = tracker.begin('/repo#owner/repo#7023');
    expect(tracker.settle(first)).toBe(false);
    expect(tracker.settle(replacement)).toBe(true);
  });

  test('rejects a stale response after PR identity changes', () => {
    const tracker = new PrBodyHydrationTracker();
    const mergedPr = tracker.begin('/repo#owner/repo#7023');
    const nextPr = tracker.begin('/repo#owner/repo#7024');

    expect(tracker.settle(mergedPr)).toBe(false);
    expect(tracker.settle(nextPr)).toBe(true);
  });
});
