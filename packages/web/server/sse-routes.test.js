import { describe, expect, it } from 'vitest';

import { registerNotificationRoutes } from './lib/notifications/routes.js';
import { createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { registerScheduledTaskRoutes } from './lib/scheduled-tasks/routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(path, handler) {
        routes.set(`GET ${path}`, handler);
      },
      post(path, handler) {
        routes.set(`POST ${path}`, handler);
      },
      put(path, handler) {
        routes.set(`PUT ${path}`, handler);
      },
      delete(path, handler) {
        routes.set(`DELETE ${path}`, handler);
      },
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createMockRequest = () => {
  const listeners = new Map();

  return {
    headers: {},
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
  };
};

const createMockResponse = () => {
  const headers = new Map();
  let statusCode = 200;
  let body = '';
  let flushed = false;

  return {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    flushHeaders() {
      flushed = true;
    },
    write(chunk) {
      body += String(chunk);
      return true;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body += JSON.stringify(payload);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get flushed() {
      return flushed;
    },
  };
};

describe('local SSE routes', () => {
  const { writeSseEvent } = createNotificationEmitterRuntime({});

  it.each([
    ['legacy', undefined, 'openchamber:notification-stream-ready'],
    ['devryan', 'devryan', 'devryan:notification-stream-ready'],
  ])('serves notification SSE with nginx-safe headers and %s dialect', async (_name, dialect, readyType) => {
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

    registerNotificationRoutes(app, {
      uiAuthController: {
        ensureSessionToken: async () => 'ui-token',
      },
      getUiSessionTokenFromRequest: () => 'ui-token',
      getUiNotificationClients: () => clients,
      writeSseEvent,
    });

    const handler = getRoute('GET', '/api/notifications/stream');
    const req = createMockRequest();
    if (dialect) req.query = { events: dialect };
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/event-stream');
    expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
    expect(res.getHeader('connection')).toBe('keep-alive');
    expect(res.getHeader('x-accel-buffering')).toBe('no');
    expect(res.flushed).toBe(true);
    expect(JSON.parse(res.body.slice('data: '.length)).type).toBe(readyType);
    expect(clients.has(res)).toBe(true);

    req.emit('close');
    expect(clients.has(res)).toBe(false);
  });

  it.each([
    ['legacy', undefined, 'openchamber:event-stream-ready'],
    ['devryan', 'devryan', 'devryan:event-stream-ready'],
  ])('serves DevRyan SSE with nginx-safe headers and %s dialect', (_name, dialect, readyType) => {
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

    registerScheduledTaskRoutes(app, {
      getDevRyanEventClients: () => clients,
      writeSseEvent,
    });

    const handler = getRoute('GET', '/api/devryan/events');
    const req = createMockRequest();
    if (dialect) req.query = { events: dialect };
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/event-stream');
    expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
    expect(res.getHeader('connection')).toBe('keep-alive');
    expect(res.getHeader('x-accel-buffering')).toBe('no');
    expect(res.flushed).toBe(true);
    expect(JSON.parse(res.body.slice('data: '.length)).type).toBe(readyType);
    expect([...clients].some((client) => client.response === res)).toBe(true);

    req.emit('close');
    expect([...clients].some((client) => client.response === res)).toBe(false);
  });
});
