// Test wrapper, never part of the product: runs a sequence of calls on one clock made by
// `createHostStallClock`, with a clock the steps set and an interval stub that schedules nothing,
// and returns every result with the stalls the clock reported.
import { createHostStallClock } from '../../../../../harness-runtime/lib/host-stall-clock.js';

/**
 * @param {{ tickMs?: number, stallMs?: number, start: number }} options
 * @param {{ op: string, at: number, args: number[] }[]} steps
 * @returns {{ results: unknown[], stalls: unknown[] }}
 */
export function runHostStallClock(options, steps) {
  let clock = options.start;
  const stalls = [];
  const host = createHostStallClock({ tickMs: options.tickMs, stallMs: options.stallMs, now: () => clock,
    onStall: (stall) => stalls.push(stall), setIntervalImpl: () => ({}), clearIntervalImpl: () => {} });
  const results = steps.map((step) => {
    clock = step.at;
    if (step.op === 'tick') return host.tick();
    if (step.op === 'stalledMsBetween') return host.stalledMsBetween(...step.args);
    if (step.op === 'activeMsSince') return host.activeMsSince(...step.args);
    if (step.op === 'expired') return host.expired(...step.args);
    if (step.op === 'start') return host.start();
    if (step.op === 'stop') return host.stop();
    return host.snapshot();
  });
  return { results, stalls };
}
