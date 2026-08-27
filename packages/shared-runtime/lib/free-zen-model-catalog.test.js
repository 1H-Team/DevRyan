import { describe, expect, it, mock } from 'bun:test';

import { createFreeZenModelCatalog } from './free-zen-model-catalog.js';

const jsonResponse = (body) => ({ ok: true, status: 200, json: mock(async () => body) });

describe('free Zen model catalog', () => {
  it('intersects served models with zero input and output cost', async () => {
    const fetchImpl = mock()
      .mockResolvedValueOnce(jsonResponse({
        data: [
          { id: 'nemotron-3.5-lightning-free', owned_by: 'nvidia' },
          { id: 'paid-model' },
          { id: 'missing-metadata' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        opencode: {
          models: {
            'nemotron-3.5-lightning-free': { cost: { input: 0, output: 0 } },
            'paid-model': { cost: { input: 1, output: 2 } },
          },
        },
      }));
    const catalog = createFreeZenModelCatalog({ fetchImpl });

    await expect(catalog.fetchModels()).resolves.toEqual([
      { id: 'nemotron-3.5-lightning-free', owned_by: 'nvidia' },
    ]);
  });

  it('shares an in-flight refresh and reuses the fresh result', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = mock(async (url) => {
      await gate;
      return String(url).includes('models.dev')
        ? jsonResponse({ opencode: { models: { 'free-a': { cost: { input: 0, output: 0 } } } } })
        : jsonResponse({ data: [{ id: 'free-a' }] });
    });
    const catalog = createFreeZenModelCatalog({ fetchImpl });

    const first = catalog.fetchModels();
    const second = catalog.fetchModels();
    release();

    expect(await first).toEqual([{ id: 'free-a' }]);
    expect(await second).toEqual([{ id: 'free-a' }]);
    await catalog.fetchModels();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps a stale snapshot available when refresh fails', async () => {
    let currentTime = 0;
    const fetchImpl = mock()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'free-a' }] }))
      .mockResolvedValueOnce(jsonResponse({ opencode: { models: { 'free-a': { cost: { input: 0, output: 0 } } } } }))
      .mockResolvedValueOnce({ ok: false, status: 503, json: mock() })
      .mockResolvedValueOnce(jsonResponse({}));
    const catalog = createFreeZenModelCatalog({
      fetchImpl,
      now: () => currentTime,
      ttlMs: 10,
    });
    await catalog.fetchModels();
    currentTime = 20;

    await expect(catalog.fetchModels()).rejects.toThrow('status 503');
    expect(catalog.getCachedModels()).toEqual([{ id: 'free-a' }]);
    expect(catalog.getSnapshot()?.fresh).toBe(false);
  });
});
