// Toy tests of when inputs arrive (package C0f). The gate toy's releases again, with the signal arriving after the
// waiter's step ran out (a macrotask between them): the two inputs are not `together`, so the waiter's continuation
// is the signal step's by its release window alone, not because the waiter's step forwards to the signal's. And a
// fixture: a call whose continuation is still running when the next call of its family comes, in the same microtask
// drain (interleaved, which TOY_UNRECORDABLE lists). The self-test corpus of the client conformance harness records
// them. Run only by the harness.
import { expect, test } from 'bun:test';
import { eager, eagerLater, signal, signalResolvers, wait, waitDeep, waitResolvers } from './toy-gate.mjs';

const ranOut = () => new Promise((resolve) => { setImmediate(resolve); });

test('a waiter wakes in the step of a signal that came after the waiter ran out', async () => {
  const pending = wait('after');
  await ranOut();
  expect(signal('after', 3)).toBe(true);
  expect(await pending).toBe(3);
});

test('a waiter many promise generations from its gate wakes in the step of a later signal', async () => {
  const pending = waitDeep('after-deep', 6);
  await ranOut();
  signal('after-deep', 4);
  expect(await pending).toBe(4);
});

test('a gate made by Promise.withResolvers releases its waiter in a later signal step', async () => {
  const pending = waitResolvers('after-resolvers');
  await ranOut();
  expect(signalResolvers('after-resolvers', 7)).toBe(true);
  expect(await pending).toBe(7);
});

// The first call yields twice before it acts; the test calls again after one job, once the first call's marker ran:
// the second call is not together with the first, and the first call's effect lands after it opened, in its drain.
test('a call still running when the next call comes in its drain is interleaved', async () => {
  const pending = eagerLater('interleaved');
  await null;
  await eager('interleaved-next');
  expect(await pending).toBe('later');
});
