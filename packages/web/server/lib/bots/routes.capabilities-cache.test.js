import { describe, expect, it, vi } from 'vitest';

import {
  BOT_STATUS_CACHE_TTL_MS,
  createBotHostStatusCache,
  registerBotRoutes,
  resolveBotCapabilities,
} from './routes.js';

const USER_ID = 'a0000000-0000-4000-8000-000000000001';

const healthyStatus = () => ({ state: 'healthy', code: null, issues: [], warnings: [] });

const createClock = (start = Date.UTC(2026, 8, 3, 12)) => {
  let at = start;
  return {
    now: () => at,
    advance(ms) { at += ms; },
  };
};

const host = (getStatus = vi.fn(async () => healthyStatus())) => ({ owner: 'electron', getStatus });

const createHarness = ({ botHost = host(), clock = createClock(), resolveCapabilities = null } = {}) => {
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
    method,
    (route, ...routeHandlers) => {
      handlers.set(`${method.toUpperCase()} ${route}`, routeHandlers.at(-1));
    },
  ]));
  app.use = () => {};
  const cache = createBotHostStatusCache({ now: clock.now });
  registerBotRoutes(app, {
    store: { available: true },
    blobStore: {},
    botHost,
    encryption: { getKey: () => Buffer.alloc(32) },
    resolveCapabilities,
    botHostStatusCache: cache,
  });
  return {
    botHost,
    cache,
    clock,
    async read(query = {}) {
      const response = {
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
      };
      await handlers.get('GET /api/bots/capabilities')({
        body: {},
        params: {},
        headers: {},
        query,
        principal: { id: USER_ID, role: 'developer', scope: 'managed' },
      }, response);
      return response;
    },
  };
};

describe('Bot host status cache', () => {
  it('rejects invalid configuration', () => {
    expect(() => createBotHostStatusCache({ ttlMs: -1 })).toThrow(TypeError);
    expect(() => createBotHostStatusCache({ now: null })).toThrow(TypeError);
  });

  it('reuses one probe within the TTL and probes again once it elapses', async () => {
    const clock = createClock();
    const cache = createBotHostStatusCache({ now: clock.now });
    const botHost = host();

    const first = await cache.getStatus(botHost);
    const second = await cache.getStatus(botHost);
    expect(second).toBe(first);
    expect(botHost.getStatus).toHaveBeenCalledTimes(1);
    expect(cache.fresh).toBe(true);

    clock.advance(BOT_STATUS_CACHE_TTL_MS - 1);
    await cache.getStatus(botHost);
    expect(botHost.getStatus).toHaveBeenCalledTimes(1);

    clock.advance(1);
    expect(cache.fresh).toBe(false);
    await cache.getStatus(botHost);
    expect(botHost.getStatus).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe between concurrent misses', async () => {
    let release;
    const botHost = host(vi.fn(() => new Promise((resolve) => { release = resolve; })));
    const cache = createBotHostStatusCache({ now: createClock().now });

    const reads = Promise.all([cache.getStatus(botHost), cache.getStatus(botHost)]);
    await Promise.resolve();
    expect(botHost.getStatus).toHaveBeenCalledTimes(1);
    release(healthyStatus());
    const [first, second] = await reads;
    expect(second).toBe(first);
    expect(cache.fresh).toBe(true);
  });

  it('never caches a rejected probe', async () => {
    const botHost = host(vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('docker down'), { code: 'bot_runtime_docker_unavailable' }))
      .mockResolvedValue(healthyStatus()));
    const cache = createBotHostStatusCache({ now: createClock().now });

    await expect(cache.getStatus(botHost)).rejects.toMatchObject({ code: 'bot_runtime_docker_unavailable' });
    expect(cache.fresh).toBe(false);
    await expect(cache.getStatus(botHost)).resolves.toMatchObject({ state: 'healthy' });
    expect(botHost.getStatus).toHaveBeenCalledTimes(2);
  });

  it('bypasses a fresh entry on refresh and drops it on invalidate', async () => {
    const botHost = host();
    const cache = createBotHostStatusCache({ now: createClock().now });

    await cache.getStatus(botHost);
    await cache.getStatus(botHost, { refresh: true });
    expect(botHost.getStatus).toHaveBeenCalledTimes(2);
    await cache.getStatus(botHost);
    expect(botHost.getStatus).toHaveBeenCalledTimes(2);

    cache.invalidate();
    expect(cache.fresh).toBe(false);
    await cache.getStatus(botHost);
    expect(botHost.getStatus).toHaveBeenCalledTimes(3);
  });

  it('does not let a probe that started before invalidation repopulate the cache', async () => {
    let release;
    const botHost = host(vi.fn(() => new Promise((resolve) => { release = resolve; })));
    const cache = createBotHostStatusCache({ now: createClock().now });

    const pending = cache.getStatus(botHost);
    cache.invalidate();
    release(healthyStatus());
    await pending;
    expect(cache.fresh).toBe(false);
  });

  it('is keyed by host so a different host object always probes', async () => {
    const cache = createBotHostStatusCache({ now: createClock().now });
    const first = host();
    const second = host();
    await cache.getStatus(first);
    await cache.getStatus(second);
    expect(first.getStatus).toHaveBeenCalledTimes(1);
    expect(second.getStatus).toHaveBeenCalledTimes(1);
  });
});

describe('Bot capabilities route status caching', () => {
  it('serves repeated capability reads from one Docker probe within the TTL', async () => {
    const harness = createHarness();

    const first = await harness.read();
    const second = await harness.read();
    expect(first.payload).toMatchObject({ state: 'healthy', available: true, runtime: { state: 'healthy' } });
    expect(second.payload).toEqual(first.payload);
    expect(harness.botHost.getStatus).toHaveBeenCalledTimes(1);

    harness.clock.advance(BOT_STATUS_CACHE_TTL_MS);
    await harness.read();
    expect(harness.botHost.getStatus).toHaveBeenCalledTimes(2);
  });

  it('probes again when the route is called with ?refresh=1', async () => {
    const harness = createHarness();

    await harness.read();
    await harness.read({ refresh: '1' });
    expect(harness.botHost.getStatus).toHaveBeenCalledTimes(2);
    await harness.read({ refresh: 'true' });
    expect(harness.botHost.getStatus).toHaveBeenCalledTimes(3);
    await harness.read({ refresh: '0' });
    await harness.read({ refresh: ['1'] });
    expect(harness.botHost.getStatus).toHaveBeenCalledTimes(4);
  });

  it('does not cache a failed probe', async () => {
    const harness = createHarness({
      botHost: host(vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('docker down'), { code: 'bot_runtime_docker_unavailable' }))
        .mockResolvedValue(healthyStatus())),
    });

    const failed = await harness.read();
    expect(failed.payload).toMatchObject({
      state: 'runtime_unavailable',
      code: 'bot_runtime_docker_unavailable',
      available: false,
    });
    const recovered = await harness.read();
    expect(recovered.payload).toMatchObject({ state: 'healthy', available: true });
    expect(harness.botHost.getStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps the response shape identical between cached and uncached reads', async () => {
    const harness = createHarness({
      botHost: host(vi.fn(async () => ({
        ...healthyStatus(),
        warnings: [{ code: 'docker_memory_low', message: 'low' }],
        canRepair: true,
      }))),
    });

    const uncached = await harness.read({ refresh: '1' });
    const cached = await harness.read();
    expect(cached.payload).toEqual(uncached.payload);
    expect(Object.keys(cached.payload).sort()).toEqual(
      ['available', 'canCreateBot', 'canManageRuntime', 'code', 'owner', 'runtime', 'state'],
    );
    expect(cached.payload.runtime).toEqual({
      state: 'healthy',
      code: null,
      issues: [],
      warnings: [{ code: 'docker_memory_low', message: 'low' }],
      canSetup: false,
      canRepair: true,
      canUpdate: false,
      canRollback: false,
    });
  });

  it('forwards the refresh flag to a runtime-owned capability resolver', async () => {
    const resolveCapabilities = vi.fn(async () => ({ available: true, state: 'healthy', code: null }));
    const harness = createHarness({ resolveCapabilities });

    await harness.read();
    await harness.read({ refresh: '1' });
    expect(resolveCapabilities.mock.calls).toEqual([[{ refresh: false }], [{ refresh: true }]]);
    expect(harness.botHost.getStatus).not.toHaveBeenCalled();
  });
});

describe('resolveBotCapabilities status cache opt-in', () => {
  it('probes every time without a cache so per-run preflight stays live', async () => {
    const botHost = host();
    const encryption = { getKey: () => Buffer.alloc(32) };
    await resolveBotCapabilities({ hasSupabase: true, botHost, encryption });
    await resolveBotCapabilities({ hasSupabase: true, botHost, encryption });
    expect(botHost.getStatus).toHaveBeenCalledTimes(2);
  });

  it('reuses the cached probe when a cache is supplied and honours refreshStatus', async () => {
    const botHost = host();
    const encryption = { getKey: () => Buffer.alloc(32) };
    const statusCache = createBotHostStatusCache({ now: createClock().now });
    await resolveBotCapabilities({ hasSupabase: true, botHost, encryption, statusCache });
    await resolveBotCapabilities({ hasSupabase: true, botHost, encryption, statusCache });
    expect(botHost.getStatus).toHaveBeenCalledTimes(1);
    await resolveBotCapabilities({ hasSupabase: true, botHost, encryption, statusCache, refreshStatus: true });
    expect(botHost.getStatus).toHaveBeenCalledTimes(2);
  });
});
