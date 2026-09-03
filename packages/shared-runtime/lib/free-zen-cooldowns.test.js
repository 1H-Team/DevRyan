import { describe, expect, it } from 'bun:test';

import {
  FREE_ZEN_LONG_COOLDOWN_MS,
  FREE_ZEN_SHORT_COOLDOWN_MS,
  createFreeZenCooldowns,
  sharedFreeZenCooldowns,
} from './free-zen-cooldowns.js';

const makeClock = (start = 1_000_000) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

describe('free Zen cooldowns', () => {
  it('uses the long cooldown for hard failures and the short one for transient ones', () => {
    const clock = makeClock();
    const cooldowns = createFreeZenCooldowns({ now: clock.now });

    for (const reason of ['rate_limited', 'unauthorized', 'model_unavailable']) {
      expect(cooldowns.durationFor(reason)).toBe(FREE_ZEN_LONG_COOLDOWN_MS);
    }
    for (const reason of ['timeout', 'upstream_error', 'empty_output', 'invalid_output', 'request_failed', undefined]) {
      expect(cooldowns.durationFor(reason)).toBe(FREE_ZEN_SHORT_COOLDOWN_MS);
    }

    cooldowns.mark('hot', 'rate_limited');
    cooldowns.mark('flaky', 'timeout');
    expect(cooldowns.isCoolingDown('hot')).toBe(true);
    expect(cooldowns.isCoolingDown({ id: 'flaky' })).toBe(true);
    expect(cooldowns.isCoolingDown('cold')).toBe(false);

    clock.advance(FREE_ZEN_SHORT_COOLDOWN_MS);
    expect(cooldowns.isCoolingDown('flaky')).toBe(false);
    expect(cooldowns.isCoolingDown('hot')).toBe(true);

    clock.advance(FREE_ZEN_LONG_COOLDOWN_MS);
    expect(cooldowns.isCoolingDown('hot')).toBe(false);
  });

  it('accepts explicit timestamps and durations, and resets', () => {
    const clock = makeClock();
    const cooldowns = createFreeZenCooldowns({ now: clock.now, longMs: 1_000, shortMs: 100 });

    expect(cooldowns.mark('custom', 'request_failed', { at: 5_000, cooldownMs: 250 })).toBe(5_250);
    expect(cooldowns.isCoolingDown('custom', 5_100)).toBe(true);
    expect(cooldowns.isCoolingDown('custom', 5_250)).toBe(false);

    cooldowns.mark('rate', 'rate_limited');
    expect(cooldowns.snapshot()).toEqual([{ model: 'rate', reason: 'rate_limited', until: clock.now() + 1_000 }]);
    expect(cooldowns.mark('', 'rate_limited')).toBeNull();

    cooldowns.reset();
    expect(cooldowns.isCoolingDown('rate')).toBe(false);
    expect(cooldowns.snapshot()).toEqual([]);
  });

  it('exposes one shared process-wide ledger', () => {
    sharedFreeZenCooldowns.reset();
    expect(sharedFreeZenCooldowns.isCoolingDown('shared-model')).toBe(false);
    sharedFreeZenCooldowns.mark('shared-model', 'rate_limited');
    expect(sharedFreeZenCooldowns.isCoolingDown('shared-model')).toBe(true);
    sharedFreeZenCooldowns.reset();
  });
});
