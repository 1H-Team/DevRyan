import { describe, expect, it, vi } from 'vitest';

import { createBotPrewarmCache } from './prewarm-cache.js';

const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Production Bot prewarm cache', () => {
  it('shares in-flight work and returns a ready cache hit without secret-bearing output', async () => {
    const compilation = deferred();
    const compileRevision = vi.fn(() => compilation.promise);
    const loadModelCatalog = vi.fn(async () => ({ models: [] }));
    const checkHealth = vi.fn(async () => ({
      available: true,
      state: 'healthy',
      code: null,
      capabilityToken: 'must-not-be-retained',
    }));
    const cache = createBotPrewarmCache({ compileRevision, loadModelCatalog, checkHealth });
    const input = { channelId: CHANNEL_ID, revisionId: REVISION_ID, contract: { version: 1 } };

    expect(cache.prewarm(input)).toMatchObject({ state: 'warming', revisionId: REVISION_ID });
    expect(cache.prewarm(input)).toMatchObject({ state: 'warming', revisionId: REVISION_ID });
    expect(compileRevision).toHaveBeenCalledTimes(1);
    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
    expect(checkHealth).toHaveBeenCalledTimes(1);

    compilation.resolve({ compiledHash: 'a'.repeat(64), contract: input.contract });
    await settle();
    const ready = cache.prewarm(input);
    expect(ready).toEqual({
      state: 'ready',
      revisionId: REVISION_ID,
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(ready)).not.toContain('capabilityToken');
  });

  it('enforces four-entry LRU and five-minute idle expiry', async () => {
    let clock = 1_000;
    const cache = createBotPrewarmCache({
      compileRevision: async ({ revisionId }) => ({
        compiledHash: revisionId.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        contract: {},
      }),
      loadModelCatalog: async () => ({ models: [] }),
      checkHealth: async () => ({ available: true, state: 'healthy' }),
      now: () => clock,
      idleTtlMs: 5 * 60 * 1_000,
    });
    const ids = Array.from({ length: 5 }, (_, index) => (
      `d0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    ));
    for (const revisionId of ids) {
      cache.prewarm({ channelId: CHANNEL_ID, revisionId, contract: {} });
      await settle();
      clock += 1;
    }
    expect(cache.size).toBe(4);
    expect(cache.peekCompiled(CHANNEL_ID, ids[0])).toBeNull();
    clock += 5 * 60 * 1_000 + 1;
    expect(cache.size).toBe(0);
  });

  it('invalidates channel, revision, and runtime-status changes synchronously', async () => {
    const cache = createBotPrewarmCache({
      compileRevision: async () => ({ compiledHash: 'a'.repeat(64), contract: {} }),
      loadModelCatalog: async () => ({ models: [] }),
      checkHealth: async () => ({ available: true, state: 'healthy' }),
    });
    cache.prewarm({ channelId: CHANNEL_ID, revisionId: REVISION_ID, contract: {} });
    await settle();
    expect(cache.size).toBe(1);
    cache.invalidateRevision(REVISION_ID);
    expect(cache.size).toBe(0);
    cache.prewarm({ channelId: CHANNEL_ID, revisionId: REVISION_ID, contract: {} });
    await settle();
    cache.invalidateChannel(CHANNEL_ID);
    expect(cache.size).toBe(0);
    cache.prewarm({ channelId: CHANNEL_ID, revisionId: REVISION_ID, contract: {} });
    await settle();
    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });

  it('uses a 30-second catalog TTL, singleflight, and one forced refresh surface', async () => {
    let clock = 0;
    const loadModelCatalog = vi.fn(async () => ({ generation: loadModelCatalog.mock.calls.length }));
    const cache = createBotPrewarmCache({
      compileRevision: async () => ({ compiledHash: 'a'.repeat(64), contract: {} }),
      loadModelCatalog,
      checkHealth: async () => ({ available: true, state: 'healthy' }),
      now: () => clock,
      catalogTtlMs: 30_000,
    });

    const [first, shared] = await Promise.all([
      cache.getModelCatalog(),
      cache.getModelCatalog(),
    ]);
    expect(first).toEqual(shared);
    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
    clock = 29_999;
    await cache.getModelCatalog();
    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
    await cache.getModelCatalog({ force: true });
    expect(loadModelCatalog).toHaveBeenCalledTimes(2);
  });
});
