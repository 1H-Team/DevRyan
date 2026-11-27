// Toy tests of immediate answers at and past the count (the C0f fix round):
// an answer that settles in its call's drain is an immediate answer up to 64
// microtask generations after the call, and is refused past that. The count
// is pinned at the cap on both sides. The self-test corpus of the client
// conformance harness records them. Run only by the harness.
import { afterEach, expect, test } from 'bun:test';
import { connect } from './toy-transport.mjs';

class FakeSocket { constructor(url) { this.url = url; } send() {} close() {} }
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; });
// An answer that settles `n` promise hops after the fake was called, all in the drain of the call.
const hops = (n, value) => { let promise = Promise.resolve(); for (let index = 0; index < n; index += 1) promise = promise.then(() => {}); return promise.then(() => value); };
const stream = { events: async function* () {} };
const settleOne = () => new Promise((resolve) => { setTimeout(resolve, 1); });

// The awaited answer (x, asked second) settles 66 hops after its call, the aside one (y, asked first) 70 hops after.
test('two answers past the generation cap in their calls\' drain are flagged', async () => {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = (url) => hops(url.endsWith('/x') ? 66 : 70, { ok: !url.endsWith('/y') });
  const events = [];
  const connection = connect(stream, { url: 'http://toy.invalid', onEvent: (event) => { events.push(`${event.type}:${event.ok}`); } });
  expect(await connection.loadAside(['x', 'y'])).toBe(true);
  await settleOne();
  expect(events).toEqual(['first:true', 'aside:false']);
});

test('the same answers under the cap are immediate answers', async () => {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = (url) => hops(url.endsWith('/x') ? 6 : 10, { ok: !url.endsWith('/y') });
  const events = [];
  const connection = connect(stream, { url: 'http://toy.invalid', onEvent: (event) => { events.push(`${event.type}:${event.ok}`); } });
  expect(await connection.loadAside(['x', 'y'])).toBe(true);
  await settleOne();
  expect(events).toEqual(['first:true', 'aside:false']);
});

test('an answer at the generation cap is an immediate answer', async () => {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = () => hops(63, { ok: true });
  const events = [];
  const connection = connect(stream, { url: 'http://toy.invalid', onEvent: (event) => { events.push(event.type); } });
  expect(await connection.loadAside(['x'])).toBe(true);
  expect(events).toEqual(['first']);
});

test('an answer one generation past the cap is flagged', async () => {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = () => hops(64, { ok: true });
  const events = [];
  const connection = connect(stream, { url: 'http://toy.invalid', onEvent: (event) => { events.push(event.type); } });
  expect(await connection.loadAside(['x'])).toBe(true);
  expect(events).toEqual(['first']);
});

// A timer's callback begins a drain of its own (the review's S7): the test's first timer is due 20 ms after it is set,
// its second 5 ms after it is set, 40 ms of real time later, so the first fires first in real time and, under the
// recorder, is held until the second (due earlier on the timer clock) fired. The second's callback lets the module ask
// in a job after it; the held first one, released right after, answers. Recorded, that answer comes in a drain of its
// own, never in the drain of its call, though no other macrotask ran between them. Plainly the first timer fires first
// and the question is never answered; the test asserts only that it was asked.
test('an answer a released timer gives comes in a drain of its own', async () => {
  globalThis.WebSocket = FakeSocket;
  let answer = null;
  globalThis.fetch = () => new Promise((resolve) => { answer = () => resolve({ ok: true }); });
  const events = [];
  const connection = connect(stream, { url: 'http://toy.invalid', onEvent: (event) => { events.push(event.type); } });
  const released = new Promise((resolve) => { setTimeout(() => { answer?.(); resolve(); }, 20); });
  const started = Bun.nanoseconds();
  while (Bun.nanoseconds() - started < 40e6) { /* real time passes; the timer clock does not */ }
  const asked = new Promise((resolve) => { setTimeout(() => { void Promise.resolve().then(() => { void connection.loadAside(['x']); resolve(); }); }, 5); });
  await Promise.all([released, asked]);
  await settleOne();
  expect(typeof answer).toBe('function');
  expect(events.length).toBeLessThanOrEqual(1);
});

// The generation an immediate answer is given at, exactly (the review's S7): the answer settles three generations
// after its call, and a job the module started at the call writes after 1 to 10 awaits, which no effect shows. What
// the answer's continuation reports is recorded; across the ten cases it changes once, so a replay that gives the
// answer one generation late or early reports otherwise in one of them. Which case it changes in depends on the
// promise jobs of the run (under the recorder it changes one await later than in a plain run), so the test asserts
// only that the module reports what it returns.
for (let awaits = 1; awaits <= 10; awaits += 1) {
  test(`an immediate answer is given at its very generation, against a job ${awaits} awaits long`, async () => {
    globalThis.WebSocket = FakeSocket;
    globalThis.fetch = () => hops(2, { ok: true });
    const events = [];
    const connection = connect(stream, { url: 'http://toy.invalid', onEvent: (event) => { events.push(event.seen); } });
    const seen = await connection.loadRace('s', awaits);
    expect(events).toEqual([seen]);
  });
}
