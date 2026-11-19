// Toy tests of a mocked module's exports called with no engine chain
// (package C0c2, the mock-module layer): the test mocks the transport's
// logger with a function and an object with a method, calls both itself many
// times with a large argument, as a mounted component renders through its
// store hooks, and then lets the transport call the mocked logger inside its
// chain. The calls with no chain record nothing (no context, no copy of the
// argument or the answer); the call inside the chain is a port effect with
// its arguments and answer, as before. The self-test corpus of the client
// conformance harness records them.
import { expect, mock, test } from 'bun:test';

const large = { rows: Array.from({ length: 200 }, (_, index) => ({ index, text: `row ${index}` })) };

test('a mocked export the test calls itself records nothing; the engine\'s call is a port effect', async () => {
  const written = [];
  mock.module('./toy-log.mjs', () => ({ log: (kind, detail) => `mocked ${kind}:${detail}`, sink: { write(value) { written.push(value.rows.length); return written.length; } } }));
  const { log, sink } = await import('./toy-log.mjs');
  for (let render = 0; render < 50; render += 1) {
    expect(log('render', large)).toBe('mocked render:[object Object]');
    expect(sink.write(large)).toBe(render + 1);
  }
  const { connect } = await import('./toy-transport.mjs');
  const sockets = [];
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor(url) { this.url = url; sockets.push(this); } send() {} close() {} };
  try {
    const events = [];
    connect({}, { url: 'ws://toy.invalid', onEvent: (event) => { events.push(event.tag); } });
    sockets[0].onmessage({ data: '{"type":"hello"}' });
    expect(events).toEqual(['mocked event:hello']);
  } finally { globalThis.WebSocket = original; }
  expect(written).toHaveLength(50);
});

test('the engine\'s call of a mocked object\'s method is a port effect; the test\'s own calls of mocked members record nothing', async () => {
  const notes = [];
  class Recorder { constructor(label) { notes.push(`new ${label}`); } }
  const write = Object.assign((items) => items.length, { flush: (items) => { notes.push(`flush ${items.length}`); return items.length; } });
  mock.module('./toy-sink.mjs', () => ({ sink: { write: (items) => items.length * 10, nested: { write: (items) => { notes.push(`nested ${items.length}`); return items.length; } } }, write, Recorder }));
  const mocked = await import('./toy-sink.mjs');
  for (let render = 0; render < 20; render += 1) {
    expect(mocked.write.flush(large.rows)).toBe(200);
    expect(mocked.sink.nested.write(large.rows)).toBe(200);
    expect(new mocked.Recorder('by the test')).toBeInstanceOf(Recorder);
  }
  const { sinkLater, sinkTo } = await import('./toy-sched.mjs');
  expect(sinkTo(['a', 'b'])).toBe(20);
  expect(await sinkLater()).toBe(10);
  expect(notes).toHaveLength(60);
});
