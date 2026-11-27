// Toy fixture of the per-case clock (package C0c2): a promise reaction the
// module registered while it loaded runs with no test store, so a timer it
// sets has no known case; when that timer moves the clock of the case it was
// taken for, the case is flagged (`timer-owner-unknown`) rather than moved
// silently. A timer set from the callback of such a timer is the case's that
// timer was taken for (a known owner), so it moves that clock unflagged. The self-test corpus of the client conformance harness records
// it; TOY_UNRECORDABLE lists it.
import { expect, test } from 'bun:test';
import { readClock } from './toy-clock.mjs';

let kick = null;
const gate = new Promise((resolve) => { kick = resolve; });
const settled = gate.then(() => new Promise((resolve) => { setTimeout(resolve, 20); }));

test('a timer set by a job with no known case moves the clock and flags the case', async () => {
  kick();
  await settled;
  expect(typeof readClock()[0]).toBe('number');
});

let kickChain = null;
const chainGate = new Promise((resolve) => { kickChain = resolve; });
const chained = chainGate.then(() => new Promise((resolve) => { setTimeout(() => { setTimeout(resolve, 30); }, 0); }));

test('a timer set from the callback of a timer taken for this case is this case\'s, not of unknown owner', async () => {
  kickChain();
  await chained;
  expect(typeof readClock()[0]).toBe('number');
});
