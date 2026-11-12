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
  expect(socket.url).toMatch(/^ws:\/\/toy\.invalid\?client=[0-9a-f-]{36}&attempt=0$/);
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
  expect(FakeSocket.instances[1].url).toMatch(/attempt=1$/);
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
