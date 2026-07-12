import { describe, expect, test } from 'bun:test';
import {
  BASELINE_QUOTA_REFRESH_MS,
  createQuotaRefreshCoordinator,
  type QuotaRefreshClock,
  type QuotaRefreshOptions,
} from './quota-refresh-coordinator';

class ManualClock implements QuotaRefreshClock {
  private nextId = 1;
  private readonly timers = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }

  get delays(): number[] {
    return [...this.timers.values()].map((timer) => timer.delayMs);
  }

  runNext(): void {
    const next = this.timers.entries().next().value as [number, { callback: () => void }] | undefined;
    if (!next) {
      throw new Error('No timer is scheduled');
    }
    this.timers.delete(next[0]);
    next[1].callback();
  }
}

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached');
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

describe('quota refresh coordinator', () => {
  test('owns one initial load and one 30-minute baseline timer', async () => {
    const clock = new ManualClock();
    const refreshes: QuotaRefreshOptions[] = [];
    let settingsLoads = 0;
    const coordinator = createQuotaRefreshCoordinator({
      clock,
      loadSettings: async () => {
        settingsLoads += 1;
      },
      refresh: async (options) => {
        refreshes.push(options);
      },
      getRefreshIntervalMs: () => BASELINE_QUOTA_REFRESH_MS,
    });

    coordinator.start();
    coordinator.start();

    await waitFor(() => clock.delays.length === 1);
    expect(settingsLoads).toBe(1);
    expect(refreshes).toEqual([{ rediscover: true }]);
    expect(clock.delays).toEqual([BASELINE_QUOTA_REFRESH_MS]);

    clock.runNext();
    await waitFor(() => refreshes.length === 2 && clock.delays.length === 1);
    expect(refreshes[1]).toEqual({});
    expect(clock.delays).toEqual([BASELINE_QUOTA_REFRESH_MS]);
  });

  test('uses the optional faster cadence and reschedules after settings change', async () => {
    const clock = new ManualClock();
    const refreshes: QuotaRefreshOptions[] = [];
    let intervalMs = BASELINE_QUOTA_REFRESH_MS;
    const coordinator = createQuotaRefreshCoordinator({
      clock,
      loadSettings: async () => {},
      refresh: async (options) => {
        refreshes.push(options);
      },
      getRefreshIntervalMs: () => intervalMs,
    });

    coordinator.start();
    await waitFor(() => clock.delays.length === 1);

    intervalMs = 60_000;
    coordinator.settingsChanged();

    await waitFor(() => refreshes.length === 2 && clock.delays[0] === 60_000);
    expect(refreshes[1]).toEqual({ forceRefresh: true, rediscover: true });
    expect(clock.delays).toEqual([60_000]);
  });

  test('never overlaps refreshes and merges repeated requests into one queued follow-up', async () => {
    const clock = new ManualClock();
    const gates: ReturnType<typeof deferred>[] = [];
    const refreshes: QuotaRefreshOptions[] = [];
    let active = 0;
    let maxActive = 0;
    const coordinator = createQuotaRefreshCoordinator({
      clock,
      loadSettings: async () => {},
      refresh: async (options) => {
        refreshes.push(options);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        active -= 1;
      },
      getRefreshIntervalMs: () => BASELINE_QUOTA_REFRESH_MS,
    });

    const first = coordinator.refreshNow();
    const second = coordinator.refreshNow({ forceRefresh: true });
    const third = coordinator.refreshNow({ rediscover: true });

    expect(second).toBe(first);
    expect(third).toBe(first);
    await waitFor(() => refreshes.length === 1);
    expect(refreshes).toEqual([{}]);

    gates[0].resolve();
    await waitFor(() => refreshes.length === 2);
    expect(refreshes[1]).toEqual({ forceRefresh: true, rediscover: true });
    expect(maxActive).toBe(1);

    gates[1].resolve();
    await first;
    expect(refreshes).toHaveLength(2);
  });

  test('clears its timer and drops a queued follow-up when stopped', async () => {
    const clock = new ManualClock();
    const gate = deferred();
    const refreshes: QuotaRefreshOptions[] = [];
    const coordinator = createQuotaRefreshCoordinator({
      clock,
      loadSettings: async () => {},
      refresh: async (options) => {
        refreshes.push(options);
        if (refreshes.length === 1) {
          await gate.promise;
        }
      },
      getRefreshIntervalMs: () => BASELINE_QUOTA_REFRESH_MS,
    });

    coordinator.start();
    await waitFor(() => refreshes.length === 1);
    const pending = coordinator.refreshNow({ forceRefresh: true });
    coordinator.stop();
    gate.resolve();
    await pending;

    expect(refreshes).toHaveLength(1);
    expect(clock.delays).toEqual([]);
  });

  test('performs a fresh initial refresh when restarted during an older request', async () => {
    const clock = new ManualClock();
    const gate = deferred();
    const refreshes: QuotaRefreshOptions[] = [];
    let settingsLoads = 0;
    const coordinator = createQuotaRefreshCoordinator({
      clock,
      loadSettings: async () => {
        settingsLoads += 1;
      },
      refresh: async (options) => {
        refreshes.push(options);
        if (refreshes.length === 1) {
          await gate.promise;
        }
      },
      getRefreshIntervalMs: () => BASELINE_QUOTA_REFRESH_MS,
    });

    coordinator.start();
    await waitFor(() => refreshes.length === 1);
    coordinator.stop();
    coordinator.start();
    await waitFor(() => settingsLoads === 2);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Promise.resolve();
    }
    gate.resolve();

    await waitFor(() => refreshes.length === 2 && clock.delays.length === 1);
    expect(refreshes).toEqual([{ rediscover: true }, { rediscover: true }]);
  });
});
