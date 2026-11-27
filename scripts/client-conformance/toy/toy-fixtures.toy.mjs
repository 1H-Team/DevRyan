// A toy test that calls a family's entry through a helper the naming rule
// does not call test code (self-test corpus of the client conformance
// harness): the calls are passed through, so its case has no step, and the
// family command reports the helper as an unclassified caller. Run only by the harness.
import { expect, test } from 'bun:test';
import { seedTwice } from './toy-fixtures.mjs';
import { createState } from './toy-reducer.mjs';

test('a helper named as no test seeds the state', () => {
  const draft = createState();
  expect(seedTwice(draft)).toBe(true);
  expect(draft.order).toEqual(['f1', 'f2']);
});
