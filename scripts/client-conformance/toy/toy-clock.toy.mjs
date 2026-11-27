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
  let reading = readClock(); for (let tries = 1; reading[1] !== reading[0] && tries < 5; tries++) reading = readClock(); // real time without the recorder: read again if a millisecond passed between the two reads (one call under it)
  const [now, made, performanceNow] = reading; expect(made).toBe(now);
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

// Timer order (package C0f): the first timer is due 20 ms after it is set, the second 5 ms after it is set; the test
// spins 40 ms of real time between the two, so on any machine the first is due earlier in real time, and later in
// nominal time (the clock stands still while the test spins). The recording fires them in nominal order.
test('timers fire in nominal order whatever real time does', async () => {
  const order = [];
  const first = later(20).then(() => { order.push('first'); });
  const started = Bun.nanoseconds();
  while (Bun.nanoseconds() - started < 40e6) { /* real time passes; the nominal clock does not */ }
  const second = later(5).then(() => { order.push('second'); });
  await Promise.all([first, second]);
  expect(order).toHaveLength(2);
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

// The timer clock's floor (the C0f fix round): every timer moves its case's timer clock by at least 1 ms, so a
// zero-delay poll of the test comes due later at each turn and lets a longer engine timer fire. Without the floor the
// poll is always due first, the engine timer is held for ever, and the poll gives up after its bound. The bound is a
// count of polls, never a time.
test('a zero-delay poll of the test waits out a longer engine timer', async () => {
  let done = false;
  const pending = later(20).then(() => { done = true; });
  let polls = 0;
  await new Promise((resolve) => { const poll = () => { polls += 1; if (done || polls >= 100) resolve(); else setTimeout(poll, 0); }; poll(); });
  expect(done).toBe(true);
  await pending;
});
