// Toy tests of the harness-owned clock module: every way a product test
// stubs time, randomness and globals, under the recorder as without it. The
// self-test corpus of the client conformance harness records them.
import { afterEach, expect, jest, setSystemTime, spyOn, test } from 'bun:test';
import { later, online, ping, readClock, roll } from './toy-clock.mjs';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  setSystemTime();
});

test.skip('a skipped test records nothing and shifts nothing', () => {
  readClock();
});

test('new Date() and Date.now() read the same clock', () => {
  const [now, made, performanceNow] = readClock();
  expect(made).toBe(now);
  expect(typeof performanceNow).toBe('number');
  expect(new Date().constructor).toBe(Date);
  expect(Object.getOwnPropertyDescriptor(Date, 'now').value).toBe(Date.now);
});

test('a Date.now the test assigns answers, and its answer is recorded', () => {
  Date.now = () => 42;
  expect(readClock()[0]).toBe(42);
});

test('spyOn(Date, now) answers through the recorder and restores', () => {
  const spy = spyOn(Date, 'now').mockReturnValue(5);
  expect(readClock()[0]).toBe(5);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
  expect(readClock()[0]).not.toBe(5);
});

test('setSystemTime and jest.setSystemTime set the clock', () => {
  setSystemTime(6000);
  expect(readClock()[0]).toBe(6000);
  jest.setSystemTime(7000);
  expect(readClock()[1]).toBe(7000);
});

test('fake timers advance the clock as they do without the recorder', () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(10000);
    let fired = null;
    later(30).then((at) => { fired = at; });
    const before = readClock();
    jest.advanceTimersByTime(35);
    expect(readClock()[0] - before[0]).toBe(35);
    expect(readClock()[2] - before[2]).toBe(35);
    return Promise.resolve().then(() => { expect(fired).toBe(10030); });
  } finally {
    jest.useRealTimers();
  }
});

test('Math.random and crypto stubs answer, and their answers are recorded', () => {
  const random = spyOn(Math, 'random').mockReturnValue(0.25);
  const uuid = spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
  const [value, id, bytes] = roll();
  expect(value).toBe(0.25);
  expect(id).toBe('00000000-0000-4000-8000-000000000000');
  expect(bytes).toHaveLength(2);
  expect(random).toHaveBeenCalledTimes(1);
  random.mockRestore();
  uuid.mockRestore();
});

test('spyOn(globalThis, fetch) still works and the engine call is recorded', async () => {
  const spy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 503, statusText: 'Unavailable' }));
  expect(await ping('http://toy.invalid/a')).toBe(503);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

test('a stub that itself sets a timer records only what the engine did', async () => {
  globalThis.fetch = (url) => new Promise((resolve) => { setTimeout(() => resolve(new Response(null, { status: url.endsWith('/d') ? 204 : 500 })), 2); });
  expect(await ping('http://toy.invalid/d')).toBe(204);
});

test('reads of navigator are inputs', () => {
  const original = globalThis.navigator;
  globalThis.navigator = { onLine: false };
  try {
    expect(online()).toBe(false);
  } finally {
    globalThis.navigator = original;
  }
});
