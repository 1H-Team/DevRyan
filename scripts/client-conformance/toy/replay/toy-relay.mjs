// Harness-owned toy family of the replayer's self-test (client conformance
// harness, package C0d): a pure family whose calls the replayer must
// reproduce exactly. It does work in a microtask after it returned, and after
// a chain of four (so a replayer that does not wait for quiescence puts that
// effect in the wrong step), makes two port calls in one step (their order is compared), keeps a
// hidden counter in module state that no export snapshots (a case replayed
// alone sees a fresh module, a case replayed in file order sees what the
// earlier cases left), aliases objects in what it returns, measures and trims
// UTF-16 text, and mutates a draft copy-on-write with a clock time and a
// random id. Product code never imports it.
import { log } from '../toy-log.mjs';

let calls = 0;

export function relay(items) {
  Promise.resolve().then(() => log('relay', String(items.length)));
  return 'queued';
}

// Its effect comes four promise jobs after the return: a replayer that waits one microtask is not quiet yet.
export function settle(items) {
  Promise.resolve().then(() => undefined).then(() => undefined).then(() => undefined).then(() => log('settled', String(items.length)));
  return 'later';
}

export function tally(name) {
  calls += 1;
  return `${name}:${calls}`;
}

// One port call before the return (recording 7 holds where each effect sits relative to the return).
export function note(text) {
  log('note', text);
  return text.length;
}

export function pair(first, second) {
  const a = log('first', first);
  const b = log('second', second);
  return [a, b];
}

export function share(event) {
  const tag = { kind: event.kind };
  return { left: tag, right: tag, event };
}

export function label(text) {
  if (typeof text !== 'string') throw new TypeError(`label needs text, got ${typeof text}`);
  return { text: text.trim(), units: text.length };
}

export function ids() {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  return [first, second];
}

export function stamp(draft, key) {
  draft.items = { ...draft.items, [key]: { at: Date.now(), id: crypto.randomUUID() } };
  draft.count += 1;
  return Object.keys(draft.items).length;
}
