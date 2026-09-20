import { EventEmitter } from 'node:events';
import { expect, test } from 'vitest';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
import { createGlobalMessageStreamSseHandler, createGlobalUiEventBroadcaster } from './runtime.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hubFixture = (replay = []) => {
  const events = new Set();
  return { subscribeEvent: fn => { events.add(fn); return () => events.delete(fn); },
    subscribeStatus: () => () => {}, replayAfter: () => ({ events: replay, gap: false }),
    isConnected: () => true, start() {}, stop() {},
    emit: entry => { for (const fn of events) fn(entry); }, subscribers: () => events.size };
};
const response = () => Object.assign(new EventEmitter(), {
  chunks: [], destroyed: false, socket: { writableLength: 0 },
  write(data) { this.chunks.push(data); return true; },
  destroy() { this.destroyed = true; this.emit('close'); },
});
const entry = index => ({ eventId: `${index}`, directory: '/fixture', payload: { type: 'fixture', index } });

test('global WS disconnects a blocked authorizer before any socket bytes accumulate', async () => {
  const hold = deferred(), hub = hubFixture(), clients = new Set();
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, frames: [],
    send(frame) { this.frames.push(JSON.parse(frame)); }, ping() {},
    close(code) { this.code = code; this.readyState = 3; this.emit('close'); } });
  const bridge = createGlobalMessageStreamWsBridge({ globalHub: hub, ownsGlobalHub: false, wsClients: clients,
    heartbeatIntervalMs: 60_000, eventFilter: () => hold.promise });
  bridge.accept(socket);
  for (let index = 0; index < 10_000; index++) hub.emit(entry(index));
  expect(socket.bufferedAmount).toBe(0);
  expect(socket.code).toBe(1013);
  expect(clients.size).toBe(0);
  hold.resolve(true);
  await Promise.resolve(); await Promise.resolve();
  expect(socket.frames.filter(frame => frame.type === 'event')).toHaveLength(0);
  bridge.close();
});

test('SSE cancels replay, revocation registration and queued live events during slow authorization', async () => {
  const hold = deferred(), hub = hubFixture([entry(0)]), req = new EventEmitter(), res = response();
  let registrations = 0;
  const handler = createGlobalMessageStreamSseHandler({ globalHub: hub, eventFilter: () => hold.promise,
    registerConnection: () => { registrations++; return () => { registrations--; }; } });
  const pending = handler(req, res);
  for (let index = 1; index < 10_000; index++) hub.emit(entry(index));
  await pending;
  expect(res.destroyed).toBe(true);
  expect(registrations).toBe(0);
  expect(hub.subscribers()).toBe(0);
  hold.resolve(true);
  await Promise.resolve(); await Promise.resolve();
  expect(res.chunks).toHaveLength(0);
});

test('legacy filtered SSE preserves allow/deny order and cancels on disconnect', async () => {
  const hold = deferred(), res = response();
  res.devRyanEventFilter = async (_principal, event) => event.payload.index === 0 ? hold.promise : event.payload.index !== 1;
  const clients = new Set([res]);
  const broadcast = createGlobalUiEventBroadcaster({ sseClients: clients, wsClients: new Set(), writeSseEvent: (target, payload) => target.write(payload.index) });
  for (let index = 0; index < 3; index++) broadcast({ index });
  hold.resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  expect(res.chunks).toEqual([0, 2]);
  res.emit('close');
  expect(clients.size).toBe(0);
});

test('live SSE cannot overtake an older replay while authorization is delayed', async () => {
  const hold = deferred(), hub = hubFixture([entry(1), entry(2)]), req = new EventEmitter(), res = response();
  const handler = createGlobalMessageStreamSseHandler({ globalHub: hub,
    eventFilter: async (_principal, value) => value.eventId === '1' ? hold.promise : true });
  const pending = handler(req, res);
  hub.emit(entry(3));
  hold.resolve(true);
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  expect(res.chunks.map(chunk => /^id: (\d+)/.exec(chunk)?.[1])).toEqual(['1', '2', '3']);
  req.emit('close');
});
