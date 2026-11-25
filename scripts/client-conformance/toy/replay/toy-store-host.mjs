// Harness-owned host of the replayer's store toy (client conformance harness,
// package C0e): a module no family maps that writes or reads the toy store. A
// test whose call of it changes the store's state or its module state outside
// the family's steps is flagged `state-moved` (unrecordable: the replay could
// not know); one that only reads is not. A test whose call writes a box the
// family handed out is flagged `handed-out-touched`.
import { boxOf, counterStore } from './toy-store.mjs';

export function addFromHost(item) {
  counterStore.getState().add(item);
}

/** Module state changed with no notification (the store's `remember` writes a module Map). */
export function rememberFromHost(key, value) {
  counterStore.getState().remember(key, value);
}

/** A read only: the state is what it was. */
export function recallFromHost(key) {
  return counterStore.getState().recall(key);
}

/** Writes the box kept under `name` through the family's own reference to it, never through what the test was handed. */
export function fillBox(name, item) {
  const box = boxOf(name);
  box.setState((state) => ({ items: [...state.items, item] }));
}
