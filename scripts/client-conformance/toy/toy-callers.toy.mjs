// Toy tests of the caller rule (self-test corpus of the client conformance
// harness): a test callback that a passed-through call schedules on a timer
// or a promise, or runs at once, is the test's, and so are the calls of test
// helpers the naming rule calls test code. Run only by the harness.
import { describe, expect, test } from 'bun:test';
import { hideMessage } from './toy-steps_test.mjs';
import { seedSession } from './__tests__/toy-steps.mjs';
import { hostAfter, hostSeed, hostVisit, hostWhenSettled } from './toy-host.mjs';
import { applyEvent, createState } from './toy-reducer.mjs';
import { visit } from './toy-sched.mjs';

describe('toy callers', () => {
  test('a callback a passed-through call puts on a timer is the test\'s', async () => {
    const draft = createState();
    await new Promise((resolve) => {
      hostAfter(() => { draft.result = applyEvent(draft, { type: 'session.created', id: 't1', title: 'from a timer' }); resolve(); });
    });
    expect(draft.order).toEqual(['t1']);
  });

  test('a callback a passed-through call hangs on a promise is the test\'s', async () => {
    const draft = createState();
    await new Promise((resolve) => {
      hostWhenSettled(Promise.resolve(1), () => { draft.result = applyEvent(draft, { type: 'session.created', id: 'p1', title: 'from a promise' }); resolve(); });
    });
    expect(draft.order).toEqual(['p1']);
  });

  test('a callback a passed-through call runs at once is the test\'s', () => {
    const draft = createState();
    const seen = [];
    expect(hostVisit(['v1', 'v2'], (id) => { seen.push(applyEvent(draft, { type: 'session.created', id, title: 'from a loop' })); })).toBe(2);
    expect(seen).toEqual([true, true]);
  });

  test('a family\'s entry the test calls with its callback', () => {
    expect(visit([1, 2], (value) => { const doubled = value * 2; return doubled; })).toEqual([2, 4]);
  });

  test('what a passed-through call does in turn is counted as passed through, never a step', () => {
    const draft = createState();
    expect(hostSeed(draft)).toBe('seed:true'.length);
    expect(draft.order).toEqual(['seeded']);
  });

  test('helpers under __tests__ and named name_test are test code', () => {
    const draft = createState();
    expect(seedSession(draft, 'h1')).toBe(true);
    expect(hideMessage(draft, 'm1')).toBe(true);
    expect([...draft.hidden]).toEqual(['m1']);
  });
});
