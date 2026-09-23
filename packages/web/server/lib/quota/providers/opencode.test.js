import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeZenDeviceFlows,
  fetchQuota,
  isConfigured,
  refreshOpenCodeZenCredential,
  resolveOpenCodeZenCredential,
  validateStoredOpenCodeZenCredential,
} from './opencode.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const ORG_ID = 'wrk_01K46JDFR0E75SG2Q8K172KF3Y';

const credential = (overrides = {}) => ({
  orgId: ORG_ID,
  accessToken: 'sess_current',
  refreshToken: 'rt_current',
  accessTokenExpiresAt: NOW + 3_600_000,
  ...overrides,
});

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify(payload),
});

// A console fake: billing/usage accept only `validAccessTokens`; refresh rotates tokens.
const createConsole = ({ validAccessTokens = ['sess_current'], refresh = 'rotate' } = {}) => {
  const calls = [];
  let rotations = 0;
  const fetchImpl = vi.fn(async (url, init = {}) => {
    calls.push(url);
    if (url.endsWith('/auth/device/token')) {
      if (refresh === 'invalid') return jsonResponse({ error: 'invalid_grant', error_description: 'x' }, 400);
      rotations += 1;
      const accessToken = `sess_rotated_${rotations}`;
      validAccessTokens.push(accessToken);
      return jsonResponse({ access_token: accessToken, refresh_token: `rt_rotated_${rotations}`, token_type: 'Bearer', expires_in: 3600 });
    }
    const token = init.headers?.Authorization?.replace(/^Bearer /, '');
    if (!validAccessTokens.includes(token)) return jsonResponse({ _tag: 'Unauthorized' }, 401);
    if (url.includes('/api/billing/status')) return jsonResponse({ balanceMicroCents: '2000000000', availableMicroCents: '2000000000' });
    if (url.includes('/api/usage/summary')) return jsonResponse({ totalCostMicroCents: '0' });
    throw new Error(`unexpected ${url}`);
  });
  return { calls, fetchImpl };
};

const createStore = (initial) => {
  let stored = initial;
  return {
    read: vi.fn(() => stored),
    write: vi.fn((_providerId, next) => { stored = next; }),
    current: () => stored,
    replace: (next) => { stored = next; },
  };
};

describe('OpenCode Zen quota provider', () => {
  it('discovers only the managed console credential and keeps retired credentials visible for reconnect', () => {
    const managed = credential();
    expect(resolveOpenCodeZenCredential({ readManagedCredential: () => managed, hasLegacyCredential: () => false }))
      .toEqual({ credential: managed, source: 'managed', reconnectRequired: false });
    expect(isConfigured({ readManagedCredential: () => managed, hasLegacyCredential: () => false })).toBe(true);
    expect(isConfigured({ readManagedCredential: () => null, hasLegacyCredential: () => false })).toBe(false);
    expect(isConfigured({ readManagedCredential: () => null, hasLegacyCredential: () => true })).toBe(true);
  });

  it('reports a reconnect for retired dashboard credentials without any request', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchQuota({
      readManagedCredential: () => null,
      hasLegacyCredential: () => true,
      fetchImpl,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: false, configured: true, errorCode: 'RECONNECT_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a live access token without refreshing', async () => {
    const store = createStore(credential());
    const consoleFake = createConsole();
    const result = await fetchQuota({
      readManagedCredential: store.read,
      writeManagedCredential: store.write,
      hasLegacyCredential: () => false,
      fetchImpl: consoleFake.fetchImpl,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: true, providerId: 'opencode' });
    expect(consoleFake.calls.some((url) => url.endsWith('/auth/device/token'))).toBe(false);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token first and persists the rotated pair', async () => {
    const store = createStore(credential({ accessToken: 'sess_expired', accessTokenExpiresAt: NOW + 30_000 }));
    const consoleFake = createConsole({ validAccessTokens: [] });
    const result = await fetchQuota({
      readManagedCredential: store.read,
      writeManagedCredential: store.write,
      hasLegacyCredential: () => false,
      fetchImpl: consoleFake.fetchImpl,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: true });
    expect(store.current()).toEqual({
      orgId: ORG_ID,
      accessToken: 'sess_rotated_1',
      refreshToken: 'rt_rotated_1',
      accessTokenExpiresAt: NOW + 3_600_000,
    });
  });

  it('retries once after a revoked access token and then reports reconnect when refresh is rejected', async () => {
    const store = createStore(credential({ accessToken: 'sess_revoked' }));
    const recovering = createConsole({ validAccessTokens: [] });
    expect(await fetchQuota({
      readManagedCredential: store.read,
      writeManagedCredential: store.write,
      hasLegacyCredential: () => false,
      fetchImpl: recovering.fetchImpl,
      now: () => NOW,
    })).toMatchObject({ ok: true });
    expect(recovering.calls.filter((url) => url.endsWith('/auth/device/token'))).toHaveLength(1);

    const deadStore = createStore(credential({ accessToken: 'sess_revoked' }));
    const dead = createConsole({ validAccessTokens: [], refresh: 'invalid' });
    const result = await fetchQuota({
      readManagedCredential: deadStore.read,
      writeManagedCredential: deadStore.write,
      hasLegacyCredential: () => false,
      fetchImpl: dead.fetchImpl,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: false, configured: true, errorCode: 'AUTHENTICATION_FAILED' });
    expect(result.error).not.toMatch(/sess_|rt_/);
    expect(deadStore.write).not.toHaveBeenCalled();
  });

  it('shares one refresh between concurrent callers so a rotated refresh token is used once', async () => {
    const store = createStore(credential());
    const consoleFake = createConsole();
    const options = { readManagedCredential: store.read, writeManagedCredential: store.write, fetchImpl: consoleFake.fetchImpl, now: () => NOW };
    const [first, second] = await Promise.all([
      refreshOpenCodeZenCredential(credential(), options),
      refreshOpenCodeZenCredential(credential(), options),
    ]);
    expect(first).toBe(second);
    expect(consoleFake.calls.filter((url) => url.endsWith('/auth/device/token'))).toHaveLength(1);
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it('never resurrects a credential disconnected while its refresh was in flight', async () => {
    const store = createStore(credential());
    const consoleFake = createConsole();
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith('/auth/device/token')) store.replace(null);
      return consoleFake.fetchImpl(url, init);
    });
    await expect(refreshOpenCodeZenCredential(credential(), {
      readManagedCredential: store.read,
      writeManagedCredential: store.write,
      fetchImpl,
      now: () => NOW,
    })).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
    expect(store.write).not.toHaveBeenCalled();
    expect(store.current()).toBeNull();
  });

  it('validates the stored credential with safe codes', async () => {
    await expect(validateStoredOpenCodeZenCredential({
      readManagedCredential: () => null,
      hasLegacyCredential: () => false,
      fetchImpl: vi.fn(),
      now: () => NOW,
    })).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED', status: 400 });
    await expect(validateStoredOpenCodeZenCredential({
      readManagedCredential: () => credential(),
      hasLegacyCredential: () => false,
      fetchImpl: async () => jsonResponse({ _tag: 'Forbidden' }, 403),
      now: () => NOW,
    })).rejects.toMatchObject({ code: 'WORKSPACE_INACCESSIBLE', status: 400 });
  });
});

describe('OpenCode Zen device sign-in flows', () => {
  const deviceStart = jsonResponse({
    device_code: 'device-secret',
    user_code: 'PPSQ-ZZSW',
    verification_uri: '/console/device',
    verification_uri_complete: '/console/device?user_code=PPSQ-ZZSW&client_id=devryan',
    expires_in: 900,
    interval: 5,
  });

  const createFlows = (tokenResponses, extra = {}) => {
    let clock = NOW;
    const written = [];
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/auth/device/code')) return deviceStart;
      if (url.endsWith('/auth/device/token')) return tokenResponses.shift();
      return extra.usage ?? (url.includes('/api/billing/status')
        ? jsonResponse({ balanceMicroCents: '0', availableMicroCents: '0' })
        : jsonResponse({ totalCostMicroCents: '0' }));
    });
    const flows = createOpenCodeZenDeviceFlows({
      fetchImpl,
      now: () => clock,
      randomUUID: () => `flow-${fetchImpl.mock.calls.length}`,
      writeManagedCredential: (_providerId, next) => written.push(next),
    });
    return { flows, written, fetchImpl, advance: (ms) => { clock += ms; } };
  };

  it('backs off on slow_down and ends on denial', async () => {
    const { flows, advance, fetchImpl } = createFlows([
      jsonResponse({ error: 'slow_down', error_description: 'x' }, 400),
      jsonResponse({ error: 'access_denied', error_description: 'x' }, 400),
    ]);
    const { flowId } = await flows.start();
    advance(5_000);
    expect(await flows.poll(flowId)).toEqual({ status: 'pending' });
    advance(5_000);
    // slow_down widened the interval to 10 s, so this poll stays local.
    expect(await flows.poll(flowId)).toEqual({ status: 'pending' });
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith('/auth/device/token'))).toHaveLength(1);
    advance(5_000);
    expect(await flows.poll(flowId)).toEqual({ status: 'denied' });
    await expect(flows.poll(flowId)).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' });
  });

  it('expires flows locally and requires a workspace-scoped approval', async () => {
    const expiring = createFlows([]);
    const first = await expiring.flows.start();
    expiring.advance(900_000);
    expect(await expiring.flows.poll(first.flowId)).toEqual({ status: 'expired' });

    const unscoped = createFlows([
      jsonResponse({ access_token: 'sess_new', refresh_token: 'rt_new', token_type: 'Bearer', expires_in: 3600 }),
    ]);
    const second = await unscoped.flows.start();
    unscoped.advance(5_000);
    await expect(unscoped.flows.poll(second.flowId)).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' });
    expect(unscoped.written).toEqual([]);
  });

  it('does not save an approval whose workspace the token cannot read', async () => {
    const { flows, advance, written } = createFlows([
      jsonResponse({ access_token: 'sess_new', refresh_token: 'rt_new', token_type: 'Bearer', expires_in: 3600, org_id: ORG_ID }),
    ], { usage: jsonResponse({ _tag: 'Forbidden' }, 403) });
    const { flowId } = await flows.start();
    advance(5_000);
    await expect(flows.poll(flowId)).rejects.toMatchObject({ code: 'WORKSPACE_INACCESSIBLE' });
    expect(written).toEqual([]);
  });
});
