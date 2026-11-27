// Harness-owned toy store and timer family of the replayer's self-test (client
// conformance harness, package C0e): a stateful family the replayer must
// reproduce exactly. A store with the zustand interface (getState, setState
// with a partial, an updater or a replacement, subscribe with (state, previous)
// and an unsubscribe), whose actions replace what they change and leave the
// rest alone, a module Map and counter beside it, a module port, and timers: a
// timeout, a timeout whose callback sets another, an interval its own callback
// clears, a clear by the caller, and a clock read. It also hands out stores of
// its own (boxes, kept in a module Map), and waits on a loader the caller hands
// in (a promise answer that may settle after the test ended). Product code
// never imports it.
import { log } from '../toy-log.mjs';

function createStore(initializer) {
  let state;
  const listeners = new Set();
  const getState = () => state;
  const setState = (partial, replace) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    if (Object.is(next, state)) return;
    const previous = state;
    state = replace ? next : { ...state, ...next };
    for (const listener of listeners) listener(state, previous);
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const api = { getState, setState, subscribe };
  state = initializer(setState, getState, api);
  return api;
}

const remembered = new Map();
const boxes = new Map();
let ticks = 0;

export const counterStore = createStore((set, get) => ({
  count: 0,
  items: [],
  tags: new Set(),
  add: (item) => set((state) => ({ items: [...state.items, item], count: state.count + 1 })),
  tag: (name) => set((state) => { const tags = new Set(state.tags); tags.add(name); return { tags }; }),
  keep: () => set(get()),
  remember: (key, value) => { remembered.set(key, value); },
  recall: (key) => remembered.get(key) ?? null,
  persist: () => log('persist', String(get().count)),
}));

export function later(ms, label) {
  return setTimeout(() => { log('later', label); }, ms);
}

/** A timer that writes the module state when it fires (the C0e fix round's pending timer: it fires after its test ended). */
export function rememberLater(ms, key) {
  return setTimeout(() => {
    remembered.set(key, 'fired');
    log('remembered', key);
  }, ms);
}

/** A timer whose callback logs once before it returns and once in the job it started. */
export function laterThen(ms, label) {
  return setTimeout(async () => {
    log('before', label);
    await null;
    log('after', label);
  }, ms);
}

export function chain(label) {
  setTimeout(() => {
    log('first', label);
    setTimeout(() => { log('second', label); }, 5);
  }, 1);
}

export function tickTwice(label) {
  const id = setInterval(() => {
    ticks += 1;
    log('tick', `${label}:${ticks}`);
    if (ticks % 2 === 0) clearInterval(id);
  }, 2);
  return 'ticking';
}

export function cancel(handle) {
  clearTimeout(handle);
  return 'cancelled';
}

export function stamp(label) {
  return `${label}@${Date.now()}`;
}

/** A store of its own the family hands out, kept by name. */
export function makeBox(name) {
  const box = createStore(() => ({ items: [] }));
  boxes.set(name, box);
  return box;
}

/** The box kept under `name` (a read), or null. */
export function boxOf(name) {
  return boxes.get(name) ?? null;
}

/** Waits on what the caller's loader answers, then adds it to the store. */
export async function loadInto(load) {
  const value = await load();
  counterStore.getState().add(value);
  return value;
}
