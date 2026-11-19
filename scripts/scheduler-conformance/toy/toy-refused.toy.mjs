// What the recorder must refuse loudly (target-refused.json): each hidden
// read here is a recorder error, except a test's own call of the helper the
// spec names `direct`, and a test that spins on Date.now() waiting for time
// to pass fails under the nominal clock instead of hanging. Listeners of a
// scheduler an earlier test built fire in a test that builds none, in the
// hooks after the last test (this file's afterAll runs before the
// recorder's), and after the recording was written (an immediate the
// afterAll leaves): each is still an error.
import { afterAll, expect, test } from 'bun:test';
import { createManagedTaskScheduler, directId } from './toy-refused.mjs';

test('a draw at a line no site names', () => {
  expect(createManagedTaskScheduler().unnamed()).toBe(36);
});

test('a draw in tail position', () => {
  expect(createManagedTaskScheduler().tail().length).toBe(36);
});

test('a draw in an event listener', () => {
  const scheduler = createManagedTaskScheduler();
  const controller = new AbortController();
  expect(scheduler.listen(controller.signal)).toBe(true);
  controller.abort();
  expect(scheduler.seen()).toBe('string');
});

test('spins on Date.now() waiting for time to pass', () => {
  createManagedTaskScheduler();
  const start = Date.now();
  let spins = 0;
  while (Date.now() - start < 2 && spins < 20_000_000) spins += 1;
  expect(spins).toBeLessThan(20_000_000);
});

test('a test calls the helper the spec names direct', () => {
  expect(directId().length).toBe(36);
});

const nextTest = new AbortController();
const hooks = new AbortController();
const afterWrite = new AbortController();
test('arms listeners that fire later', () => {
  const scheduler = createManagedTaskScheduler();
  expect(scheduler.listen(nextTest.signal)).toBe(true);
  expect(scheduler.listenEnv(hooks.signal) && scheduler.listenDirect(hooks.signal)).toBe(true);
  expect(scheduler.listen(afterWrite.signal)).toBe(true);
});

test('a listener of the previous test fires in a test that builds none', () => {
  nextTest.abort();
  expect(nextTest.signal.aborted).toBe(true);
});

afterAll(() => {
  hooks.abort();
  setImmediate(() => { afterWrite.abort(); });
});
