import { beforeEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_RUNTIME_CAPABILITIES,
  DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT,
  RUNTIME_CAPABILITY_RETRY_MS,
  RuntimeCapabilityUnavailableError,
  assertRuntimeCapability,
  isRuntimeCapabilityEnabled,
  loadRuntimeCapabilities,
  beginRuntimeCapabilityRead,
  failRuntimeCapabilityRead,
  observeRuntimeCapabilityHealth,
  invalidateRuntimeCapabilities,
  refreshRuntimeCapabilities,
  parseRuntimeCapabilitySnapshot,
  resetRuntimeCapabilitiesForTests,
  resolveRuntimeCapability,
  useRuntimeCapabilityStore,
} from './runtime-capabilities';

const ALL_OFF = { share: false, mcpOAuth: false, sessionShell: false, lsp: false, messageEdit: false };
const ALL_ON = { share: true, mcpOAuth: true, sessionShell: true, lsp: true, messageEdit: true };

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const healthFetch = (body: unknown, status = 200) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse(body, status);
  };
  return { calls, fetchImpl };
};

describe('parseRuntimeCapabilitySnapshot', () => {
  test('keeps every capability unavailable when health has no valid openCode block', () => {
    expect(parseRuntimeCapabilitySnapshot({ status: 'ok' })).toBe(DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT);
    expect(parseRuntimeCapabilitySnapshot(null)).toBe(DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT);
    expect(parseRuntimeCapabilitySnapshot([])).toBe(DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT);
    expect(parseRuntimeCapabilitySnapshot({ openCode: 'gen2' })).toBe(DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT);
    expect(DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT.capabilities).toEqual(ALL_OFF);
  });

  test('rejects gen 1 even when it reports enabled capabilities', () => {
    const snapshot = parseRuntimeCapabilitySnapshot({ openCode: { generation: 1, capabilities: ALL_ON } });
    expect(snapshot).toEqual({ generation: null, capabilities: ALL_OFF, source: 'health' });
  });

  test('reads the gen 2 block as every capability off', () => {
    const snapshot = parseRuntimeCapabilitySnapshot({ openCode: { generation: 2, capabilities: ALL_OFF } });
    expect(snapshot).toEqual({ generation: 2, capabilities: ALL_OFF, source: 'health' });
  });

  test('only explicit gen 2 grants enable capabilities', () => {
    expect(parseRuntimeCapabilitySnapshot({ openCode: { generation: 1, capabilities: { share: false } } }).capabilities)
      .toEqual(ALL_OFF);
    expect(parseRuntimeCapabilitySnapshot({ openCode: { generation: 1 } }).capabilities).toEqual(ALL_OFF);
    expect(parseRuntimeCapabilitySnapshot({ openCode: { generation: 2, capabilities: { mcpOAuth: true } } }).capabilities)
      .toEqual({ ...ALL_OFF, mcpOAuth: true });
    expect(parseRuntimeCapabilitySnapshot({ openCode: { generation: 2, capabilities: { lsp: 'yes' } } }).capabilities)
      .toEqual(ALL_OFF);
  });

  test('an invalid generation fails closed like the server', () => {
    const snapshot = parseRuntimeCapabilitySnapshot({ openCode: { generation: null, capabilities: ALL_OFF } });
    expect(snapshot.generation).toBeNull();
    expect(snapshot.capabilities).toEqual(ALL_OFF);
    expect(parseRuntimeCapabilitySnapshot({ openCode: { generation: '2' } }).capabilities).toEqual(ALL_OFF);
    expect(parseRuntimeCapabilitySnapshot({ openCode: { generation: '2', capabilities: ALL_ON } }).capabilities).toEqual(ALL_OFF);
  });
});

describe('loadRuntimeCapabilities', () => {
  beforeEach(() => {
    resetRuntimeCapabilitiesForTests();
  });

  test('reads /health once and shares the in-flight request', async () => {
    const { calls, fetchImpl } = healthFetch({ openCode: { generation: 2, capabilities: ALL_OFF } });
    const [first, second] = await Promise.all([
      loadRuntimeCapabilities({ fetchImpl }),
      loadRuntimeCapabilities({ fetchImpl }),
    ]);
    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/health');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(useRuntimeCapabilityStore.getState().status).toBe('loaded');
    expect(isRuntimeCapabilityEnabled('share')).toBe(false);

    await loadRuntimeCapabilities({ fetchImpl });
    expect(calls).toHaveLength(1);
  });

  test('an explicit gen 2 grant enables the requested capability', async () => {
    const { fetchImpl } = healthFetch({ openCode: { generation: 2, capabilities: ALL_ON } });
    expect(await resolveRuntimeCapability('mcpOAuth', { fetchImpl })).toBe(true);
    await expect(assertRuntimeCapability('share', { fetchImpl })).resolves.toBeUndefined();
  });

  test('assertRuntimeCapability throws a typed error when the capability is off', async () => {
    const { fetchImpl } = healthFetch({ openCode: { generation: 2, capabilities: ALL_OFF } });
    let caught: unknown = null;
    try {
      await assertRuntimeCapability('mcpOAuth', { fetchImpl });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeCapabilityUnavailableError);
    expect((caught as RuntimeCapabilityUnavailableError).capability).toBe('mcpOAuth');
    expect((caught as RuntimeCapabilityUnavailableError).code).toBe('capability_unavailable');
  });

  test('a failed read keeps the defaults and retries only after the backoff', async () => {
    let clock = 1_000;
    const now = () => clock;
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new TypeError('network down');
    };

    expect(await resolveRuntimeCapability('share', { fetchImpl: failing, now })).toBe(false);
    expect(useRuntimeCapabilityStore.getState().status).toBe('failed');
    expect(useRuntimeCapabilityStore.getState().snapshot.capabilities).toEqual(DEFAULT_RUNTIME_CAPABILITIES);

    await loadRuntimeCapabilities({ fetchImpl: failing, now });
    expect(calls).toBe(1);

    clock += RUNTIME_CAPABILITY_RETRY_MS;
    const { fetchImpl } = healthFetch({ openCode: { generation: 2, capabilities: ALL_OFF } });
    expect(await resolveRuntimeCapability('share', { fetchImpl, now })).toBe(false);
  });

  test('a non-OK health response keeps the defaults', async () => {
    const { fetchImpl } = healthFetch({ openCode: { generation: 2, capabilities: ALL_OFF } }, 503);
    expect(await resolveRuntimeCapability('share', { fetchImpl })).toBe(false);
    expect(useRuntimeCapabilityStore.getState().status).toBe('failed');
  });

  test('force re-reads and keeps the snapshot reference when nothing changed', async () => {
    const { calls, fetchImpl } = healthFetch({ openCode: { generation: 2, capabilities: ALL_ON } });
    const first = await loadRuntimeCapabilities({ fetchImpl });
    const second = await loadRuntimeCapabilities({ fetchImpl, force: true });
    expect(calls).toHaveLength(2);
    expect(second).toBe(first);
  });

  test('same-URL runtime replacement updates identity without a page reload', async () => {
    const first = await loadRuntimeCapabilities(healthFetch({ openCode: {
      generation: 2, capabilities: ALL_ON, runtimeIdentity: 'server:1',
    } }));
    const revision = beginRuntimeCapabilityRead();
    const replacement = observeRuntimeCapabilityHealth({ openCode: {
      generation: 2, capabilities: ALL_OFF, runtimeIdentity: 'server:2',
    } }, revision);
    expect(replacement.runtimeIdentity).toBe('server:2');
    expect(replacement).not.toBe(first);
    expect(isRuntimeCapabilityEnabled('share')).toBe(false);
  });

  test('reconnect refresh fences a delayed response and its cleanup from the previous lifetime', async () => {
    let finishOld: (response: Response) => void = () => {};
    const old = loadRuntimeCapabilities({ fetchImpl: () => new Promise(resolve => { finishOld = resolve; }) });
    let finishNew: (response: Response) => void = () => {};
    const replacement = refreshRuntimeCapabilities({ fetchImpl: () => new Promise(resolve => { finishNew = resolve; }) });
    expect(isRuntimeCapabilityEnabled('share')).toBe(false);
    finishOld(jsonResponse({ openCode: { generation: 2, capabilities: ALL_ON, runtimeIdentity: 'old' } }));
    await old;
    expect(useRuntimeCapabilityStore.getState().status).toBe('loading');
    // The old finally must not clear the new lifetime's in-flight request.
    const joined = loadRuntimeCapabilities({ fetchImpl: async () => { throw new Error('must share'); } });
    expect(joined).toBe(replacement);
    finishNew(jsonResponse({ openCode: { generation: 2, capabilities: ALL_OFF, runtimeIdentity: 'new' } }));
    await replacement;
    expect(useRuntimeCapabilityStore.getState().snapshot.runtimeIdentity).toBe('new');
  });

  test('late health success and failure cannot overwrite a newer authoritative read', async () => {
    let failOld: (error: Error) => void = () => {};
    const old = loadRuntimeCapabilities({ fetchImpl: () => new Promise((_resolve, reject) => { failOld = reject; }) });
    const staleRead = beginRuntimeCapabilityRead();
    const currentRead = beginRuntimeCapabilityRead();
    observeRuntimeCapabilityHealth({ openCode: { generation: 2, runtimeIdentity: 'current' } }, currentRead);
    observeRuntimeCapabilityHealth({ openCode: { generation: 2, runtimeIdentity: 'stale' } }, staleRead);
    failOld(new Error('old request failed'));
    await old;
    expect(useRuntimeCapabilityStore.getState().status).toBe('loaded');
    expect(useRuntimeCapabilityStore.getState().snapshot.runtimeIdentity).toBe('current');
  });

  test('failed replacement read keeps capabilities unavailable until retry succeeds', async () => {
    await loadRuntimeCapabilities(healthFetch({ openCode: { generation: 2, capabilities: ALL_ON } }));
    invalidateRuntimeCapabilities();
    await loadRuntimeCapabilities({ fetchImpl: async () => { throw new Error('replacement not ready'); } });
    expect(isRuntimeCapabilityEnabled('share')).toBe(false);
    expect(useRuntimeCapabilityStore.getState().status).toBe('failed');
  });

  test('failed newer client readiness read releases loading state and a forced read recovers', async () => {
    let finishOld: (response: Response) => void = () => {};
    const old = loadRuntimeCapabilities({ fetchImpl: () => new Promise(resolve => { finishOld = resolve; }) });
    const newer = beginRuntimeCapabilityRead();
    failRuntimeCapabilityRead(newer);
    expect(useRuntimeCapabilityStore.getState().status).toBe('failed');
    const recovered = await loadRuntimeCapabilities({ ...healthFetch({ openCode: {
      generation: 2, runtimeIdentity: 'replacement',
    } }), force: true });
    finishOld(jsonResponse({ openCode: { generation: 2, runtimeIdentity: 'old' } }));
    await old;
    expect(useRuntimeCapabilityStore.getState().status).toBe('loaded');
    expect(useRuntimeCapabilityStore.getState().snapshot).toBe(recovered);
  });

  test('malformed replacement health revokes grants and remains retryable', async () => {
    await loadRuntimeCapabilities(healthFetch({ openCode: { generation: 2, capabilities: ALL_ON } }));
    expect(isRuntimeCapabilityEnabled('share')).toBe(true);
    await loadRuntimeCapabilities({ ...healthFetch({ status: 'ok' }), force: true });
    expect(isRuntimeCapabilityEnabled('share')).toBe(false);
    expect(useRuntimeCapabilityStore.getState().status).toBe('failed');
  });

  test('an unsupported runtime cannot retain earlier gen 2 grants', async () => {
    await loadRuntimeCapabilities(healthFetch({ openCode: { generation: 2, capabilities: ALL_ON } }));
    await loadRuntimeCapabilities({ ...healthFetch({ openCode: { generation: 1, capabilities: ALL_ON } }), force: true });
    expect(useRuntimeCapabilityStore.getState().snapshot).toBe(DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT);
    expect(useRuntimeCapabilityStore.getState().status).toBe('failed');
  });
});
