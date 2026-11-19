// Toy tests of the harness-owned timer module: the self-test corpus of the
// client conformance harness records them. Run only by the harness.
import { expect, test } from 'bun:test';
import { createDebouncer } from './toy-timers.mjs';

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('a pushed item flushes after the delay', async () => {
  const batches = [];
  const debouncer = createDebouncer({ delay: 15, onFlush: (batch, at) => { batches.push({ size: batch.length, at }); } });
  debouncer.push('a');
  debouncer.push('b');
  await wait(40);
  expect(batches).toHaveLength(1);
  expect(batches[0].size).toBe(2);
  expect(debouncer.state().armed).toBe(false);
});

test('an early flush clears the timer', () => {
  const sizes = [];
  const debouncer = createDebouncer({ delay: 1000, onFlush: (batch) => { sizes.push(batch.length); } });
  debouncer.push('a');
  expect(debouncer.flush()).toBe(1);
  expect(debouncer.flush()).toBe(0);
  expect(sizes).toEqual([1]);
});

test('a heartbeat interval runs until it is stopped', async () => {
  let beats = 0;
  let stop = null;
  const done = new Promise((resolve) => {
    const debouncer = createDebouncer({ delay: 10, onFlush: () => { beats += 1; if (beats === 3) { stop(); resolve(); } } });
    stop = debouncer.heartbeat(5);
  });
  await done;
  expect(beats).toBe(3);
});

test('a timer trap the test assigns is still recorded', () => {
  const original = globalThis.setTimeout;
  const trapped = [];
  globalThis.setTimeout = (callback, delay) => { trapped.push(delay); callback(); return 0; };
  try {
    const sizes = [];
    const debouncer = createDebouncer({ delay: 25, onFlush: (batch) => { sizes.push(batch.length); } });
    debouncer.push('now');
    expect(trapped).toEqual([25]);
    expect(sizes).toEqual([1]);
  } finally {
    globalThis.setTimeout = original;
  }
  expect(globalThis.setTimeout).toBe(original);
});
