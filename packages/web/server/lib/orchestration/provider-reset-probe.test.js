import { describe, expect, it, vi } from 'vitest';

import { createMeridianProviderResetProbe } from './provider-reset-probe.js';
import { createNativeConsumerFixture } from '../opencode/test-native-consumer-client.js';

// Meridian reports epoch milliseconds; quota transformers treat smaller numbers
// as seconds, so the fixtures stay in the millisecond range.
const RESET_FIVE_HOUR = 1_760_000_050_000;
const RESET_SEVEN_DAY = 1_760_000_090_000;

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

const providersPayload = (baseURL = 'http://127.0.0.1:3456') => ({
  providers: [{ id: 'anthropic', options: { baseURL } }],
});

const createFetch = ({ providers = providersPayload(), quota = { buckets: [] }, quotaStatus = 200 } = {}) => (
  vi.fn(async (url) => {
    const target = String(url);
    if (target.includes('/config/providers')) return jsonResponse(providers);
    if (target.endsWith('/v1/usage/quota')) return jsonResponse(quota, quotaStatus);
    throw new Error(`unexpected fetch ${target}`);
  })
);

const buildOpenCodeUrl = (pathname) => `http://127.0.0.1:4096${pathname}`;

const createNativeProbe = (options) => createMeridianProviderResetProbe({
  ...options,
  openCodeClient: createNativeConsumerFixture({
    baseUrl: 'http://127.0.0.1:4096',
    readFixture: options.fetchImpl,
    headers: options.getOpenCodeAuthHeaders,
  }),
});

describe('Meridian provider reset probe', () => {
  it('answers null for non-Anthropic providers and external OpenCode without touching the network', async () => {
    const fetchImpl = createFetch();
    const probe = createNativeProbe({ buildOpenCodeUrl, fetchImpl });
    await expect(probe.resolveProviderReset({ providerId: 'openai', directory: '/workspace' })).resolves.toBeNull();
    await expect(probe.resolveProviderReset({ providerId: '', directory: '/workspace' })).resolves.toBeNull();

    const external = createNativeProbe({
      buildOpenCodeUrl,
      isExternalOpenCode: () => true,
      fetchImpl,
    });
    await expect(external.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the limited signal from Meridian buckets, single-flights, and caches it per proxy for the TTL', async () => {
    let at = 10_000;
    const fetchImpl = createFetch({
      quota: {
        buckets: [
          { type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: RESET_FIVE_HOUR },
          { type: 'seven_day', status: 'allowed', utilization: 0.4, resetsAt: RESET_SEVEN_DAY },
        ],
      },
    });
    const probe = createNativeProbe({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer token' }),
      fetchImpl,
      now: () => at,
      ttlMs: 60_000,
    });

    const [first, second] = await Promise.all([
      probe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' }),
      probe.resolveProviderReset({ providerId: 'claude', directory: '/workspace' }),
    ]);
    expect(first).toEqual({ limited: true, resetAt: RESET_FIVE_HOUR });
    expect(second).toEqual(first);
    // One providers lookup and one quota read serve the concurrent pair.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:4096/config/providers?directory=%2Fworkspace');
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ authorization: 'Bearer token' });
    expect(fetchImpl.mock.calls[1][0]).toBe('http://127.0.0.1:3456/v1/usage/quota');

    at += 30_000;
    await expect(probe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' }))
      .resolves.toEqual({ limited: true, resetAt: RESET_FIVE_HOUR });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    at += 31_000;
    await expect(probe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' }))
      .resolves.toEqual({ limited: true, resetAt: RESET_FIVE_HOUR });
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    probe.clear();
    await expect(probe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' }))
      .resolves.toEqual({ limited: true, resetAt: RESET_FIVE_HOUR });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('answers null when the proxy is missing, unsafe, or the quota read fails, without caching the failure', async () => {
    const missing = createNativeProbe({
      buildOpenCodeUrl,
      fetchImpl: createFetch({ providers: { providers: [] } }),
    });
    await expect(missing.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();

    const unsafe = createNativeProbe({
      buildOpenCodeUrl,
      fetchImpl: createFetch({ providers: providersPayload('https://api.anthropic.com') }),
    });
    await expect(unsafe.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();

    const quota = { current: jsonResponse({ buckets: [] }, 503) };
    const fetchImpl = vi.fn(async (url) => (
      String(url).includes('/config/providers') ? jsonResponse(providersPayload()) : quota.current
    ));
    const failing = createNativeProbe({ buildOpenCodeUrl, fetchImpl, now: () => 1_000 });
    await expect(failing.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();
    quota.current = jsonResponse({
      buckets: [{ type: 'five_hour', status: 'allowed', utilization: 0.2, resetsAt: RESET_FIVE_HOUR }],
    });
    await expect(failing.resolveProviderReset({ providerId: 'anthropic', directory: '' }))
      .resolves.toEqual({ limited: false, resetAt: RESET_FIVE_HOUR });
    // The providers lookup was cached; only the quota read repeated.
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const throwing = createNativeProbe({
      buildOpenCodeUrl,
      fetchImpl: vi.fn(async () => { throw new Error('offline'); }),
    });
    await expect(throwing.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();
  });
});

describe('Meridian provider reset probe on gen 2 (openCodeClient)', () => {
  const createClient = ({ generation = 2, catalog = providersPayload() } = {}) => ({
    generation: vi.fn(() => {
      if (generation instanceof Error) throw generation;
      return generation;
    }),
    catalog: {
      providers: vi.fn(async () => {
        if (catalog instanceof Error) throw catalog;
        return catalog;
      }),
    },
  });

  it('rejects an injected client that is not an openCodeClient', () => {
    expect(() => createMeridianProviderResetProbe({ buildOpenCodeUrl, openCodeClient: {} }))
      .toThrow('openCodeClient must be an openCodeClient');
  });

  it('reads the Anthropic proxy from the client catalog, caches it per directory, and never asks /config/providers', async () => {
    let at = 10_000;
    const fetchImpl = createFetch({
      quota: { buckets: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: RESET_FIVE_HOUR }] },
    });
    const openCodeClient = createClient();
    const probe = createMeridianProviderResetProbe({
      buildOpenCodeUrl, fetchImpl, openCodeClient, now: () => at, ttlMs: 60_000,
    });

    const [first, second] = await Promise.all([
      probe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' }),
      probe.resolveProviderReset({ providerId: 'claude', directory: '/workspace' }),
    ]);
    expect(first).toEqual({ limited: true, resetAt: RESET_FIVE_HOUR });
    expect(second).toEqual(first);
    expect(openCodeClient.catalog.providers).toHaveBeenCalledTimes(1);
    expect(openCodeClient.catalog.providers).toHaveBeenCalledWith({ directory: '/workspace' });
    // Only the Meridian quota read uses fetch; OpenCode is reached through the client.
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(['http://127.0.0.1:3456/v1/usage/quota']);

    at += 61_000;
    await probe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' });
    expect(openCodeClient.catalog.providers).toHaveBeenCalledTimes(2);

    probe.clear();
    await probe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' });
    expect(openCodeClient.catalog.providers).toHaveBeenCalledTimes(3);
  });

  it('answers null for a missing or unsafe proxy and for client failures, without caching the failure', async () => {
    const missing = createMeridianProviderResetProbe({
      buildOpenCodeUrl, fetchImpl: createFetch(), openCodeClient: createClient({ catalog: { providers: [] } }),
    });
    await expect(missing.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' })).resolves.toBeNull();

    const unsafe = createMeridianProviderResetProbe({
      buildOpenCodeUrl,
      fetchImpl: createFetch(),
      openCodeClient: createClient({ catalog: providersPayload('https://api.anthropic.com') }),
    });
    await expect(unsafe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' })).resolves.toBeNull();

    const failing = createClient({ catalog: Object.assign(new Error('location required'), { code: 'opencode_location_required' }) });
    const probe = createMeridianProviderResetProbe({ buildOpenCodeUrl, fetchImpl: createFetch(), openCodeClient: failing });
    await expect(probe.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();
    await expect(probe.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();
    expect(failing.catalog.providers).toHaveBeenCalledTimes(2);
    expect(failing.catalog.providers).toHaveBeenLastCalledWith({});
  });

  it('refuses generation 1 and unknown generations without catalog or network access', async () => {
    const fetchImpl = createFetch();
    const gen1 = createClient({ generation: 1 });
    const probe = createMeridianProviderResetProbe({ buildOpenCodeUrl, fetchImpl, openCodeClient: gen1 });
    await expect(probe.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' })).resolves.toBeNull();
    expect(gen1.catalog.providers).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const unknownFetch = createFetch();
    const unknown = createClient({ generation: new Error('The OpenCode runtime generation is unknown') });
    const failClosed = createMeridianProviderResetProbe({ buildOpenCodeUrl, fetchImpl: unknownFetch, openCodeClient: unknown });
    await expect(failClosed.resolveProviderReset({ providerId: 'anthropic', directory: '/workspace' })).resolves.toBeNull();
    expect(unknownFetch).not.toHaveBeenCalled();
    expect(unknown.catalog.providers).not.toHaveBeenCalled();
  });
});
