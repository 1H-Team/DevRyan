import { getPartChangeHints } from './part-change-hints';
import type { StoreApi } from 'zustand/vanilla';
import type { State } from './types';

// One directory observer indexes the mounted sessions' message IDs. Unrelated
// part/status events never ask each mounted transcript to rebuild its snapshot.
type Group = { listeners: Set<() => void>; messageIDs: Set<string> };
type Observer = { groups: Map<string, Group>; unsubscribe: () => void };
const observers = new WeakMap<StoreApi<State>, Observer>();

export function subscribeSessionRecords(store: StoreApi<State>, sessionID: string, notify: () => void): () => void {
  if (!sessionID) return () => {};
  let observer = observers.get(store);
  if (!observer) {
    const groups = new Map<string, Group>();
    const unsubscribe = store.subscribe((next, previous) => {
      const hintedMessages = next.part !== previous.part ? getPartChangeHints(next.part, previous.part) : undefined;
      for (const [id, group] of groups) {
        const listChanged = next.message[id] !== previous.message[id];
        if (listChanged) group.messageIDs = new Set(next.message[id]?.map(message => message.id));
        const revertChanged = next.revert_transaction[id] !== previous.revert_transaction[id]
          || (next.session !== previous.session
            && next.session.find(session => session.id === id)?.revert !== previous.session.find(session => session.id === id)?.revert);
        let partsChanged = false;
        if (next.part !== previous.part) {
          for (const messageID of hintedMessages ?? group.messageIDs) {
            if ((!hintedMessages || group.messageIDs.has(messageID)) && next.part[messageID] !== previous.part[messageID]) { partsChanged = true; break; }
          }
        }
        if (!listChanged && !revertChanged && !partsChanged) continue;
        for (const listener of group.listeners) listener();
      }
    });
    observer = { groups, unsubscribe };
    observers.set(store, observer);
  }
  let group = observer.groups.get(sessionID);
  if (!group) {
    group = { listeners: new Set(), messageIDs: new Set(store.getState().message[sessionID]?.map(message => message.id)) };
    observer.groups.set(sessionID, group);
  }
  group.listeners.add(notify);
  const owned = observer;
  return () => {
    group.listeners.delete(notify);
    if (group.listeners.size === 0) owned.groups.delete(sessionID);
    if (owned.groups.size === 0) { owned.unsubscribe(); observers.delete(store); }
  };
}
