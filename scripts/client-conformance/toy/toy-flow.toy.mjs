// Toy tests of the harness-owned flow module: the self-test corpus of the
// client conformance harness records them. Run only by the harness.
import { expect, test } from 'bun:test';
import { createFlow } from './toy-flow.mjs';
import { guard } from './toy-guard.mjs';

const make = () => {
  const events = [];
  const listeners = [];
  const sdk = {
    lookup: (key) => new Promise((resolve) => { setTimeout(() => resolve(key.toUpperCase()), 5); }),
    on: (listener) => { listeners.push(listener); listener('sync'); },
  };
  return { events, listeners, flow: createFlow(sdk, { onEvent: (event) => { events.push(event); } }) };
};

test('an answer belongs to the call that waited for it, not to a later call', async () => {
  const { events, flow } = make();
  const pending = flow.slow('a');
  flow.quick('b');
  expect(await pending).toBe('A');
  expect(events).toEqual(['quick:b', 'slow:A']);
});

test('a microtask continuation belongs to its own call', async () => {
  const { events, flow } = make();
  const pending = flow.microtask('c');
  flow.quick('d');
  await pending;
  expect(events).toEqual(['quick:d', 'micro:c']);
});

test('a timer an entry awaits owns what follows it', async () => {
  const { events, flow } = make();
  const pending = flow.sleep(5, 'x');
  flow.quick('y');
  await pending;
  expect(events).toEqual(['quick:y', 'slept:x']);
});

test('a callback a port invokes re-entrantly is during the subscribing step', () => {
  const { events, listeners, flow } = make();
  expect(flow.subscribe()).toBe(1);
  listeners[0]('later');
  expect(events).toEqual(['heard:sync', 'heard:later']);
});

test('a port that is another family\'s entry is a port call and that family\'s input', () => {
  const { events, flow } = make();
  expect(flow.check('aborted')).toBe('blocked');
  expect(guard('idle')).toBe('idle');
  expect(events).toEqual(['verdict:blocked']);
});

test('a thrown DOMException keeps its name and message', () => {
  const { flow } = make();
  expect(() => flow.abort('AbortError')).toThrow('stopped by AbortError');
  let caught = null;
  try { flow.abort('TimeoutError'); } catch (error) { caught = error; }
  expect(caught.name).toBe('TimeoutError');
});

test('returning the argument and returning a copy record differently', () => {
  const { flow } = make();
  const value = { k: 1 };
  expect(flow.same(value)).toBe(value);
  expect(flow.copy(value)).not.toBe(value);
  expect(flow.copy(value)).toEqual(value);
});
