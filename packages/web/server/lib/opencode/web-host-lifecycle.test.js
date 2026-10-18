import { describe, expect, it, vi } from 'vitest';
import { createWebHostLifecycle } from './web-host-lifecycle.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('web host lifecycle', () => {
  it('refuses an overlapping start without constructing or resetting anything', async () => {
    const pending = deferred();
    const construct = vi.fn(() => pending.promise), resetAfterStop = vi.fn();
    const lifecycle = createWebHostLifecycle({ construct, resetAfterStop });
    const first = lifecycle.start({ port: 1 });
    await expect(lifecycle.start({ port: 2 })).rejects.toMatchObject({ code: 'web_host_already_running', status: 409 });
    pending.resolve({ id: 'host' });
    await expect(first).resolves.toEqual({ id: 'host' });
    await expect(lifecycle.start({ port: 3 })).rejects.toMatchObject({ code: 'web_host_already_running' });
    expect(construct).toHaveBeenCalledExactlyOnceWith({ port: 1 });
    expect(resetAfterStop).not.toHaveBeenCalled();
    expect(lifecycle.getState()).toBe('running');
  });

  it('restarts after a completed shutdown, clearing that shutdown first', async () => {
    const order = [];
    const lifecycle = createWebHostLifecycle({
      construct: async () => { order.push('construct'); return {}; },
      resetAfterStop: () => order.push('reset'),
    });
    await lifecycle.start();
    lifecycle.markStopped();
    expect(lifecycle.getState()).toBe('stopped');
    await lifecycle.start();
    expect(order).toEqual(['construct', 'reset', 'construct']);
    expect(lifecycle.getState()).toBe('running');
  });

  it('retries after a failed start with the original error and no reset', async () => {
    const failure = Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' });
    const construct = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ id: 'retry' });
    const resetAfterStop = vi.fn();
    const lifecycle = createWebHostLifecycle({ construct, resetAfterStop });
    await expect(lifecycle.start()).rejects.toBe(failure);
    expect(lifecycle.getState()).toBe('idle');
    await expect(lifecycle.start()).resolves.toEqual({ id: 'retry' });
    expect(resetAfterStop).not.toHaveBeenCalled();
  });

  it('a shutdown that completes during construction leaves the host stopped', async () => {
    const pending = deferred(), resetAfterStop = vi.fn();
    const lifecycle = createWebHostLifecycle({ construct: () => pending.promise, resetAfterStop });
    const starting = lifecycle.start();
    lifecycle.markStopped();
    expect(lifecycle.getState()).toBe('starting');
    pending.resolve({});
    await starting;
    expect(lifecycle.getState()).toBe('stopped');
    await lifecycle.start();
    expect(resetAfterStop).toHaveBeenCalledOnce();
  });

  it('a failed start releases what it acquired before its original error surfaces', async () => {
    const order = [], failure = Object.assign(new Error('listener failed'), { code: 'EADDRINUSE' });
    const lifecycle = createWebHostLifecycle({
      construct: async () => { order.push('construct'); throw failure; },
      resetAfterStop: () => order.push('reset'),
      cleanupFailedStart: async () => { order.push('cleanup'); lifecycle.markStopped(); },
    });
    const error = await lifecycle.start().catch(caught => caught);
    expect(error).toBe(failure);
    expect(error.startupCleanup).toEqual({ state: 'released', code: null });
    expect(Object.keys(error)).not.toContain('startupCleanup');
    expect(order).toEqual(['construct', 'cleanup']);
    // The released host restarts from a cleared shutdown.
    expect(lifecycle.getState()).toBe('stopped');
    await lifecycle.start().catch(() => {});
    expect(order).toEqual(['construct', 'cleanup', 'reset', 'construct', 'cleanup']);
  });

  it('a refused settlement retains the owners, keeps the start retryable and reports separately', async () => {
    const warn = vi.fn(), failure = new Error('controller exited');
    const construct = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ id: 'retry' });
    const resetAfterStop = vi.fn();
    const lifecycle = createWebHostLifecycle({ construct, resetAfterStop, log: { warn },
      cleanupFailedStart: async () => { throw Object.assign(new Error('settlement refused'), { code: 'bundle_execution_unsettled', retainedOwners: true }); } });
    const error = await lifecycle.start().catch(caught => caught);
    expect(error).toBe(failure);
    expect(error.startupCleanup).toEqual({ state: 'retained', code: 'bundle_execution_unsettled' });
    expect(warn).toHaveBeenCalledExactlyOnceWith('[web-host] failed start cleanup did not complete', error.startupCleanup);
    expect(lifecycle.getState()).toBe('idle');
    await expect(lifecycle.start()).resolves.toEqual({ id: 'retry' });
    expect(resetAfterStop).not.toHaveBeenCalled();
  });

  it('a cleanup failure after settlement is reported as failed with a finite code only', async () => {
    const lifecycle = createWebHostLifecycle({ construct: async () => { throw new Error('boom'); }, resetAfterStop: () => {}, log: { warn: () => {} },
      cleanupFailedStart: async () => { throw Object.assign(new Error('secret path /Users/x'), { code: 'Not A Code' }); } });
    const error = await lifecycle.start().catch(caught => caught);
    expect(error.startupCleanup).toEqual({ state: 'failed', code: 'web_host_start_cleanup_failed' });
  });

  it('a non-extensible failure is rethrown as is', async () => {
    const failure = Object.freeze(new Error('frozen'));
    const cleanupFailedStart = vi.fn(async () => {});
    const lifecycle = createWebHostLifecycle({ construct: async () => { throw failure; }, resetAfterStop: () => {}, cleanupFailedStart });
    await expect(lifecycle.start()).rejects.toBe(failure);
    expect(cleanupFailedStart).toHaveBeenCalledOnce();
  });

  it('labels construction as its own startup phase', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await createWebHostLifecycle({ construct: async () => ({}), resetAfterStop: () => {} }).start();
      const phases = log.mock.calls.filter(([prefix]) => prefix === '[runtime-bundle] startup phase').map(([, json]) => JSON.parse(json));
      expect(phases).toEqual([{ phase: 'web_host_construction', outcome: 'completed', elapsedMs: expect.any(Number) }]);
    } finally { log.mockRestore(); }
  });
});
