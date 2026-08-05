import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';
import {
  createGlobalMessageStreamSseHandler,
  createGlobalUiEventBroadcaster,
  createMessageStreamWsRuntime,
} from './runtime.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  ping() {
    void 0;
  }

  close(code, reason) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.emit('close');
  }
}

function createSseResponse({ blocks = [], signal, holdOpen = false }) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              const next = blocks[index++];
              return { value: encoder.encode(next), done: false };
            }

            if (!holdOpen) {
              return { value: undefined, done: true };
            }

            return new Promise((resolve, reject) => {
              const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              };
              signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        };
      },
    },
  };
}

async function waitForCondition(predicate, timeoutMs = 250, intervalMs = 5) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function createMockSseRequest({ headers = {}, query = {} } = {}) {
  const listeners = new Map();
  return {
    headers,
    query,
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    off(event, handler) {
      if (listeners.get(event) === handler) {
        listeners.delete(event);
      }
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
  };
}

function createMockSseResponse() {
  const headers = new Map();
  return {
    writableEnded: false,
    destroyed: false,
    chunks: [],
    socket: {
      noDelay: false,
      setNoDelay(value) {
        this.noDelay = value;
      },
    },
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    flushHeaders() {
      this.flushed = true;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk = '') {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
    },
    get body() {
      return this.chunks.join('');
    },
  };
}

describe('event stream broadcaster', () => {
  it('fans out synthetic events to SSE and WS clients', () => {
    const sseEvents = [];
    const wsPayloads = [];
    const sseClient = { id: 'sse-1' };
    const wsClient = {
      readyState: 1,
      send(payload) {
        wsPayloads.push(JSON.parse(payload));
      },
    };

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set([sseClient]),
      wsClients: new Set([wsClient]),
      writeSseEvent(res, payload) {
        sseEvents.push({ res, payload });
      },
    });

    broadcast({ type: 'openchamber:session-status' }, { eventId: 'evt-1', directory: '/tmp/project' });

    expect(sseEvents).toEqual([
      {
        res: sseClient,
        payload: { type: 'openchamber:session-status' },
      },
    ]);
    expect(wsPayloads).toEqual([
      {
        type: 'event',
        payload: { type: 'openchamber:session-status' },
        eventId: 'evt-1',
        directory: '/tmp/project',
      },
    ]);
  });

  it('removes websocket clients that fail to receive a payload', () => {
    const wsClients = new Set([
      {
        readyState: 1,
        send() {
          throw new Error('socket write failed');
        },
      },
    ]);

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set(),
      wsClients,
      writeSseEvent() {
        throw new Error('should not be called');
      },
    });

    broadcast({ type: 'openchamber:notification' });

    expect(wsClients.size).toBe(0);
  });

  it('publishes synthetic broadcasts into the global hub replay buffer', () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });
    hub.subscribeEvent((event) => {
      received.push(event);
    });

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set(),
      wsClients: new Set(),
      writeSseEvent() {
        throw new Error('should not write direct SSE clients');
      },
      globalEventHub: hub,
    });

    broadcast(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'hello',
          },
        },
      },
      { eventId: 'evt-synthetic', directory: '/tmp/project' },
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      eventId: 'evt-synthetic',
      directory: '/tmp/project',
      payload: {
        type: 'message.part.updated',
      },
    });
    expect(hub.replayAfter('missing-id')).toEqual({ events: received, gap: true });
  });
});

describe('global message stream SSE handler', () => {
  it('replays synthetic global hub events as SSE envelopes after Last-Event-ID', async () => {
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });
    const handler = createGlobalMessageStreamSseHandler({
      globalHub: hub,
      heartbeatIntervalMs: 60_000,
    });

    hub.publishSyntheticEvent({
      eventId: 'evt-before',
      directory: '/tmp/project',
      payload: { type: 'session.updated', properties: { directory: '/tmp/project' } },
    });
    hub.publishSyntheticEvent({
      eventId: 'evt-synthetic',
      directory: '/tmp/project',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'streamed text',
          },
        },
      },
    });

    const req = createMockSseRequest({ headers: { 'last-event-id': 'evt-before' } });
    const res = createMockSseResponse();

    handler(req, res);
    await waitForCondition(() => res.body.includes('evt-synthetic'));

    expect(res.getHeader('content-type')).toBe('text/event-stream');
    expect(res.getHeader('cache-control')).toBe('no-cache');
    expect(res.getHeader('connection')).toBe('keep-alive');
    expect(res.getHeader('x-accel-buffering')).toBe('no');
    expect(res.flushed).toBe(true);
    expect(res.socket.noDelay).toBe(true);
    expect(res.body).not.toContain('evt-before');
    expect(res.body).toContain('id: evt-synthetic\n');
    expect(res.body).toContain('"directory":"/tmp/project"');
    expect(res.body).toContain('"payload":{"type":"message.part.updated"');

    req.emit('close');
    hub.stop();
  });
});

describe('message stream websocket runtime', () => {
  it('shares one global upstream SSE reader across multiple websocket clients', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
    });

    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/global/event/ws' });
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fetchCalls).toBe(1);
    expect(firstSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    expect(firstSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'server.connected', properties: {} },
      eventId: 'evt-1',
      directory: 'global',
    });
    expect(secondSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'server.connected', properties: {} },
      eventId: 'evt-1',
      directory: 'global',
    });

    firstSocket.close();
    secondSocket.close();
    await runtime.close();
  });

  it('replays buffered global events after a reconnecting client Last-Event-ID', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
              'id: evt-2\ndata: {"type":"session.updated","properties":{"directory":"/tmp/project"}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [],
        });
      },
    });

    const firstSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));
    firstSocket.close();

    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/global/event/ws?lastEventId=evt-1' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    expect(secondSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'session.updated', properties: { directory: '/tmp/project' } },
      eventId: 'evt-2',
      directory: '/tmp/project',
    });

    secondSocket.close();
    await runtime.close();
  });

  it('keeps directory websocket streams on separate upstream readers', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    const fetchUrls = [];

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (url, options) => {
        fetchUrls.push(url);
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
    });

    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/event/ws?directory=/tmp/one' });
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/event/ws?directory=/tmp/two' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fetchUrls).toHaveLength(2);
    expect(new URL(fetchUrls[0]).searchParams.get('directory')).toBe('/tmp/one');
    expect(new URL(fetchUrls[1]).searchParams.get('directory')).toBe('/tmp/two');
    expect(firstSocket.sent).toContainEqual({ type: 'ready', scope: 'directory' });
    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'directory' });

    firstSocket.close();
    secondSocket.close();
    await runtime.close();
  });

  it('closes the websocket and triggers health check on initial upstream unavailable response', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      upstreamReconnectDelayMs: 0,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        body: null,
      }),
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toEqual([
      {
        type: 'error',
        message: 'OpenCode event stream unavailable (503)',
      },
    ]);
    expect(socket.closeCalls).toEqual([
      {
        code: 1011,
        reason: 'OpenCode event stream unavailable',
      },
    ]);
    expect(triggerHealthCheckCalls).toBe(1);
    expect(wsClients.size).toBe(0);

    await runtime.close();
  });

  it('closes the websocket without health check when OpenCode URL cannot be built', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl() {
        throw new Error('missing OpenCode port');
      },
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      upstreamReconnectDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('fetch should not be called');
      },
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toEqual([
      {
        type: 'error',
        message: 'OpenCode service unavailable',
      },
    ]);
    expect(socket.closeCalls).toEqual([
      {
        code: 1011,
        reason: 'OpenCode service unavailable',
      },
    ]);
    expect(fetchCalls).toBe(0);
    expect(triggerHealthCheckCalls).toBe(0);

    await runtime.close();
  });

  it('reconnects a stalled upstream SSE stream and resumes from the last event id', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;
    const fetchCalls = [];
    let upstreamAttempt = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      heartbeatIntervalMs: 50,
      upstreamStallTimeoutMs: 20,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        const lastEventId = options?.headers?.['Last-Event-ID'] ?? null;
        fetchCalls.push(lastEventId);
        upstreamAttempt += 1;

        if (upstreamAttempt === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          holdOpen: false,
          blocks: [
            'id: evt-2\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await waitForCondition(() => (
      socket.sent.filter((frame) => frame.type === 'ready').length === 1
      && socket.sent.filter((frame) => frame.type === 'event' && frame.payload?.type === 'server.connected').length >= 2
    ));

    const readyFrames = socket.sent.filter((frame) => frame.type === 'ready');
    const eventFrames = socket.sent.filter((frame) => frame.type === 'event' && frame.payload?.type === 'server.connected');

    expect(readyFrames).toHaveLength(1);
    expect(eventFrames.length).toBeGreaterThanOrEqual(2);
    expect(fetchCalls.slice(0, 2)).toEqual([null, 'evt-1']);
    expect(triggerHealthCheckCalls).toBe(0);

    socket.close();
    await runtime.close();
  });

  it('keeps synthetic event processing on forwarded upstream events', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload(payload, emitSynthetic) {
        if (payload.type === 'session.updated') {
          emitSynthetic({ type: 'openchamber:session-status', sessionID: 'ses_1' });
        }
      },
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{"directory":"/tmp/project"}}\n\n',
        ],
      }),
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'session.updated', properties: { directory: '/tmp/project' } },
      eventId: 'evt-1',
      directory: '/tmp/project',
    });
    expect(socket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'openchamber:session-status', sessionID: 'ses_1' },
      directory: 'global',
    });

    socket.close();
    await runtime.close();
  });

  it('rejects unauthenticated upgrades and accepts a resolved managed principal', async () => {
    const server = new EventEmitter();
    const rejectWebSocketUpgrade = vi.fn();
    const ensureSessionToken = vi.fn(async () => null);
    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: { ensureSessionToken },
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade,
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients: new Set(),
    });
    const firstRequest = { url: '/api/global/event/ws', headers: {} };
    const firstSocket = new EventEmitter();

    server.emit('upgrade', firstRequest, firstSocket, Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));

    expect(ensureSessionToken).toHaveBeenCalledWith(firstRequest, null);
    expect(rejectWebSocketUpgrade).toHaveBeenCalledWith(firstSocket, 401, 'UI authentication required');

    ensureSessionToken.mockImplementationOnce(async (req) => {
      req.principal = { id: 'user-1', role: 'developer', scope: 'managed' };
      return 'opaque-session';
    });
    const handleUpgrade = vi.spyOn(runtime.wsServer, 'handleUpgrade').mockImplementation(() => {});
    const secondRequest = { url: '/api/global/event/ws', headers: {} };
    server.emit('upgrade', secondRequest, new EventEmitter(), Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));

    expect(handleUpgrade).toHaveBeenCalledOnce();
    expect(secondRequest.principal).toMatchObject({ id: 'user-1', scope: 'managed' });
    await runtime.close();
  });

  it('closes an authenticated websocket immediately when its principal is revoked', async () => {
    const server = new EventEmitter();
    let revoke = null;
    const unregister = vi.fn();
    const globalEventHub = {
      subscribeEvent: () => () => {},
      subscribeStatus: () => () => {},
      replayAfter: () => ({ events: [], gap: false }),
      start() {},
      stop() {},
      isConnected: () => false,
    };
    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: {
        registerConnection(_principal, close) {
          revoke = close;
          return unregister;
        },
      },
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients: new Set(),
      globalEventHub,
    });
    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, {
      url: '/api/global/event/ws',
      principal: { id: 'user-1', role: 'developer', scope: 'managed' },
    });

    expect(revoke).toBeTypeOf('function');
    revoke();

    expect(socket.closeCalls).toContainEqual({ code: 4001, reason: 'Access revoked' });
    expect(unregister).toHaveBeenCalledOnce();
    await runtime.close();
  });
});
