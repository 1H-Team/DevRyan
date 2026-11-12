// Harness-owned toy "engine module" that no family of the toy port map owns
// (self-test corpus of the client conformance harness): what it does with a
// family's entry is its own behaviour, so the recorder passes such a call
// through and counts it, and records only the calls the test makes itself.
// Product code never imports it.
import { log } from './toy-log.mjs';
import { applyEvent } from './toy-reducer.mjs';
import { after, later, seed, visit, whenSettled } from './toy-sched.mjs';

// Not a tail call: Bun's transpiler may turn `const x = f(); return x` into
// `return f()`, and a proper tail call removes this frame, so the call would
// look like the test's own (docs/TESTING.md, the caller rule).
export function relay(draft, event) {
  const changed = applyEvent(draft, event);
  return changed ? 'changed' : 'unchanged';
}

// A port of two families (toy-log's log), used by this unmapped module with no engine chain: its own
// dependency, passed through, never a flag of those families.
export function note(text) {
  const tagged = log('host', text);
  return tagged.length;
}

// A call the host schedules with no function of its own around it: the job that runs the bound entry has
// no frame with a file at all. The toy census names it (noFrame), so it is passed through and counted.
export function relaySoon(draft, event) {
  queueMicrotask(applyEvent.bind(null, draft, event));
}

// The host hands the test's callback to a family's entry, which is passed through: the callback runs
// later (a timer, a promise) or at once (a loop), and what it calls is the test's.
export function hostAfter(callback) {
  const scheduled = after(callback);
  return scheduled.length;
}
export function hostWhenSettled(promise, callback) {
  const registered = whenSettled(promise, callback);
  return registered.length;
}
export function hostVisit(list, callback) {
  const results = visit(list, callback);
  return results.length;
}
export function hostLater(draft) {
  const scheduled = later(draft);
  return scheduled.length;
}
export function hostSeed(draft) {
  const noted = seed(draft);
  return noted.length;
}
