import { EventEmitter } from 'node:events';
import express from 'express';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { registerOpenCodeProxy } from '../proxy.js';
import { createGlobalMessageStreamHub } from '../../event-stream/global-hub.js';
import { createProjectedStreamClient } from '../../event-stream/test-projected-stream.js';
import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeV2SseHandler } from './sse-routes.js';
import { createMessageStreamGapControlPayload } from '../../event-stream/protocol.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const entry = (eventId, directory = '/a') => ({ eventId, directory, payload: { type: 'session.updated', properties: { info: { id: eventId } } } });
const setup = (options = {}) => {
  const req = Object.assign(new EventEmitter(), { originalUrl: '/api/global/event', query: {}, headers: {}, principal: { id: 'owner' } }, options.req);
  const res = Object.assign(new EventEmitter(), { headers: {}, chunks: [], statusCode: 0, destroyed: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(body) { this.body = body; return this; },
    write(chunk) { this.chunks.push(chunk); return true; },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  let subscriber;
  const unsubscribe = vi.fn(() => { subscriber = undefined; });
  const hub = { start: vi.fn(), replayAfter: vi.fn(() => ({ events: [], gap: false })),
    subscribeEvent: vi.fn((callback) => { subscriber = callback; return unsubscribe; }), ...options.hub };
  const handler = createOpenCodeV2SseHandler({ globalMessageStreamHub: hub, resolveRequestDirectory: () => '/a', ...options.deps });
  return { req, res, hub, unsubscribe, handler, emit: (value) => subscriber?.(value) };
};

describe('projected gen-2 SSE', () => {
  it('replays hub cursors, signals gaps, and sends global envelopes in order', async () => {
    const context = setup({ req: { headers: { 'last-event-id': 'old' } },
      hub: { replayAfter: vi.fn(() => ({ events: [entry('cursor-1'), entry('cursor-2')], gap: true })) } });
    await context.handler(context.req, context.res);
    context.emit(entry('cursor-3'));
    await tick();
    expect(context.hub.replayAfter).toHaveBeenCalledWith('old', { directory: undefined });
    expect(context.res.chunks[0]).not.toContain('id:');
    expect(context.res.chunks[0]).toContain('event: devryan.replay-gap');
    expect(context.res.chunks.slice(1).map((chunk) => chunk.split('\n')[0])).toEqual(['id: cursor-1', 'id: cursor-2', 'id: cursor-3']);
    expect(context.res.chunks[1]).toContain('"directory":"/a","payload":');
    context.res.destroy();
    expect(context.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('sends bare v1 events for one directory while preserving ownership filtering', async () => {
    const eventFilter = vi.fn(async (_principal, value) => value.eventId !== 'denied');
    const context = setup({ req: { originalUrl: '/api/event?directory=/a', query: { directory: '/a' } }, deps: { eventFilter } });
    await context.handler(context.req, context.res);
    context.emit(entry('other', '/b'));
    context.emit(entry('denied'));
    context.emit(entry('allowed'));
    await tick();
    expect(context.res.chunks).toHaveLength(1);
    expect(context.res.chunks[0]).toContain('data: {"type":"session.updated"');
    expect(context.res.chunks[0]).not.toContain('"payload"');
    expect(eventFilter).toHaveBeenCalledWith(context.req.principal, expect.objectContaining({ eventId: 'allowed' }));
    context.res.destroy();
  });

  it('does not leak a pending filtered event after access revocation', async () => {
    let release;
    let revoke;
    const unregister = vi.fn();
    const context = setup({ deps: {
      eventFilter: () => new Promise((resolve) => { release = resolve; }),
      registerConnection: (_principal, callback) => { revoke = callback; return unregister; },
    } });
    await context.handler(context.req, context.res);
    context.emit(entry('pending'));
    revoke();
    release(true);
    await tick();
    expect(context.res.chunks).toEqual([]);
    expect(context.res.destroyed).toBe(true);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('waits for socket drain before delivering the next queued event', async () => {
    const context = setup();
    context.res.write = function (chunk) { this.chunks.push(chunk); return this.chunks.length !== 1; };
    await context.handler(context.req, context.res);
    context.emit(entry('one'));
    context.emit(entry('two'));
    await tick();
    expect(context.res.chunks).toHaveLength(1);
    context.res.emit('drain');
    await tick();
    expect(context.res.chunks).toHaveLength(2);
    context.res.destroy();
  });

  it('does not silently widen a missing directory to the global stream', async () => {
    const context = setup({ req: { originalUrl: '/api/event' }, deps: { resolveRequestDirectory: () => undefined } });
    await context.handler(context.req, context.res);
    expect(context.res.statusCode).toBe(400);
    expect(context.res.body.code).toBe('opencode_location_required');
    expect(context.hub.subscribeEvent).not.toHaveBeenCalled();
  });

  it('delivers only branded replay controls through managed ownership filters', async () => {
    const eventFilter = vi.fn(async () => false);
    const context = setup({ req: { principal: { scope: 'managed' }, headers: { 'last-event-id': 'old' } },
      hub: { replayAfter: () => ({ events: [], gap: true }) }, deps: { eventFilter } });
    await context.handler(context.req, context.res);
    context.emit({ directory: 'global', payload: { type: 'gap', properties: { scope: 'global' } } });
    context.emit({ directory: 'global', payload: createMessageStreamGapControlPayload({ reason: 'reconnect' }) });
    await tick();
    expect(context.res.chunks).toHaveLength(2);
    expect(context.res.chunks.every((chunk) => chunk.startsWith('event: devryan.replay-gap'))).toBe(true);
    expect(eventFilter).toHaveBeenCalledTimes(1);
    context.res.destroy();
  });
});

const readyFrame = 'event: devryan.subscription-ready\ndata: {"type":"ready","scope":"global"}\n\n';
const readyHeaders = { 'x-devryan-subscription-ready': '1' };
const readinessHub = ({ connected = false, replay = [] } = {}) => {
  const events = new Set(), statuses = new Set();
  return { events, statuses, isConnected: () => connected,
    subscribeEvent(listener) { events.add(listener); return () => events.delete(listener); },
    subscribeStatus(listener) { statuses.add(listener); return () => statuses.delete(listener); },
    replayAfter: vi.fn(() => ({ events: replay, gap: false })), start() {},
    status(type) { connected = type === 'connect'; for (const listener of [...statuses]) listener({ type }); },
    emit(value) { for (const listener of [...events]) listener(value); },
  };
};

describe('active global subscription readiness', () => {
  it('acknowledges a quiet stream only after registration, attachment and upstream connection', async () => {
    const hub = readinessHub();
    let registered = false;
    hub.start = () => {
      expect(registered).toBe(true); expect(hub.events.size).toBe(1); expect(hub.statuses.size).toBe(1);
      hub.status('connect');
    };
    const context = setup({ req: { headers: readyHeaders }, hub, deps: {
      registerConnection(principal) { expect(principal.id).toBe('owner'); registered = true; return () => { registered = false; }; },
    } });
    await context.handler(context.req, context.res);
    expect(context.res.chunks).toEqual([readyFrame]);
    expect(readyFrame).not.toContain('id:');
    context.req.emit('aborted');
    expect(registered).toBe(false); expect(hub.events.size).toBe(0); expect(hub.statuses.size).toBe(0);
  });

  it('orders the complete authorized replay snapshot before live events and readiness despite a connect race', async () => {
    const hub = readinessHub({ replay: [entry('one'), entry('two')] });
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const context = setup({ req: { headers: { ...readyHeaders, 'last-event-id': 'old' } }, hub, deps: {
      eventFilter: async (_principal, value) => { if (value.eventId === 'one') await barrier; return true; },
    } });
    const pending = context.handler(context.req, context.res);
    hub.status('connect'); hub.emit(entry('live'));
    expect(context.res.chunks).toEqual([]);
    release(); await pending; await tick();
    expect(context.res.chunks.filter(chunk => chunk.startsWith('id:')).map(chunk => chunk.split('\n')[0])).toEqual(['id: one', 'id: two', 'id: live']);
    expect(context.res.chunks.indexOf(readyFrame)).toBeGreaterThan(context.res.chunks.findIndex(chunk => chunk.startsWith('id: two')));
    context.res.destroy();
  });

  it('refuses missing readiness ownership, missing managed filtering and a revoked principal before ACK', async () => {
    const unavailable = setup({ req: { headers: readyHeaders } });
    await unavailable.handler(unavailable.req, unavailable.res);
    expect(unavailable.res.statusCode).toBe(503); expect(unavailable.res.chunks).toEqual([]);
    const missingFilter = setup({ req: { headers: readyHeaders, principal: { scope: 'managed' } }, hub: readinessHub({ connected: true }) });
    await missingFilter.handler(missingFilter.req, missingFilter.res);
    expect(missingFilter.res.statusCode).toBe(503);
    const hub = readinessHub({ connected: true });
    const unregister = vi.fn();
    const revoked = setup({ req: { headers: readyHeaders }, hub, deps: { registerConnection(_principal, revoke) { revoke(); return unregister; } } });
    await revoked.handler(revoked.req, revoked.res);
    expect(revoked.res.destroyed).toBe(true); expect(revoked.res.chunks).toEqual([]);
    expect(hub.events.size).toBe(0); expect(hub.statuses.size).toBe(0); expect(unregister).toHaveBeenCalledOnce();
  });

  it('revokes on upstream disconnect while authorization is pending and requires a fresh subscription', async () => {
    const hub = readinessHub({ connected: true, replay: [entry('pending')] });
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const context = setup({ req: { headers: readyHeaders }, hub, deps: { eventFilter: async () => { await barrier; return true; } } });
    const pending = context.handler(context.req, context.res);
    hub.status('disconnect'); hub.status('connect'); release(); await pending;
    expect(context.res.destroyed).toBe(true); expect(context.res.chunks).toEqual([]);
    expect(hub.events.size).toBe(0); expect(hub.statuses.size).toBe(0);
    const next = setup({ req: { headers: readyHeaders }, hub });
    await next.handler(next.req, next.res); expect(next.res.chunks.at(-1)).toBe(readyFrame);
    hub.status('disconnect'); expect(next.res.destroyed).toBe(true);
    expect(hub.events.size).toBe(0); expect(hub.statuses.size).toBe(0);
  });

  it('keeps non-opted and directory clients unchanged on upstream disconnect', async () => {
    for (const req of [{}, { originalUrl: '/api/event?directory=/a', query: { directory: '/a' }, headers: readyHeaders }]) {
      const hub = readinessHub({ connected: true });
      const context = setup({ req, hub });
      await context.handler(context.req, context.res);
      expect(hub.statuses.size).toBe(0); hub.status('disconnect');
      expect(context.res.destroyed).toBe(false); expect(context.res.chunks).toEqual([]);
      context.res.destroy(); expect(hub.events.size).toBe(0);
    }
  });

  it('replays cursor-free reconnect through original directory and ownership filters before ACK, never on first connect', async () => {
    for (const recovering of [false, true]) {
      const hub = readinessHub({ connected: true });
      hub.replayAfter = vi.fn((_cursor, options) => options.unanchored ? { gap: true, events: [entry('hidden', '/hidden'), entry('first-lost', '/visible')] } : { gap: false, events: [] });
      const context = setup({ req: { headers: { ...readyHeaders, ...(recovering ? { 'x-devryan-replay-unanchored': '1' } : {}) }, principal: { scope: 'managed' } }, hub,
        deps: { eventFilter: async (_principal, value) => value.directory === '/visible' } });
      await context.handler(context.req, context.res);
      if (recovering) {
        expect(hub.replayAfter).toHaveBeenCalledWith('', { directory: undefined, unanchored: true });
        expect(context.res.chunks[0]).toContain('event: devryan.replay-gap');
        expect(context.res.chunks.join('')).not.toContain('hidden');
        expect(context.res.chunks[1]).toContain('id: first-lost');
        expect(context.res.chunks[2]).toBe(readyFrame);
      } else {
        expect(hub.replayAfter).toHaveBeenCalledWith('', { directory: undefined });
        expect(context.res.chunks).toEqual([readyFrame]);
      }
      context.res.destroy();
    }
  });
});

it('acknowledges the registered proxy quiet stream in the original UI SDK before prompt POST', async () => {
  const controller = new AbortController();
  const prompt = vi.fn(async () => null);
  const client = { ...createProjectedStreamClient(), prompts: { prompt } };
  let releaseUpstream;
  const hub = createGlobalMessageStreamHub({ openCodeClient: client, getOpenCodeAuthHeaders: () => ({}),
    fetchImpl: async (_url, options) => new Response(new ReadableStream({ start(stream) {
      releaseUpstream = () => { try { stream.close(); } catch { /* Already closed. */ } };
      options.signal.addEventListener('abort', releaseUpstream, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const app = express();
  const registered = new Set();
  app.use((req, _res, next) => { req.principal = { id: 'owner', scope: 'managed' }; next(); });
  registerOpenCodeProxy(app, { openCodeClient: client, globalMessageStreamHub: hub,
    OPEN_CODE_READY_GRACE_MS: 0, getRuntime: () => ({ openCodePort: 4096, isOpenCodeReady: true }),
    resolveRequestDirectory: () => '/workspace', messageStreamEventFilter: async () => true,
    registerMessageStreamConnection(principal, revoke) { expect(principal.id).toBe('owner'); registered.add(revoke); return () => registered.delete(revoke); },
    getOpenCodeAuthHeaders: () => ({}) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}/api` });
  let ready;
  const acknowledged = new Promise(resolve => { ready = resolve; });
  let timeout;
  let consume;
  try {
    const events = await sdk.global.event({ signal: controller.signal, headers: { 'X-DevRyan-Subscription-Ready': '1' },
      onSseEvent(frame) {
        if (frame.event === 'devryan.subscription-ready') { expect(frame.data).toEqual({ type: 'ready', scope: 'global' }); ready(); }
      } });
    consume = (async () => { for await (const _frame of events.stream) { /* Original SDK parses the control frame. */ } })().catch(error => {
      if (!controller.signal.aborted) throw error;
    });
    await Promise.race([acknowledged, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(Error('Registered proxy did not acknowledge quiet subscription')), 500); })]);
    expect(hub.isConnected()).toBe(true);
    expect(registered.size).toBe(1);
    expect(prompt).not.toHaveBeenCalled();
    const response = await sdk.session.promptAsync({ sessionID: 'ses_ready', directory: '/workspace', messageID: 'msg_ready', parts: [{ type: 'text', text: 'hello' }] });
    expect(response.error).toBeUndefined();
    expect(prompt).toHaveBeenCalledTimes(1);
  } finally {
    clearTimeout(timeout); controller.abort(); releaseUpstream?.(); hub.stop(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await consume;
  }
  expect(registered.size).toBe(0);
});
