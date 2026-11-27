// Toy fixtures of what the recorder refuses on a transport path (package C0f): a signal the test aborts after handing
// it in (signal-aborted), and the platform's own fetch (real-transport: a data: URL, so nothing leaves the process).
// The self-test corpus of the client conformance harness records them; TOY_UNRECORDABLE lists each case with its one
// flag.
import { afterEach, expect, test } from 'bun:test';
import { ping } from './toy-clock.mjs';
import { connect } from './toy-transport.mjs';

class FakeSocket {
  constructor(url) { this.url = url; }
  send() {}
  close() {}
}
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; });

// The test aborts the signal it handed the engine while the engine waits; the engine then reads `signal.aborted`
// through the platform's getter, which no port sees.
test('a signal the test aborts after handing it in is flagged', async () => {
  globalThis.WebSocket = FakeSocket;
  let release = null;
  globalThis.fetch = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
  const connection = connect({ events: async function* () {} }, { url: 'http://toy.invalid', onEvent: () => {} });
  const controller = new AbortController();
  const loading = connection.loadUnless('s1', controller.signal);
  await Promise.resolve();
  controller.abort();
  release();
  expect(await loading).toBe(null);
});

test('the platform fetch is a real transport', async () => {
  globalThis.fetch = originalFetch;
  expect(await ping('data:text/plain,ok')).toBe(200);
});
