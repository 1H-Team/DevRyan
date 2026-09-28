import { describe, expect, it, vi } from 'vitest';

import { createLocalBotCatalogTransport } from './local-catalog.js';

const TOKEN = 'aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl';
const context = (overrides = {}) => ({
  url: 'http://127.0.0.1:55130',
  token: TOKEN,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  generation: 1,
  ...overrides,
});
const objectStorage = () => ({
  storageUpload: vi.fn(async () => ({})),
  storageDownload: vi.fn(async () => Buffer.from('x')),
  storageDelete: vi.fn(async () => []),
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});
const refused = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
});
const reset = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
});
const manualTimers = () => {
  const pending = [];
  return {
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
    pending,
  };
};

describe('local Bot catalog transport', () => {
  it('reuses the REST client on bare PostgREST with a host-minted bearer token', async () => {
    const fetchImpl = vi.fn(async () => json([{ id: 'bot' }]));
    const transport = createLocalBotCatalogTransport({
      catalog: { getContext: vi.fn(async () => context()), ensure: vi.fn() },
      objectStorage: objectStorage(),
      fetchImpl,
    });

    await expect(transport.rest('bots', { query: { limit: 1 }, select: 'id' })).resolves.toEqual([{ id: 'bot' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:55130/bots?limit=1&select=id');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(transport.getState()).toMatchObject({ state: 'ready', generation: 1 });
  });

  it('refuses a non-loopback or malformed catalog context', async () => {
    for (const bad of [
      context({ url: 'http://192.168.1.2:55130' }),
      context({ url: 'https://127.0.0.1:55130' }),
      context({ url: 'http://127.0.0.1:55130/rest' }),
      context({ token: 'opaque' }),
      context({ generation: 'one' }),
    ]) {
      const transport = createLocalBotCatalogTransport({
        catalog: { getContext: vi.fn(async () => bad), ensure: vi.fn() },
        objectStorage: objectStorage(),
        fetchImpl: vi.fn(),
        setTimer: () => ({ unref() {} }),
      });
      await expect(transport.rpc('devryan_bot_schema_version')).rejects.toMatchObject({
        code: 'bot_database_context_invalid', status: 503,
      });
    }
  });

  it('refreshes a rejected token once because the request never executed', async () => {
    const getContext = vi.fn()
      .mockResolvedValueOnce(context({ generation: 1 }))
      .mockResolvedValueOnce(context({ generation: 2 }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ code: 'PGRST303', message: 'JWT expired' }, 401))
      .mockResolvedValueOnce(json({ id: 'row' }));
    const transport = createLocalBotCatalogTransport({
      catalog: { getContext, ensure: vi.fn() },
      objectStorage: objectStorage(),
      fetchImpl,
    });

    await expect(transport.rest('bots', { method: 'POST', body: { id: 'x' }, single: true })).resolves.toEqual({ id: 'row' });
    expect(getContext).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(transport.getState()).toMatchObject({ state: 'ready', generation: 2 });
  });

  it('retries a refused connection but never replays an ambiguous mutation', async () => {
    const timers = manualTimers();
    const getContext = vi.fn(async () => context());
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(json({ id: 'first' }))
      .mockRejectedValueOnce(reset());
    const transport = createLocalBotCatalogTransport({
      catalog: { getContext, ensure: vi.fn() },
      objectStorage: objectStorage(),
      fetchImpl,
      ...timers,
    });

    await expect(transport.rest('bots', { method: 'POST', body: {}, single: true })).resolves.toEqual({ id: 'first' });
    await expect(transport.rest('bots', { method: 'PATCH', body: {}, single: true })).rejects.toMatchObject({
      code: 'bot_database_unavailable', status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(transport.getState()).toMatchObject({ state: 'unavailable', code: 'bot_database_unavailable' });
    // One readiness engine schedules the restart; nothing else retries.
    expect(timers.pending).toHaveLength(1);
  });

  it('retries a read once after an ambiguous transport failure', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(json([]));
    const transport = createLocalBotCatalogTransport({
      catalog: { getContext: vi.fn(async () => context()), ensure: vi.fn() },
      objectStorage: objectStorage(),
      fetchImpl,
    });
    await expect(transport.rest('bots')).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('starts an existing installation through the host and classifies its failures', async () => {
    const getContext = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('not ready'), { code: 'bot_database_unavailable' }))
      .mockResolvedValueOnce(context());
    const ensure = vi.fn(async () => ({ state: 'healthy' }));
    const fetchImpl = vi.fn(async () => json('20260908182901'));
    const transport = createLocalBotCatalogTransport({
      catalog: { getContext, ensure },
      objectStorage: objectStorage(),
      fetchImpl,
    });
    await expect(transport.ensureStarted()).resolves.toMatchObject({ state: 'ready' });
    expect(ensure).toHaveBeenCalledTimes(1);

    for (const [code, state] of [
      ['bot_database_volume_missing', 'recovery_required'],
      ['bot_database_schema_newer', 'recovery_required'],
      ['bot_runtime_setup_required', 'setup_required'],
      ['bot_runtime_update_required', 'update_required'],
      ['bot_runtime_operation_busy', 'starting'],
      ['bot_runtime_docker_unavailable', 'unavailable'],
    ]) {
      const timers = manualTimers();
      const failing = createLocalBotCatalogTransport({
        catalog: {
          getContext: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'bot_database_unavailable' }); }),
          ensure: vi.fn(async () => { throw Object.assign(new Error('x'), { code }); }),
        },
        objectStorage: objectStorage(),
        fetchImpl: vi.fn(),
        ...timers,
      });
      await expect(failing.ensureStarted()).rejects.toMatchObject({ code });
      expect(failing.getState()).toMatchObject({ state, code });
      failing.scheduleStart();
      // Recovery requires the owner; it is never retried automatically.
      expect(timers.pending.length > 0).toBe(state !== 'recovery_required');
    }
  });

  it('restarts an unavailable catalog on request without waiting out the backoff', async () => {
    const timers = manualTimers();
    let dockerRunning = false;
    const getContext = vi.fn(async () => {
      if (!dockerRunning) throw Object.assign(new Error('not ready'), { code: 'bot_database_unavailable' });
      return context();
    });
    const ensure = vi.fn(async () => {
      if (!dockerRunning) throw Object.assign(new Error('Docker is stopped'), { code: 'bot_runtime_docker_unavailable' });
      return { state: 'healthy' };
    });
    const transport = createLocalBotCatalogTransport({
      catalog: { getContext, ensure },
      objectStorage: objectStorage(),
      fetchImpl: vi.fn(async () => json('20260908182901')),
      logger: null,
      ...timers,
    });

    // Still starting: nothing to retry yet.
    expect(transport.retryNow()).toBe(false);
    await expect(transport.ensureStarted()).rejects.toMatchObject({ code: 'bot_runtime_docker_unavailable' });
    expect(transport.getState()).toMatchObject({ state: 'unavailable' });

    // A retry while Docker is still stopped fails and leaves one backoff timer.
    expect(transport.retryNow()).toBe(true);
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(transport.getState()).toMatchObject({ state: 'unavailable' });

    dockerRunning = true;
    expect(transport.retryNow()).toBe(true);
    await vi.waitFor(() => expect(transport.getState()).toMatchObject({ state: 'ready' }));
    expect(timers.pending).toHaveLength(1);
    expect(transport.retryNow()).toBe(false);
  });

  it('never restarts a catalog that needs an owner action', async () => {
    for (const code of ['bot_database_volume_missing', 'bot_runtime_setup_required', 'bot_runtime_update_required']) {
      const ensure = vi.fn(async () => { throw Object.assign(new Error('x'), { code }); });
      const transport = createLocalBotCatalogTransport({
        catalog: {
          getContext: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'bot_database_unavailable' }); }),
          ensure,
        },
        objectStorage: objectStorage(),
        fetchImpl: vi.fn(),
        ...manualTimers(),
      });
      await expect(transport.ensureStarted()).rejects.toMatchObject({ code });
      expect(transport.retryNow()).toBe(false);
      expect(ensure).toHaveBeenCalledTimes(1);
    }

    const maintained = createLocalBotCatalogTransport({
      catalog: { getContext: vi.fn(async () => context()), ensure: vi.fn() },
      objectStorage: objectStorage(),
      fetchImpl: vi.fn(async () => json('20260908182901')),
    });
    await maintained.ensureStarted();
    maintained.enterMaintenance('bots_maintenance_restore');
    expect(maintained.retryNow()).toBe(false);
  });

  it('holds maintenance until explicitly resumed and notifies listeners', async () => {
    const transport = createLocalBotCatalogTransport({
      catalog: { getContext: vi.fn(async () => context({ generation: 7 })), ensure: vi.fn() },
      objectStorage: objectStorage(),
      fetchImpl: vi.fn(async () => json('20260908182901')),
    });
    const changes = [];
    transport.onChange((next) => changes.push(next.state));
    await transport.ensureStarted();
    transport.enterMaintenance('bots_maintenance_restore');
    expect(transport.getState()).toMatchObject({ state: 'maintenance', code: 'bots_maintenance_restore' });
    await transport.leaveMaintenance();
    expect(changes).toEqual(['ready', 'maintenance', 'starting', 'ready']);
  });

  it('delegates storage to the encrypted-file adapter without HTTP', async () => {
    const storage = objectStorage();
    const fetchImpl = vi.fn();
    const transport = createLocalBotCatalogTransport({
      catalog: { getContext: vi.fn(), ensure: vi.fn() },
      objectStorage: storage,
      fetchImpl,
    });
    await transport.storageUpload('devryan-bot-objects', 'objects/x.bin', Buffer.from('c'));
    await transport.storageDownload('devryan-bot-objects', 'objects/x.bin');
    await transport.storageDelete('devryan-bot-objects', ['objects/x.bin']);
    expect(storage.storageUpload).toHaveBeenCalledTimes(1);
    expect(storage.storageDownload).toHaveBeenCalledTimes(1);
    expect(storage.storageDelete).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
