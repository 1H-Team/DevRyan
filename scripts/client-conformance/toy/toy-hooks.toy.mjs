// Toy tests of what runs outside a test: module load, beforeAll, a
// describe's beforeAll and afterAll and the file's afterAll call the engine
// too. The self-test corpus of the client conformance harness records them.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDebouncer } from './toy-timers.mjs';

const flushed = [];
const atLoad = createDebouncer({ delay: 1000, onFlush: (batch) => { flushed.push(['load', batch.length]); } });
atLoad.push('at module load');

beforeAll(() => { atLoad.push('in beforeAll'); });
afterAll(() => {
  atLoad.flush();
  expect(flushed).toEqual([['load', 2], ['describe', 1]]);
});

test('a test after the prelude sees what it left', () => {
  expect(atLoad.state().pending).toBe(2);
  expect(atLoad.flush()).toBe(2);
});

describe('a describe with its own hooks', () => {
  let inner = null;
  beforeAll(() => { inner = createDebouncer({ delay: 1000, onFlush: (batch) => { flushed.push(['describe', batch.length]); } }); inner.push('describe beforeAll'); });
  afterAll(() => { inner.flush(); });
  test('a test inside the describe', () => {
    expect(inner.state().pending).toBe(1);
  });
});

test('a test after the describe', () => {
  expect(flushed).toEqual([['load', 2], ['describe', 1]]);
});
