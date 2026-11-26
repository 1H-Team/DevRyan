// Toy tests of the harness-owned transport module: the self-test corpus of
// the client conformance harness records them. Run only by the harness.
import { afterEach, expect, mock, test } from 'bun:test';
import { connect } from './toy-transport.mjs';

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 1; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const sdk = { async *events() { yield { type: 'a' }; yield { type: 'b' }; yield { type: 'done' }; yield { type: 'never' }; } };

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  FakeSocket.instances = [];
});

test('socket messages reach onEvent with a log tag', () => {
  globalThis.WebSocket = FakeSocket;
  const events = [];
  const connection = connect(sdk, { url: 'ws://toy.invalid', onEvent: (event) => { events.push(event); } });
  const [socket] = FakeSocket.instances;
  expect(socket.url).toMatch(/^ws:\/\/toy\.invalid\?client=[0-9a-f-]{36}&attempt=0&log=[0-9a-f-]{36}$/);
  socket.onmessage({ data: JSON.stringify({ type: 'ping', n: 1 }) });
  expect(connection.send({ type: 'pong' })).toBe(1);
  expect(socket.sent).toEqual(['{"type":"pong"}']);
  expect(events).toEqual([{ type: 'ping', n: 1, tag: 'event:ping' }]);
});

test('load answers through fetch and the response body', async () => {
  globalThis.WebSocket = FakeSocket;
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push([url, init.method]); return { ok: true, status: 200, json: async () => ({ id: 's1', title: 'one' }) }; };
  const probe = await globalThis.fetch('test://probe', { method: 'HEAD' });
  expect(probe.ok).toBe(true);
  const events = [];
  const connection = connect(sdk, { url: 'http://toy.invalid', onEvent: (event) => { events.push(event.type); } });
  expect(await connection.load('s1')).toEqual({ id: 's1', title: 'one' });
  expect(requests).toEqual([['test://probe', 'HEAD'], ['http://toy.invalid/session/s1', 'GET']]);
  expect(events).toEqual(['loaded']);
});

test('drain reads the injected stream until done', async () => {
  globalThis.WebSocket = FakeSocket;
  const events = [];
  const connection = connect(sdk, { url: 'ws://toy.invalid', onEvent: (event) => { events.push(event.type); } });
  expect(await connection.drain()).toBe(3);
  expect(events).toEqual(['a', 'b', 'done']);
});

test('a closed socket reconnects after a delay', async () => {
  globalThis.WebSocket = FakeSocket;
  connect(sdk, { url: 'ws://toy.invalid', onEvent: () => {} });
  FakeSocket.instances[0].onclose();
  await wait(30);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(FakeSocket.instances[1].url).toMatch(/attempt=1&log=[0-9a-f-]{36}$/);
});

test('two frames a fake emits at once are delivered together', () => {
  globalThis.WebSocket = FakeSocket;
  const events = [];
  connect(sdk, { url: 'ws://toy.invalid', onEvent: (event) => { events.push(event.type); } });
  const [socket] = FakeSocket.instances;
  socket.onmessage({ data: '{"type":"first"}' });
  socket.onmessage({ data: '{"type":"second"}' });
  expect(events).toEqual(['first', 'second']);
});

test('answers that settle in one turn are one group', async () => {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async (url) => ({ ok: !url.endsWith('/b') });
  const events = [];
  const connection = connect(sdk, { url: 'http://toy.invalid', onEvent: (event) => { events.push(event.type); } });
  expect(await connection.loadAll(['a', 'b'])).toEqual([true, false]);
  expect(events).toEqual(['loaded-all']);
});

// Answers a fake gives at once, or a hop later, settle in the drain of their call: immediate answers, each with the
// microtask generation it came at, which a replay keeps (package C0f).
test('answers awaited in two rounds, each at once or a hop later, are immediate answers', async () => {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/hop')) await Promise.resolve();
    return { ok: true, json: async () => ({ id: url.split('/').pop() }) };
  };
  const connection = connect(sdk, { url: 'http://toy.invalid', onEvent: () => {} });
  expect(await connection.loadBodies(['a', 'hop', 'b'])).toEqual(['a', 'hop', 'b']);
});

// The test releases its fakes' answers after a timer, the second one 70 microtask hops after the first: within one
// drain the recorder places an input by the microtask generation it came at, up to 64 (AFTER_GENERATIONS); past that
// it is delivered once the step before has run out, as an input of another drain is.
test('an answer released more generations after another than the recorder counts comes once the one before ran out', async () => {
  globalThis.WebSocket = FakeSocket;
  const releases = new Map();
  globalThis.fetch = (url) => new Promise((resolve) => { releases.set(url.split('/').pop(), () => resolve({ ok: true })); });
  const connection = connect({ events: async function* () {} }, { url: 'http://toy.invalid', onEvent: () => {} });
  const loading = connection.loadAll(['a', 'b']);
  await new Promise((resolve) => { setTimeout(resolve, 1); });
  releases.get('a')();
  for (let hop = 0; hop < 70; hop += 1) await null;
  releases.get('b')();
  expect(await loading).toEqual([true, true]);
});

test('answers the module does not wait for keep their places beside the one it does', async () => {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async (url) => ({ ok: !url.endsWith('/c') });
  const events = [];
  const connection = connect(sdk, { url: 'http://toy.invalid', onEvent: (event) => { events.push(`${event.type}:${event.ok}`); } });
  expect(await connection.loadAside(['a', 'b', 'c'])).toBe(true);
  await Promise.resolve();
  expect(events).toHaveLength(3);
});

test('a callback inside an options object the sdk is handed is an input', async () => {
  globalThis.WebSocket = FakeSocket;
  const subscriptions = [];
  const withSubscribe = { ...sdk, subscribe(options) { subscriptions.push(options); options.onItem('at-once'); return () => 'stopped'; } };
  const events = [];
  const connection = connect(withSubscribe, { url: 'ws://toy.invalid', onEvent: (event) => { events.push(event.item); } });
  const items = connection.subscribe('t');
  await wait(1);
  subscriptions[0].onItem('later');
  expect(items).toEqual(['at-once', 'later']);
  expect(events).toEqual(['at-once', 'later']);
  expect(connection.stopSubscription()).toBe('stopped');
});

test('the Event the module dispatches on the window is a value', () => {
  globalThis.WebSocket = FakeSocket;
  const dispatched = [];
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => { dispatched.push(event.type); return true; } };
  try {
    const connection = connect(sdk, { url: 'ws://toy.invalid', onEvent: () => {} });
    expect(connection.announce()).toBe(true);
    expect(dispatched).toEqual(['toy:connected']);
  } finally {
    globalThis.window = originalWindow;
  }
});

// The C0f fix round: an api object injected at a key of the options. The module holds a wrapper around the options
// (the api in it is a port), and what it hands back is the very options object the test passed, identity included.
test('the options the module hands back are the ones handed in, with an api injected at a key', () => {
  globalThis.WebSocket = FakeSocket;
  const options = { url: 'ws://toy.invalid', onEvent: () => {}, api: { ping: (url) => `pong ${url}` } };
  const connection = connect(sdk, options);
  expect(connection.ping()).toBe('pong ws://toy.invalid');
  expect(connection.settings().url).toBe('ws://toy.invalid');
});

test('a mocked logger answers for the port, last mock wins', () => {
  mock.module('./toy-log.mjs', () => ({ log: (kind) => `first:${kind}` }));
  mock.module('./toy-log.mjs', () => ({ log: (kind) => `mocked:${kind}` }));
  globalThis.WebSocket = FakeSocket;
  const events = [];
  connect(sdk, { url: 'ws://toy.invalid', onEvent: (event) => { events.push(event.tag); } });
  FakeSocket.instances[0].onmessage({ data: '{"type":"hello"}' });
  expect(events).toEqual(['mocked:event']);
});

