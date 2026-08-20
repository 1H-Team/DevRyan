import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  didSessionBranchChange,
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

  test('non-session store updates do not notify the session branch', () => {
    const sessions = [session('parent')];
    expect(didSessionBranchChange({ session: sessions }, { session: sessions })).toBe(false);
    expect(didSessionBranchChange({ session: [...sessions] }, { session: sessions })).toBe(true);
  });

  test('unrelated lifecycle events produce zero external-store render commits', () => {
    const parent = session('parent');
    const child = session('child', parent.id);
    const unrelated = session('unrelated');
    let exactSnapshot: Session | undefined = child;
    let directorySnapshot: string | undefined = '/workspace';
    let childrenSnapshot = selectSessionChildren([parent, child, unrelated], parent.id);
    let renderCommits = 0;

    const publish = (sessions: Session[]) => {
      const nextExact = selectSessionById(sessions, child.id);
      const nextDirectory = selectSessionDirectoryById(sessions, child.id);
      const nextChildren = selectSessionChildren(sessions, parent.id, childrenSnapshot);
      if (
        nextExact !== exactSnapshot
        || nextDirectory !== directorySnapshot
        || nextChildren !== childrenSnapshot
      ) {
        renderCommits += 1;
      }
      exactSnapshot = nextExact;
      directorySnapshot = nextDirectory;
      childrenSnapshot = nextChildren;
    };

    publish([parent, child, unrelated, session('created')]);
    publish([parent, child, { ...unrelated, title: 'updated' }]);
    publish([parent, child]);
    expect(renderCommits).toBe(0);

    publish([parent, { ...child, title: 'target updated' }]);
    expect(renderCommits).toBe(1);
  });
});
