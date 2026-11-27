// Toy tests that overlap (test.concurrent): their cases cannot be told
// apart, so the recorder marks them unrecordable instead of naming them by
// order. The first waits for the second to release it, so the overlap and
// the order do not depend on timing. The self-test corpus of the client
// conformance harness records them.
import { expect, test } from 'bun:test';
import { applyEvent, createState } from './toy-reducer.mjs';

let releaseOne = null;
const oneMayFinish = new Promise((resolve) => { releaseOne = resolve; });

test.concurrent('concurrent one', async () => {
  const draft = createState();
  await oneMayFinish;
  expect(applyEvent(draft, { type: 'session.created', id: 'one', title: 'one' })).toBe(true);
});

test.concurrent('concurrent two', async () => {
  const draft = createState();
  await null;
  expect(applyEvent(draft, { type: 'session.created', id: 'two', title: 'two' })).toBe(true);
  releaseOne();
});

test('a test after them is recorded as usual', () => {
  expect(applyEvent(createState(), { type: 'probe' })).toBe('idle');
});
