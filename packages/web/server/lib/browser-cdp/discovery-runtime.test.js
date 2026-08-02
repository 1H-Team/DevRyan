import { describe, expect, it } from 'vitest';

import {
  BROWSER_CDP_DISCOVERY_PATH,
  createBrowserCdpDiscoveryRuntime,
  isLoopbackSocketAddress,
  isMatchingDiscoveryToken,
  readBearerToken,
} from './discovery-runtime.js';

const createResponse = () => {
  const headers = new Map();
  return {
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
};

const createRequest = ({ address = '127.0.0.1', token = 'secret-token' } = {}) => ({
  socket: { remoteAddress: address },
  headers: token === null ? {} : { authorization: `Bearer ${token}` },
});

const createRuntime = (status, token = 'secret-token') => createBrowserCdpDiscoveryRuntime({
  getBridgeStatus: () => status,
  getDiscoveryToken: () => token,
});

describe('discovery helpers', () => {
  it('recognizes loopback peers only', () => {
    expect(isLoopbackSocketAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackSocketAddress('127.9.9.9')).toBe(true);
    expect(isLoopbackSocketAddress('::1')).toBe(true);
    expect(isLoopbackSocketAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackSocketAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackSocketAddress('')).toBe(false);
    expect(isLoopbackSocketAddress(undefined)).toBe(false);
  });

  it('compares tokens without leaking length mismatches as matches', () => {
    expect(isMatchingDiscoveryToken('abc', 'abc')).toBe(true);
    expect(isMatchingDiscoveryToken('abc', 'abd')).toBe(false);
    expect(isMatchingDiscoveryToken('abc', 'ab')).toBe(false);
    expect(isMatchingDiscoveryToken('', '')).toBe(false);
    expect(isMatchingDiscoveryToken('abc', undefined)).toBe(false);
  });

  it('reads bearer tokens case-insensitively', () => {
    expect(readBearerToken('Bearer abc')).toBe('abc');
    expect(readBearerToken('bearer  abc  ')).toBe('abc');
    expect(readBearerToken('Basic abc')).toBe('');
    expect(readBearerToken(undefined)).toBe('');
  });
});

describe('browser CDP discovery route', () => {
  it('registers on the documented path', () => {
    const routes = new Map();
    createRuntime({ state: 'ready', wsUrl: 'ws://127.0.0.1:1/x' }).attach({
      get(path, handler) { routes.set(path, handler); },
    });
    expect(routes.has(BROWSER_CDP_DISCOVERY_PATH)).toBe(true);
  });

  it('returns the ws url when the bridge is ready', async () => {
    const res = createResponse();
    await createRuntime({ state: 'ready', wsUrl: 'ws://127.0.0.1:51234/devtools/page/tok' })
      .handleRequest(createRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ state: 'ready', wsUrl: 'ws://127.0.0.1:51234/devtools/page/tok' });
    expect(res.getHeader('cache-control')).toContain('no-store');
    expect(res.getHeader('access-control-allow-origin')).toBeUndefined();
  });

  it('reports deterministic non-ready states without a ws url', async () => {
    for (const state of ['disabled', 'no_target', 'debugger_conflict', 'stopped']) {
      const res = createResponse();
      await createRuntime({ state }).handleRequest(createRequest(), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ state });
    }
  });

  it('never leaks a ws url for a non-ready state', async () => {
    const res = createResponse();
    await createRuntime({ state: 'no_target', wsUrl: 'ws://127.0.0.1:51234/devtools/page/tok' })
      .handleRequest(createRequest(), res);
    expect(res.body).toEqual({ state: 'no_target' });
  });

  it('rejects non-loopback peers with 404 before checking the bearer', () => {
    const res = createResponse();
    createRuntime({ state: 'ready', wsUrl: 'ws://127.0.0.1:1/x' })
      .handleRequest(createRequest({ address: '192.168.1.20' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ state: 'unavailable' });
  });

  it('rejects a missing or wrong bearer with 401', () => {
    const missing = createResponse();
    createRuntime({ state: 'ready', wsUrl: 'ws://127.0.0.1:1/x' })
      .handleRequest(createRequest({ token: null }), missing);
    expect(missing.statusCode).toBe(401);

    const wrong = createResponse();
    createRuntime({ state: 'ready', wsUrl: 'ws://127.0.0.1:1/x' })
      .handleRequest(createRequest({ token: 'not-the-token' }), wrong);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toEqual({ state: 'unauthorized' });
  });

  it('404s when no discovery token was provisioned (non-desktop runtimes)', () => {
    const res = createResponse();
    createBrowserCdpDiscoveryRuntime({
      getBridgeStatus: () => ({ state: 'ready', wsUrl: 'ws://127.0.0.1:1/x' }),
      getDiscoveryToken: () => '',
    }).handleRequest(createRequest(), res);
    expect(res.statusCode).toBe(404);
  });

  it('treats a missing bridge status as disabled', async () => {
    const res = createResponse();
    await createRuntime(null).handleRequest(createRequest(), res);
    expect(res.body).toEqual({ state: 'disabled' });
  });
});
