import { createNativeConsumerFixture } from './test-native-consumer-client.js';
const createXaiToolCatalogRuntime = (options = {}) => {
  const client = options.openCodeClient ?? createNativeConsumerFixture({
    readFixture: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)), headers: options.getOpenCodeAuthHeaders,
  });
  if (!options.openCodeClient) {
    const read = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    const headers = options.getOpenCodeAuthHeaders ?? (() => ({}));
    client.catalog.tools = async (query, options = {}) => {
      const auth = await headers();
      options.signal.throwIfAborted();
      const response = await read(`http://opencode.test/experimental/tool?directory=${encodeURIComponent(query.directory)}&provider=${query.providerID}&model=${query.modelID}`,
        { method: 'GET', headers: { Accept: 'application/json', ...auth }, signal: options.signal });
      if (!response?.ok) throw Object.assign(new Error('Native fixture refused'), { statusCode: response?.status ?? 503 });
      return { definitions: await response.json() };
    };
  }
  return createXaiToolCatalogRuntimeNative({ ...options, openCodeClient: client });
};
import { describe, expect, it, vi } from 'vitest';

import { createXaiToolCatalogRuntime as createXaiToolCatalogRuntimeNative } from './xai-tool-catalog-runtime.js';

const response = (payload) => ({
  ok: true,
  json: vi.fn(async () => payload),
});
const modelInput = { directory: '/repo', providerID: 'xai', modelID: 'grok-4.6' };
const providerPayload = { providers: [{ id: 'xai', models: { 'grok-4.6': {} } }] };
const duplicateCatalog = [
  { id: 'search', description: 'Search', parameters: {} },
  { id: 'mcp__context__search', description: 'Search', parameters: {} },
];

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

  it.each([0, 1])('cancelling caller %i leaves the shared job and other caller running', async (cancelledIndex) => {
    let resolveFetch;
    let fetchSignal;
    const runtime = createXaiToolCatalogRuntime({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      fetchImpl: vi.fn((_, { signal }) => {
        fetchSignal = signal;
        return new Promise((resolve) => { resolveFetch = resolve; });
      }),
    });
    const callers = [new AbortController(), new AbortController()];
    const removeListeners = callers.map(({ signal }) => vi.spyOn(signal, 'removeEventListener'));
    const jobs = callers.map(({ signal }) => runtime.refreshModel({ ...modelInput, signal }));
    const sharedJob = runtime.refreshModel(modelInput);
    expect(sharedJob).toBe(runtime.refreshModel(modelInput));
    await Promise.resolve();

    const reason = new Error('Caller stopped waiting');
    callers[cancelledIndex].abort(reason);
    await expect(jobs[cancelledIndex]).rejects.toBe(reason);
    expect(fetchSignal.aborted).toBe(false);
    resolveFetch(response([]));
    await expect(jobs[1 - cancelledIndex]).resolves.toEqual({});
    await expect(sharedJob).resolves.toEqual({});
    for (const removeListener of removeListeners) expect(removeListener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('an already-cancelled caller starts no job', async () => {
    const fetchImpl = vi.fn();
    const runtime = createXaiToolCatalogRuntime({ fetchImpl });
    const caller = new AbortController();
    caller.abort();
    await expect(runtime.refreshModel({ ...modelInput, signal: caller.signal })).rejects.toBe(caller.signal.reason);
    expect(fetchImpl).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it.each(['headers', 'fetch', 'body'])('bounds hanging %s and fences late results after retry', async (stage) => {
    vi.useFakeTimers();
    try {
      let resolveBlocked;
      const blocked = new Promise((resolve) => { resolveBlocked = resolve; });
      const getOpenCodeAuthHeaders = vi.fn(async () => ({}));
      const fetchImpl = vi.fn(async () => response([]));
      if (stage === 'headers') getOpenCodeAuthHeaders.mockImplementationOnce(() => blocked);
      if (stage === 'fetch') fetchImpl.mockImplementationOnce(() => blocked);
      if (stage === 'body') fetchImpl.mockImplementationOnce(async () => ({ ok: true, json: () => blocked }));
      const runtime = createXaiToolCatalogRuntime({
        fetchImpl, getOpenCodeAuthHeaders,
        buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
        logger: { warn: vi.fn() },
      });
      const job = runtime.refreshModel(modelInput);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(job).resolves.toBeNull();
      await expect(runtime.refreshModel(modelInput)).resolves.toEqual({});
      resolveBlocked(stage === 'headers' ? {} : stage === 'fetch' ? response(duplicateCatalog) : duplicateCatalog);
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.getPromptToolOverrides(modelInput)).toEqual({});
      expect(fetchImpl).toHaveBeenCalledTimes(stage === 'headers' ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports valid empty catalogs as success and failed or invalid catalogs as failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce(response({ tools: [] }));
    const runtime = createXaiToolCatalogRuntime({
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      logger: { warn: vi.fn() },
    });
    const input = { directory: '/repo', payload: providerPayload };
    await expect(runtime.refreshProviderPayload(input)).resolves.toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(runtime.refreshProviderPayload(input)).resolves.toBe(false);
    }
    runtime.dispose();
  });

  it('bounds private provider discovery and cancels its transport with its caller', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise(() => {}));
      const runtime = createXaiToolCatalogRuntime({
        fetchImpl,
        buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
        logger: { warn: vi.fn() },
      });
      const job = runtime.refreshDirectory({ directory: '/repo' });
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(job).resolves.toBe(false);
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);

      const caller = new AbortController();
      const cancelled = runtime.refreshDirectory({ directory: '/repo', signal: caller.signal });
      await Promise.resolve();
      caller.abort();
      await expect(cancelled).resolves.toBe(false);
      expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes owned jobs, fences late cache writes, and cannot restart periodic refresh', async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch;
      const blocked = new Promise((resolve) => { resolveFetch = resolve; });
      const fetchImpl = vi.fn(() => blocked);
      const runtime = createXaiToolCatalogRuntime({
        fetchImpl,
        buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
        logger: { warn: vi.fn() },
      });
      const model = runtime.refreshModel(modelInput);
      const discovery = runtime.refreshDirectory({ directory: '/repo' });
      runtime.startPeriodicRefresh({ intervalMs: 1_000 });
      await Promise.resolve();
      runtime.dispose();
      await expect(model).resolves.toBeNull();
      await expect(discovery).resolves.toBe(false);
      for (const [, { signal }] of fetchImpl.mock.calls) expect(signal.aborted).toBe(true);

      resolveFetch(response(duplicateCatalog));
      runtime.startPeriodicRefresh({ intervalMs: 1_000 });
      await expect(runtime.refreshModel(modelInput)).resolves.toBeNull();
      await expect(runtime.refreshDirectory({ directory: '/repo' })).resolves.toBe(false);
      await expect(runtime.refreshProviderPayload({ payload: providerPayload })).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(runtime.getPromptToolOverrides(modelInput)).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

describe('xAI tool catalog runtime on OpenCode 2', () => {
  const gen2Client = ({ providers, tools, generation = 2 } = {}) => ({
    generation: () => generation,
    catalog: {
      providers: vi.fn(providers ?? (async () => ({ providers: [{ id: 'xai', models: { 'grok-4.6': { id: 'grok-4.6' } } }], default: {} }))),
      tools: vi.fn(tools ?? (async () => ({
        ids: ['ctx_search', 'mcp__context_mode__ctx_search'],
        definitions: [
          { id: 'ctx_search', description: 'Search context', parameters: { type: 'object' } },
          { id: 'mcp__context_mode__ctx_search', description: 'Search context', parameters: { type: 'object' } },
        ],
      }))),
    },
  });

  it('discovers Grok models and reads tool definitions from the host snapshot', async () => {
    const client = gen2Client();
    const fetchImpl = vi.fn();
    const runtime = createXaiToolCatalogRuntime({
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      openCodeClient: () => client,
      logger: { warn: vi.fn() },
    });

    expect(await runtime.refreshDirectory({ directory: '/repo' })).toBe(true);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.catalog.providers.mock.calls[0][0]).toEqual({ directory: '/repo' });
    expect(client.catalog.tools.mock.calls[0][0]).toEqual({ directory: '/repo', providerID: 'xai', modelID: 'grok-4.6' });
    expect(client.catalog.tools.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(runtime.getPromptToolOverrides(modelInput)).toEqual({ mcp__context_mode__ctx_search: false });
  });

  it('caches nothing when the snapshot fails and logs the failure', async () => {
    const warn = vi.fn();
    const client = gen2Client({ tools: async () => { throw Object.assign(new Error('catalog.tools failed (503)'), { statusCode: 503 }); } });
    const runtime = createXaiToolCatalogRuntime({ openCodeClient: client, logger: { warn } });

    expect(await runtime.refreshModel(modelInput)).toBeNull();
    expect(runtime.getPromptToolOverrides(modelInput)).toBeNull();
    expect(warn).toHaveBeenCalledWith('[XAI] Failed to refresh the Grok tool catalog:', 'catalog.tools failed (503)');
  });

  it('fails closed on unknown or generation 1 identities', async () => {
    const unknown = { generation: () => { throw new Error('unknown generation'); }, catalog: { tools: vi.fn(), providers: vi.fn() } };
    const fetchImpl = vi.fn();
    const failing = createXaiToolCatalogRuntime({
      fetchImpl, buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`, openCodeClient: unknown, logger: { warn: vi.fn() },
    });
    expect(await failing.refreshModel(modelInput)).toBeNull();
    expect(await failing.refreshDirectory({ directory: '/repo' })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    const gen1 = gen2Client({ generation: 1 });
    const legacyFetch = vi.fn(async () => response(duplicateCatalog));
    const legacy = createXaiToolCatalogRuntime({
      fetchImpl: legacyFetch, buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`, openCodeClient: gen1, logger: { warn: vi.fn() },
    });
    await legacy.refreshModel(modelInput);
    expect(gen1.catalog.tools).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });
});
