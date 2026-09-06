import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { createStore } from 'zustand/vanilla';
import {
  subscribeToSessionBranch,
  selectSessionById,
  selectSessionChildren,
  selectSessionDirectoryById,
} from './session-selectors';

const session = (id: string, parentID?: string): Session => ({
  id,
  parentID,
  directory: '/workspace',
  title: id,
  time: { created: 1, updated: 1 },
} as Session);

describe('stable session selectors', () => {
  test('unrelated create, update, and delete events preserve leaf snapshots', () => {
    const parent = session('parent');
    const child = session('child', parent.id);
    const unrelated = session('unrelated');
    const initial = [parent, child, unrelated];
    const initialChildren = selectSessionChildren(initial, parent.id);

    const afterCreate = [...initial, session('created')];
    const afterUpdate = afterCreate.map((candidate) => (
      candidate.id === unrelated.id
        ? { ...candidate, title: 'updated', time: { ...candidate.time, updated: 2 } }
        : candidate
    ));
    const afterDelete = afterUpdate.filter((candidate) => candidate.id !== 'created');

    for (const sessions of [afterCreate, afterUpdate, afterDelete]) {
      expect(selectSessionById(sessions, child.id)).toBe(child);
      expect(selectSessionDirectoryById(sessions, child.id)).toBe('/workspace');
      expect(selectSessionChildren(sessions, parent.id, initialChildren)).toBe(initialChildren);
    }
  });

  test('target child reference and membership changes publish a new snapshot', () => {
    const parent = session('parent');
    const child = session('child', parent.id);
    const previous = selectSessionChildren([parent, child], parent.id);
    const updatedChild = { ...child, title: 'updated child' };
    const updated = selectSessionChildren([parent, updatedChild], parent.id, previous);
    const added = selectSessionChildren([parent, updatedChild, session('child-2', parent.id)], parent.id, updated);
    const removed = selectSessionChildren([parent], parent.id, added);

    expect(updated).not.toBe(previous);
    expect(updated).toEqual([updatedChild]);
    expect(added).not.toBe(updated);
    expect(added.map((candidate) => candidate.id)).toEqual(['child', 'child-2']);
    expect(removed).not.toBe(added);
    expect(removed).toEqual([]);
  });

  test('only session branch changes notify real subscribers, and unsubscribe detaches them', () => {
    const sessions = [session('parent')];
    const store = createStore(() => ({ session: sessions, text: '' }));
    let notifications = 0;
    const unsubscribe = subscribeToSessionBranch(store, () => { notifications += 1; });

    for (let index = 0; index < 60; index += 1) {
      store.setState({ text: `stream chunk ${index}` });
    }
    expect(notifications).toBe(0);
    store.setState({ session: [...sessions, session('child', 'parent')] });
    expect(notifications).toBe(1);
    unsubscribe();
    store.setState({ session: [] });
    expect(notifications).toBe(1);
  });
});
