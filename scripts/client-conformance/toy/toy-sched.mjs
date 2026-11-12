// Harness-owned toy family that hands the caller's callbacks on (self-test
// corpus of the client conformance harness): to a timer, to a promise, to a
// loop. Called through the unmapped toy host, it is passed through, and the
// test's own callbacks must still be the test's (the caller rule).
// Product code never imports it.
import { log } from './toy-log.mjs';
import { applyEvent } from './toy-reducer.mjs';

export function after(callback) {
  setTimeout(callback, 0);
  return 'scheduled';
}

export function whenSettled(promise, callback) {
  promise.then(callback);
  return 'registered';
}

export function visit(list, callback) {
  const out = [];
  for (const item of list) out.push(callback(item));
  return out;
}

// Runs the caller's callback inside this family's chain; no injected port declares it (toy-unrecordable.toy.mjs).
export function withCallback(callback) {
  const got = callback(1);
  return { got };
}

// Engine code put on a timer by a call that is passed through runs with no store at all (the store holds for
// the call's synchronous extent only): its port use is engine code outside any chain, flagged.
export function later(draft) {
  setTimeout(() => { const changed = applyEvent(draft, { type: 'session.created', id: 'later', title: 'by a timer' }); const noted = log('later', String(changed)); draft.noted = noted; }, 0);
  return 'scheduled';
}

// Another family's entry and a port, used inside this family's own code: when the call is passed through,
// both are counted as made inside a pass-through call.
export function seed(draft) {
  const changed = applyEvent(draft, { type: 'session.created', id: 'seeded', title: 'by the scheduler' });
  const noted = log('seed', String(changed));
  // A template, not `return noted`: Bun may make `const x = f(); return x` a tail call, which drops this frame.
  return `${noted}`;
}
