import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_INSTANCE_MAX_URLS,
  createLocalInstanceStatusRuntime,
  probeTcpEndpoint,
} from './local-instances-runtime.js';

const createSocketNet = () => {
  const sockets = [];
  const net = {
    createConnection(options) {
      const socket = new EventEmitter();
      socket.options = options;
      socket.destroyedByRuntime = false;
      socket.setTimeout = vi.fn();
      socket.destroy = vi.fn(() => {
        socket.destroyedByRuntime = true;
      });
      sockets.push(socket);
      return socket;
    },
  };
  return { net, sockets };
};

const createRouteHarness = ({ runtime, originAllowed = true, uiAuthController = null } = {}) => {
  let handler;
  const app = {
    post(path, ...handlers) {
      expect(path).toBe('/api/preview/local-instances/status');
      handler = handlers.at(-1);
    },
  };
  runtime.attach(app, {
    express: { json: () => (_req, _res, next) => next() },
    uiAuthController,
    isRequestOriginAllowed: async () => originAllowed,
  });

  const request = async (body) => {
    const response = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return payload;
      },
    };
    await handler({ body }, response);
    return response;
  };

  return { request };
};

describe('local instance TCP probe', () => {
  it.each([
    ['connect', true],
    ['timeout', false],
    ['error', false],
  ])('settles %s and always destroys the socket', async (eventName, expected) => {
    const { net, sockets } = createSocketNet();
    const pending = probeTcpEndpoint({ net, host: '127.0.0.1', port: 5173, timeoutMs: 500 });

    expect(sockets).toHaveLength(1);
    expect(sockets[0].setTimeout).toHaveBeenCalledWith(500);
    sockets[0].emit(eventName, eventName === 'error' ? new Error('refused') : undefined);

    await expect(pending).resolves.toBe(expected);
    expect(sockets[0].destroy).toHaveBeenCalledTimes(1);
  });
});

describe('local instance status runtime', () => {
  it('normalizes loopback aliases, preserves order, and reports mixed results', async () => {
    const probeEndpoint = vi.fn(async ({ port }) => port === 3001);
    const runtime = createLocalInstanceStatusRuntime({ probeEndpoint, concurrency: 2 });

    await expect(runtime.checkUrls([
      'http://localhost:3001/path',
      'http://127.0.0.1:5180/',
      'https://example.com/',
      'file:///tmp/index.html',
    ])).resolves.toEqual([
      {
        url: 'http://localhost:3001/path',
        origin: 'http://127.0.0.1:3001',
        status: 'reachable',
      },
      {
        url: 'http://127.0.0.1:5180/',
        origin: 'http://127.0.0.1:5180',
        status: 'unreachable',
      },
      { url: 'https://example.com/', origin: null, status: 'invalid' },
      { url: 'file:///tmp/index.html', origin: null, status: 'invalid' },
    ]);

    expect(probeEndpoint).toHaveBeenCalledTimes(2);
  });

  it('uses default HTTP and HTTPS ports', async () => {
    const probeEndpoint = vi.fn(async () => true);
    const runtime = createLocalInstanceStatusRuntime({ probeEndpoint });

    await runtime.checkUrls(['http://127.0.0.1/', 'https://127.0.0.1/']);

    expect(probeEndpoint).toHaveBeenNthCalledWith(1, { host: '127.0.0.1', port: 80, timeoutMs: 500 });
    expect(probeEndpoint).toHaveBeenNthCalledWith(2, { host: '127.0.0.1', port: 443, timeoutMs: 500 });
  });

  it('caps concurrent probes and rejects oversized batches', async () => {
    let active = 0;
    let peak = 0;
    const releases = [];
    const probeEndpoint = vi.fn(() => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      releases.push(() => {
        active -= 1;
        resolve(true);
      });
    }));
    const runtime = createLocalInstanceStatusRuntime({ probeEndpoint, concurrency: 2 });
    const pending = runtime.checkUrls([
      'http://127.0.0.1:3001/',
      'http://127.0.0.1:3002/',
      'http://127.0.0.1:3003/',
    ]);

    await Promise.resolve();
    expect(active).toBe(2);
    releases.shift()?.();
    await Promise.resolve();
    expect(peak).toBe(2);
    releases.shift()?.();
    await Promise.resolve();
    releases.shift()?.();
    await expect(pending).resolves.toHaveLength(3);

    await expect(runtime.checkUrls(
      Array.from({ length: LOCAL_INSTANCE_MAX_URLS + 1 }, (_, index) => `http://127.0.0.1:${3000 + index}/`),
    )).rejects.toMatchObject({ code: 'TOO_MANY_URLS' });
  });

  it('exposes per-entry results through the guarded status route', async () => {
    const runtime = createLocalInstanceStatusRuntime({
      probeEndpoint: async ({ port }) => port === 3001,
    });
    const { request } = createRouteHarness({ runtime });

    const response = await request({
      urls: ['http://127.0.0.1:3001/', 'http://127.0.0.1:5180/', 'https://example.com/'],
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.results.map((result) => result.status)).toEqual([
      'reachable',
      'unreachable',
      'invalid',
    ]);
  });

  it('rejects disallowed origins, missing UI authentication, and malformed batches', async () => {
    const runtime = createLocalInstanceStatusRuntime({ probeEndpoint: async () => true });
    const denied = createRouteHarness({ runtime, originAllowed: false });
    expect((await denied.request({ urls: [] })).statusCode).toBe(403);

    const unauthenticated = createRouteHarness({
      runtime,
      uiAuthController: {
        enabled: true,
        ensureSessionToken: async () => null,
      },
    });
    expect((await unauthenticated.request({ urls: [] })).statusCode).toBe(401);

    const allowed = createRouteHarness({ runtime });
    expect((await allowed.request({})).statusCode).toBe(400);
    expect((await allowed.request({
      urls: Array.from({ length: LOCAL_INSTANCE_MAX_URLS + 1 }, () => 'http://127.0.0.1:3001/'),
    })).statusCode).toBe(400);
  });
});
