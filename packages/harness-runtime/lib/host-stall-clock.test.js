import { afterEach, describe, expect, test } from 'bun:test';
import { createHostStallClock } from './host-stall-clock.js';

const fixture = (options = {}) => {
  let time = 1_000_000;
  const stalls = [];
  const clock = createHostStallClock({ now: () => time, onStall: (stall) => stalls.push(stall), ...options });
  // The ticker runs every 250 ms unless the loop is blocked.
  const run = (ms) => { for (let passed = 0; passed < ms; passed += 250) { time += 250; clock.tick(); } };
  const block = (ms) => { time += ms; clock.tick(); };
  return { clock, stalls, run, block, now: () => time, advance: (ms) => { time += ms; } };
};

describe('host stall clock', () => {
  afterEach(() => { delete process.env.DEVRYAN_STALL_AWARE_DEADLINES; });

  test('ordinary scheduling delays are not stalls', () => {
    const f = fixture(); const started = f.now();
    f.run(10_000); f.block(900); f.run(2_000);
    expect(f.stalls).toEqual([]);
    expect(f.clock.stalledMsBetween(started)).toBe(0);
    expect(f.clock.activeMsSince(started)).toBe(f.now() - started);
  });

  test('a blocked loop is subtracted from the time a deadline counts', () => {
    const f = fixture(); const started = f.now();
    f.run(10_000); f.block(61_000); f.run(5_000);
    expect(f.stalls).toHaveLength(1);
    expect(f.stalls[0].ms).toBe(60_750);
    expect(f.clock.activeMsSince(started)).toBe(10_000 + 250 + 5_000);
    // A 60 s limit did not expire: the host could run for 15 s of those 76 s.
    expect(f.clock.expired(started, 60_000, 180_000)).toBe(false);
    f.run(45_000);
    expect(f.clock.expired(started, 60_000, 180_000)).toBe(true);
    expect(f.clock.snapshot()).toEqual({ stalls: 1, stalledMs: 60_750, longestStallMs: 60_750 });
  });

  test('a deadline that starts or ends inside a stall counts only its overlap', () => {
    const f = fixture();
    f.run(1_000); const before = f.now();
    f.block(30_000); const after = f.now();
    expect(f.clock.stalledMsBetween(before + 10_250, after)).toBe(19_750);
    expect(f.clock.stalledMsBetween(before, before + 5_250)).toBe(5_000);
    expect(f.clock.stalledMsBetween(after, after + 10_000)).toBe(0);
  });

  test('the first code to run after a stall already sees it', () => {
    const f = fixture(); f.run(1_000); const started = f.now();
    f.advance(110_000); // The ticker has not fired yet.
    expect(f.clock.activeMsSince(started)).toBe(250);
    expect(f.clock.expired(started, 60_000, 180_000)).toBe(false);
  });

  test('the cap is a wall-clock limit that no stall can move', () => {
    const f = fixture(); const started = f.now();
    f.block(200_000);
    expect(f.clock.activeMsSince(started)).toBeLessThan(1_000);
    expect(f.clock.expired(started, 60_000, 180_000)).toBe(true);
    expect(f.clock.expired(started, 60_000)).toBe(false);
  });

  test('the kill switch restores wall-clock deadlines', () => {
    const f = fixture(); const started = f.now();
    f.block(61_000);
    process.env.DEVRYAN_STALL_AWARE_DEADLINES = '0';
    expect(f.clock.stalledMsBetween(started)).toBe(0);
    expect(f.clock.expired(started, 60_000, 180_000)).toBe(true);
  });

  test('keeps a bounded history', () => {
    const f = fixture();
    for (let i = 0; i < 600; i++) { f.block(2_000); f.run(250); }
    expect(f.clock.snapshot().stalls).toBe(600);
    // Old stalls are forgotten: only recent time can be subtracted.
    expect(f.clock.stalledMsBetween(f.now() - 60 * 60_000)).toBeLessThanOrEqual(512 * 1_750);
  });
});
