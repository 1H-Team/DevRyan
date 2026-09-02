import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBotPeriodicJob } from './periodic-job.js';

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('Bot periodic job', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off with a bounded delay, logs once per code, and recovers', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    let failures = 3;
    const run = vi.fn(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new DOMException('deadline', 'TimeoutError');
      }
    });
    const job = createBotPeriodicJob({
      name: 'approval_expiry', run, intervalMs: 1_000, maxBackoffMs: 3_000, logger, random: () => 0.5,
    });
    job.start();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ job: 'approval_expiry', code: 'request_timeout' });

    // 1s * 2 = 2s after the first failure (jitter factor 1.0 at random 0.5).
    await vi.advanceTimersByTimeAsync(1_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    // Bounded at 3s.
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(run).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(run).toHaveBeenCalledTimes(4);
    expect(logger.info).toHaveBeenCalledWith('[Bots] periodic job recovered', {
      job: 'approval_expiry', consecutiveFailures: 3,
    });
    // Back to the base interval after success.
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(run).toHaveBeenCalledTimes(5);
    await job.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('never overlaps runs and stop waits for the in-flight run', async () => {
    let release;
    const run = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const job = createBotPeriodicJob({ name: 'sweep', run, intervalMs: 100 });
    job.start();
    await flush();
    void job.trigger();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    const stopped = job.stop();
    release();
    await stopped;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid configuration', () => {
    expect(() => createBotPeriodicJob({ name: 'Bad Name', run: async () => {}, intervalMs: 10 })).toThrow();
    expect(() => createBotPeriodicJob({ name: 'ok', run: async () => {}, intervalMs: 1_000, maxBackoffMs: 10 })).toThrow();
  });
});
