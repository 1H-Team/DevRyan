// Toy tests of timers a test leaves behind (package C0c2, the per-case
// clock): the first test sets an engine timer of each of two families and a
// timer of its own, and ends without waiting for them; the second test lets
// real time pass (TOY_STRAY_WAIT_MS, default 60: the strays then fire before
// its first clock read; 0: they fire later) and reads the clock through the
// engine; the third waits for the strays. Whenever the strays fire, the first
// case has recorded them as pending at its end, their firing is recorded
// nowhere (C0e fix round: a timer that fires after its test ended is no step),
// and they never move the clock of a later one. The fourth polls every millisecond until its own 10 ms timer
// fires, after blocking for the same wait, so its own clock ends at another
// time by the wait; the fifth still opens in its own slot of the file's time.
// So two recordings made with different waits are byte-equal. The sixth moves
// time past its slot (fake timers advanced by 5 s), so the seventh opens where
// the sixth ended, later than its slot: time never runs backward. The
// eighth leaves a chain of test timers (a timer whose callback sets another),
// the ninth an I/O job that sets a timer, the tenth an I/O job that calls the
// engine after the test ended (no timer released it: a late step of the tenth
// case, at the tenth case's clock); the eleventh lets real time pass while they
// fire (before its clock read with the default wait, partly after it with 0):
// they are the eighth to tenth cases', so the eleventh's clock never moves with
// them. The twelfth sets the system time and leaves it standing; the
// thirteenth opens at that time and restores it.
// The self-test corpus of the client conformance harness records them.
import { readFile } from 'node:fs/promises';
import { expect, jest, setSystemTime, test } from 'bun:test';
import { later, readClock } from './toy-clock.mjs';
import { createDebouncer } from './toy-timers.mjs';

const WAIT_MS = Number(process.env.TOY_STRAY_WAIT_MS ?? '60');
const STRAY_MS = 30;
const fired = [];

test('a test that leaves timers behind', () => {
  const debouncer = createDebouncer({ delay: STRAY_MS, onFlush: (batch) => { fired.push(`flush ${batch.length}`); } });
  expect(debouncer.push('left behind')).toBe(1);
  // The second call is made by the first's continuation after this test ended, released by a late timer: recorded nowhere.
  later(STRAY_MS).then(async () => { await later(STRAY_MS); }).then(() => { fired.push('later'); });
  setTimeout(() => { fired.push('test timer'); }, STRAY_MS);
});

test('a later test reads its own clock while the strays fire', async () => {
  Bun.sleepSync(WAIT_MS);
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
  const [first] = readClock();
  expect(typeof first).toBe('number');
  await later(5);
  const [second] = readClock();
  expect(second >= first).toBe(true);
});

test('the strays have fired', async () => {
  await later(STRAY_MS * 4);
  expect([...fired].sort()).toEqual(['flush 1', 'later', 'test timer']);
  fired.length = 0;
});

test('a test that polls until its own timer fires ends earlier or later by load', async () => {
  let done = false;
  setTimeout(() => { done = true; }, 10);
  Bun.sleepSync(WAIT_MS);
  let polls = 0;
  while (!done) { polls += 1; await new Promise((resolve) => { setTimeout(resolve, 1); }); }
  expect(polls).toBeGreaterThan(0);
});

test('the next test opens in its own slot of the file\'s time', () => {
  const [now] = readClock();
  expect(typeof now).toBe('number');
});

test('a test whose fake timers move time past its slot', () => {
  jest.useFakeTimers();
  try { jest.advanceTimersByTime(5000); } finally { jest.useRealTimers(); }
  expect(readClock()[0]).toBeGreaterThan(0);
});

test('the test after it opens where it ended, never earlier', () => {
  const [now] = readClock();
  expect(typeof now).toBe('number');
});

test('a test that leaves a chain of test timers behind', () => {
  setTimeout(() => { setTimeout(() => { fired.push('inner'); }, 150); }, 100);
  expect(typeof readClock()[0]).toBe('number');
});

test('a test that leaves an I/O job behind that sets a timer', () => {
  readFile(import.meta.path).then(() => { setTimeout(() => { fired.push('job'); }, 150); });
  expect(typeof readClock()[0]).toBe('number');
});

test('a test that leaves an I/O job behind that calls the engine', () => {
  readFile(import.meta.path).then(() => { fired.push(`late read ${typeof readClock()[0]}`); });
  expect(typeof readClock()[0]).toBe('number');
});

test('a later test reads its clock while the chain and the job fire', async () => {
  Bun.sleepSync(WAIT_MS * 2);
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
  Bun.sleepSync(200);
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
  expect(typeof readClock()[0]).toBe('number');
  await later(250);
  expect(fired).toContain('inner');
  expect(fired).toContain('job');
});

test('a test that sets the system time and leaves it standing', () => {
  setSystemTime(new Date('2031-01-01T00:00:00Z'));
  expect(readClock()[0]).toBe(Date.parse('2031-01-01T00:00:00Z'));
});

test('the next test opens at the time that stands, and restores the clock', () => {
  const [now] = readClock();
  setSystemTime();
  expect(now).toBeGreaterThanOrEqual(Date.parse('2031-01-01T00:00:00Z'));
});
