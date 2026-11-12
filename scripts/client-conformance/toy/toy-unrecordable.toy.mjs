// Toy fixtures the recorder must refuse (record.mjs TOY_UNRECORDABLE lists
// each case and its one flag): an accessor in a value, globals the test
// defines itself, engine continuations released by test code, by port code,
// by another family and by the next test, a continuation that acts after its
// release window expired, and engine code the test runs that the recorder
// could not wrap. The self-test corpus of the client conformance harness
// records them and requires exactly these cases to be unrecordable. Run only
// by the harness.
import { expect, test } from 'bun:test';
import { online, ping } from './toy-clock.mjs';
import { frozenControls, gateState, nested, signal, start, wait, waitLong, waitOn } from './toy-gate.mjs';
import { deferred } from './toy-guard.mjs';
import { log } from './toy-log.mjs';
import { applyEvent, createState } from './toy-reducer.mjs';

const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

test('reads an accessor exactly once', () => {
  let reads = 0;
  const draft = createState();
  Object.defineProperty(draft, 'revert', { get() { reads += 1; return { id: 'r1' }; }, enumerable: true, configurable: true });
  expect(applyEvent(draft, { type: 'probe' })).toBe('reverting');
  expect(reads).toBe(1);
});

test('a fetch the test defines as a data property is flagged', async () => {
  Object.defineProperty(globalThis, 'fetch', { value: async () => new Response(null, { status: 201 }), writable: true, configurable: true, enumerable: true });
  expect(await ping('http://toy.invalid/b')).toBe(201);
});

test('a fetch defined and restored inside one test is flagged', async () => {
  const recorderFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: async () => new Response(null, { status: 203 }), writable: true, configurable: true, enumerable: true });
  try {
    expect(await ping('http://toy.invalid/d')).toBe(203);
  } finally {
    Object.defineProperty(globalThis, 'fetch', recorderFetch);
  }
});

test('that data property is re-armed at the next test boundary, so an assignment is wrapped again', async () => {
  globalThis.fetch = async () => new Response(null, { status: 202 });
  expect(await ping('http://toy.invalid/c')).toBe(202);
  globalThis.fetch = originalFetch;
});

test('a navigator the test defines as an accessor is flagged', () => {
  Object.defineProperty(globalThis, 'navigator', { get: () => ({ onLine: false }), configurable: true });
  expect(online()).toBe(false);
});

test('the accessor stands in the next test, which is flagged too', () => {
  expect(online()).toBe(false);
  Object.defineProperty(globalThis, 'navigator', originalNavigator);
});

test('once the recorder\'s accessor is back, a read is recorded again', () => {
  const original = globalThis.navigator;
  globalThis.navigator = { onLine: true };
  try {
    expect(online()).toBe(true);
  } finally {
    globalThis.navigator = original;
  }
});

test('a promise the test resolves releases no input of the engine', async () => {
  let open = null;
  const gate = new Promise((resolve) => { open = resolve; });
  const pending = waitOn(gate);
  open(5);
  expect(await pending).toBe(5);
});

test('a waiter another family releases was released by no input of its own', async () => {
  const gate = deferred();
  const pending = waitOn(gate.promise);
  expect(gate.open(6)).toBe(true);
  expect(await pending).toBe(6);
});

test('a promise a port resolves on its own releases no input of the engine', async () => {
  const sdk = { start: () => { let finish = null; const done = new Promise((resolve) => { finish = resolve; }); setTimeout(() => finish(7), 0); return { done }; } };
  expect(await start(sdk)).toBe(7);
});

test('a waiter that acts more than 64 silent generations after its release is flagged', async () => {
  const pending = waitLong('long', 66);
  expect(signal('long', 3)).toBe(true);
  expect(await pending).toBe(3);
});

test('a waiter the next test releases stays in its own case, marked late', () => {
  void wait('next');
  expect(gateState().waiting).toContain('next');
});

test('the next test releases it', async () => {
  expect(signal('next', 4)).toBe(true);
  await null;
  await null;
  expect(gateState().waiting).not.toContain('next');
});

test('engine code deep inside returned data runs outside any chain', () => {
  expect(nested('n').inner.deep.run()).toBe('deep:n');
});

test('a member of a frozen object cannot be wrapped', () => {
  expect(typeof frozenControls('f').stop).toBe('function');
});

test('a family\'s port that the test calls itself is flagged, since the stack cannot tell it from engine code', () => {
  expect(signal('direct', 1)).toBe(true);
  expect(log('direct', 'test')).toBe('direct:test');
});
