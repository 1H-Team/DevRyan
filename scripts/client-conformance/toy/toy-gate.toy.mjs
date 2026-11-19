// Toy tests of the harness-owned gate module: a continuation belongs to the
// input whose delivery made it runnable (nested releases, Promise.withResolvers
// and a control that yields included), engine code the test runs later (a
// closure, an iterator, a getter, a thenable, a port's stream) is an input of
// its family, and what a test's engine does after the test ended is still that
// test's (marked late). The self-test corpus of the client conformance harness
// records them. Run only by the harness.
import { expect, test } from 'bun:test';
import { arm, ask, drainOpen, eager, eagerLater, gateState, items, meter, poke, promiseLike, signal, signalResolvers, subscribe, wait, waitDeep, waitResolvers } from './toy-gate.mjs';

test('a waiter wakes in the step of the signal that opened its gate', async () => {
  const pending = wait('a');
  expect(signal('a', 1)).toBe(true);
  expect(await pending).toBe(1);
});

test('the control that does not wait does everything in its own call', async () => {
  const pending = eager('a');
  expect(signal('a', 1)).toBe(true);
  expect(await pending).toBe('eager');
});

test('a timer one call set fires in its own step and releases a waiter from another call', async () => {
  expect(arm('t', 5, 2)).toBe(5);
  expect(await wait('t')).toBe(2);
});

test('one signal releases two waiters, both in its step', async () => {
  const first = wait('k');
  const second = wait('k');
  signal('k', 3);
  expect(await Promise.all([first, second])).toEqual([3, 3]);
});

test('a waiter many promise generations from its gate still wakes in the signal step', async () => {
  const pending = waitDeep('d', 6);
  signal('d', 4);
  expect(await pending).toBe(4);
});

test('an answer a later call delivers belongs to its settling', async () => {
  let deliver = null;
  const sdk = {
    request: (key) => new Promise((resolve) => { deliver = () => resolve(key.toUpperCase()); }),
    flush: () => { deliver(); return true; },
  };
  const answer = ask(sdk, 'q');
  expect(poke(sdk)).toBe(true);
  expect(await answer).toBe('Q');
});

test('a release inside another release window keeps each waiter with its own signal', async () => {
  const first = wait('outer');
  const second = wait('inner');
  const relay = (async () => { await first; signal('inner', 2); })();
  signal('outer', 1);
  await relay;
  expect(await second).toBe(2);
});

test('a control that yields twice before acting still acts in its own call', async () => {
  const pending = eagerLater('a');
  expect(signal('a', 1)).toBe(true);
  expect(await pending).toBe('later');
});

test('a gate made by Promise.withResolvers releases its waiter in the signal step', async () => {
  const pending = waitResolvers('r');
  expect(signalResolvers('r', 7)).toBe(true);
  expect(await pending).toBe(7);
});

test('a closure an entry returns is an input of its family when the test calls it', () => {
  const unsubscribe = subscribe('s');
  expect(unsubscribe()).toBe('unsubscribe:s');
});

test('an async iterator an entry returns delivers each item as an input', async () => {
  const seen = [];
  for await (const item of items(['x', 'y'])) seen.push(item);
  expect(seen).toEqual(['x', 'y']);
});

test('a getter the test reads and a thenable it awaits are inputs', async () => {
  const gauge = meter();
  expect(gauge.reading).toBe(1);
  expect(gauge.reading).toBe(2);
  expect(meter()).not.toBe(gauge);
  expect(await promiseLike('p')).toBe('p');
});

test('a stream a port answers delivers each item as an input', async () => {
  const stream = { open: async () => ({ items: (async function* source() { yield 1; yield 2; })() }) };
  expect(await drainOpen(stream)).toEqual([1, 2]);
});

test('the program\'s own microtask order is the same as without the recorder', async () => {
  const order = [];
  const woken = wait('order').then((value) => { order.push(`woke:${value}`); });
  Promise.resolve().then(() => { order.push('t1'); }).then(() => { order.push('t2'); }).then(() => { order.push('t3'); });
  queueMicrotask(() => { order.push('q'); });
  const gate = new Promise((resolve) => { queueMicrotask(() => { order.push('own-resolve'); resolve('own'); }); });
  gate.then((value) => { order.push(`own:${value}`); });
  signal('order', 1);
  Promise.resolve().then(() => { order.push('after'); });
  await woken;
  await null; await null; await null; await null;
  // The order bun gives without the recorder.
  expect(order).toEqual(['t1', 'q', 'own-resolve', 'after', 't2', 'own:own', 'woke:1', 't3']);
});

test('a timer that fires after its test ended is still that test\'s, marked late', () => {
  arm('late', 20, 9);
  void wait('late');
  expect(gateState().waiting).toEqual(['late']);
});

test('the next test touches no family while the late timer fires', async () => {
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  expect(gateState().waiting).toEqual([]);
});
