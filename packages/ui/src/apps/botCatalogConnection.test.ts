import { describe, expect, test } from 'bun:test';
import { createBotCatalogConnection } from './botCatalogConnection';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

const harness = () => {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  const completions: Array<() => void> = [];
  let calls = 0;
  let cancelled = 0;
  let needsRetry = true;
  let nextId = 0;
  const controller = createBotCatalogConnection({
    load: () => { calls += 1; return new Promise<void>((resolve) => completions.push(resolve)); },
    cancel: () => { cancelled += 1; },
    shouldRetry: () => needsRetry,
    setTimeoutImpl: ((callback: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, callback);
      delays.push(delay);
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
  });
  return {
    controller, timers, delays,
    calls: () => calls,
    cancelled: () => cancelled,
    settle: async () => { completions.shift()?.(); await flush(); },
    ready: () => { needsRetry = false; },
    tick: () => {
      const entry = timers.entries().next().value;
      if (entry) { timers.delete(entry[0]); entry[1](); }
    },
  };
};

describe('assigned catalog connection', () => {
  test('retries bootstrap failures with capped backoff and stops after HTTP or SSE success', async () => {
    const h = harness();
    h.controller.retry();
    for (let i = 0; i < 7; i += 1) { await h.settle(); h.tick(); }
    expect(h.delays).toEqual([250, 1_000, 2_000, 5_000, 15_000, 15_000, 15_000]);
    h.ready();
    await h.settle();
    expect(h.timers.size).toBe(0);
    h.controller.dispose();
  });

  test('does not fetch after an SSE snapshot settles a scheduled retry', async () => {
    const h = harness();
    h.controller.retry();
    await h.settle();
    h.ready();
    h.tick();
    expect(h.calls()).toBe(1);
    expect(h.timers.size).toBe(0);
    h.controller.dispose();
  });

  test('coalesces manual retry during a pending request and cancels pending ownership on disposal', async () => {
    const h = harness();
    h.controller.retry();
    h.controller.retry();
    h.controller.retry();
    expect(h.calls()).toBe(1);
    await h.settle();
    expect(h.calls()).toBe(2);
    h.controller.dispose();
    await h.settle();
    h.controller.dispose();
    h.controller.retry();
    expect(h.cancelled()).toBe(1);
    expect(h.timers.size).toBe(0);
    expect(h.calls()).toBe(2);
  });
});
