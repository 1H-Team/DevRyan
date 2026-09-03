import { describe, expect, it, vi } from 'vitest';

import { createMeridianProviderResetProbe } from './provider-reset-probe.js';

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

describe('Meridian provider reset probe', () => {
  it('answers null for non-Anthropic providers and external OpenCode without touching the network', async () => {
    const fetchImpl = createFetch();
    const probe = createMeridianProviderResetProbe({ buildOpenCodeUrl, fetchImpl });
    await expect(probe.resolveProviderReset({ providerId: 'openai', directory: '/workspace' })).resolves.toBeNull();
    await expect(probe.resolveProviderReset({ providerId: '', directory: '/workspace' })).resolves.toBeNull();

    const external = createMeridianProviderResetProbe({
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
    const probe = createMeridianProviderResetProbe({
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
    const missing = createMeridianProviderResetProbe({
      buildOpenCodeUrl,
      fetchImpl: createFetch({ providers: { providers: [] } }),
    });
    await expect(missing.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();

    const unsafe = createMeridianProviderResetProbe({
      buildOpenCodeUrl,
      fetchImpl: createFetch({ providers: providersPayload('https://api.anthropic.com') }),
    });
    await expect(unsafe.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();

    const quota = { current: jsonResponse({ buckets: [] }, 503) };
    const fetchImpl = vi.fn(async (url) => (
      String(url).includes('/config/providers') ? jsonResponse(providersPayload()) : quota.current
    ));
    const failing = createMeridianProviderResetProbe({ buildOpenCodeUrl, fetchImpl, now: () => 1_000 });
    await expect(failing.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();
    quota.current = jsonResponse({
      buckets: [{ type: 'five_hour', status: 'allowed', utilization: 0.2, resetsAt: RESET_FIVE_HOUR }],
    });
    await expect(failing.resolveProviderReset({ providerId: 'anthropic', directory: '' }))
      .resolves.toEqual({ limited: false, resetAt: RESET_FIVE_HOUR });
    // The providers lookup was cached; only the quota read repeated.
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const throwing = createMeridianProviderResetProbe({
      buildOpenCodeUrl,
      fetchImpl: vi.fn(async () => { throw new Error('offline'); }),
    });
    await expect(throwing.resolveProviderReset({ providerId: 'anthropic', directory: '' })).resolves.toBeNull();
  });
});
