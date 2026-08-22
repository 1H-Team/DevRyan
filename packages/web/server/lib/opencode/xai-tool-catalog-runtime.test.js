import { describe, expect, it, vi } from 'vitest';

import { createXaiToolCatalogRuntime } from './xai-tool-catalog-runtime.js';

const response = (payload) => ({
  ok: true,
  json: vi.fn(async () => payload),
});

describe('xAI tool catalog runtime', () => {
  it('discovers Grok models and caches only verified duplicate overrides', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/config/providers')) {
        return response({
          providers: [{ id: 'xai', models: { 'grok-4.6': { id: 'grok-4.6' } } }],
        });
      }
      return response([
        { id: 'ctx_search', description: 'Search context', parameters: { type: 'object' } },
        { id: 'mcp__context_mode__ctx_search', description: 'Search context', parameters: { type: 'object' } },
        { id: 'unique', description: 'Unique', parameters: { type: 'object' } },
      ]);
    });
    const runtime = createXaiToolCatalogRuntime({
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test' }),
      logger: { warn: vi.fn() },
    });

    await runtime.refreshDirectory({ directory: '/repo' });

    expect(runtime.getPromptToolOverrides({
      directory: '/repo',
      providerID: 'xai',
      modelID: 'grok-4.6',
    })).toEqual({ mcp__context_mode__ctx_search: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/experimental/tool?'),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer test' }) }),
    );
  });

  it('deduplicates concurrent refreshes and caches fresh no-duplicate evidence', async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const runtime = createXaiToolCatalogRuntime({
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      logger: { warn: vi.fn() },
    });

    const first = runtime.refreshModel({ directory: '/repo', providerID: 'xai', modelID: 'grok-4.6' });
    const second = runtime.refreshModel({ directory: '/repo', providerID: 'xai', modelID: 'grok-4.6' });
    expect(first).toBe(second);
    await Promise.resolve();
    resolveFetch(response([]));
    await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runtime.getPromptToolOverrides({
      directory: '/repo', providerID: 'xai', modelID: 'grok-4.6',
    })).toEqual({});
  });

  it('periodically re-warms directories seen through explicit warms and prompt reads', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (url) => {
        const target = String(url);
        if (target.includes('/config/providers')) {
          return response({
            providers: [{ id: 'xai', models: { 'grok-4.6': { id: 'grok-4.6' } } }],
          });
        }
        return response([]);
      });
      const runtime = createXaiToolCatalogRuntime({
        fetchImpl,
        buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
        getOpenCodeAuthHeaders: () => ({}),
        logger: { warn: vi.fn() },
      });

      await runtime.refreshDirectory({ directory: '/repo' });
      const callsAfterInitialWarm = fetchImpl.mock.calls.length;

      runtime.startPeriodicRefresh({ intervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterInitialWarm);

      runtime.stopPeriodicRefresh();
      const callsAfterStop = fetchImpl.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchImpl.mock.calls.length).toBe(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops directories from the periodic set once their active window lapses', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (url) => {
        const target = String(url);
        if (target.includes('/config/providers')) {
          return response({ providers: [] });
        }
        return response([]);
      });
      const runtime = createXaiToolCatalogRuntime({
        fetchImpl,
        buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
        getOpenCodeAuthHeaders: () => ({}),
        logger: { warn: vi.fn() },
      });

      await runtime.refreshDirectory({ directory: '/repo' });
      const callsAfterInitialWarm = fetchImpl.mock.calls.length;

      // Past the one-hour active window with no further use: ticks stay silent.
      runtime.startPeriodicRefresh({ intervalMs: 61 * 60 * 1000 });
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      expect(fetchImpl.mock.calls.length).toBe(callsAfterInitialWarm);
      runtime.stopPeriodicRefresh();
    } finally {
      vi.useRealTimers();
    }
  });
});
