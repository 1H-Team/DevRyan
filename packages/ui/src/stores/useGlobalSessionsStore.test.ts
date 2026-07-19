import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  beginGlobalSessionMembershipMutation,
  queueGlobalSessionsRefreshAfterMutation,
  settleGlobalSessionMembershipMutation,
  type GlobalSessionMembershipMutationHandle,
  useGlobalSessionsStore,
} from './useGlobalSessionsStore';

const session = (id: string, directory: string, parentID?: string, archivedAt?: number): Session => ({
  id,
  title: id,
  time: {
    created: 1,
    updated: 2,
    ...(archivedAt ? { archived: archivedAt } : {}),
  },
  directory,
  ...(parentID ? { parentID } : {}),
} as unknown as Session);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('useGlobalSessionsStore snapshot helpers', () => {
  const mutationHandles: GlobalSessionMembershipMutationHandle[] = [];

  beforeEach(() => {
    for (const handle of mutationHandles.splice(0)) {
      settleGlobalSessionMembershipMutation(handle, {
        successfulIds: [],
        failedIds: handle.entries.map((entry) => entry.sessionID),
      });
    }
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      hasLoaded: true,
      status: 'ready',
    });
  });

  const beginMutation = (
    input: Parameters<typeof beginGlobalSessionMembershipMutation>[0],
  ): GlobalSessionMembershipMutationHandle => {
    const handle = beginGlobalSessionMembershipMutation(input);
    mutationHandles.push(handle);
    return handle;
  };

  test('archiveSessionSnapshots moves captured active sessions into archived sessions', () => {
    const parent = session('parent', '/repo');
    const child = session('child', '/repo', 'parent');
    const unrelated = session('unrelated', '/repo');

    useGlobalSessionsStore.getState().applySnapshot([parent, child, unrelated], []);

    useGlobalSessionsStore.getState().removeSessions(['parent', 'child']);
    useGlobalSessionsStore.getState().archiveSessionSnapshots([parent, child], 100);

    const state = useGlobalSessionsStore.getState();
    expect(state.activeSessions.map((item) => item.id)).toEqual(['unrelated']);
    expect(state.archivedSessions.map((item) => item.id)).toEqual(['parent', 'child']);
    expect(state.archivedSessions.map((item) => item.time?.archived)).toEqual([100, 100]);
    expect(state.sessionsByDirectory.get('/repo')?.map((item) => item.id)).toEqual(['unrelated']);
  });

  test('restoreSessions restores active and archived snapshots to their original buckets', () => {
    const active = session('active-failed', '/repo');
    const archived = session('archived-failed', '/repo', undefined, 50);

    useGlobalSessionsStore.getState().applySnapshot([], []);

    useGlobalSessionsStore.getState().restoreSessions([active, archived]);

    const state = useGlobalSessionsStore.getState();
    expect(state.activeSessions.map((item) => item.id)).toEqual(['active-failed']);
    expect(state.archivedSessions.map((item) => item.id)).toEqual(['archived-failed']);
    expect(state.sessionsByDirectory.get('/repo')?.map((item) => item.id)).toEqual(['active-failed']);
  });

  test('keeps newer global metadata when an older title or archive echo arrives', () => {
    const current = {
      ...session('fresh', '/repo'),
      title: 'Newest title',
      time: { created: 1, updated: 10 },
    } as Session;
    useGlobalSessionsStore.getState().applySnapshot([current], []);
    const before = useGlobalSessionsStore.getState();

    useGlobalSessionsStore.getState().upsertSession({
      ...current,
      title: 'Older title',
      time: { created: 1, updated: 9 },
    } as Session);
    useGlobalSessionsStore.getState().upsertSession({
      ...current,
      time: { created: 1, updated: 9, archived: 9 },
    } as Session);

    const after = useGlobalSessionsStore.getState();
    expect(after.activeSessions).toBe(before.activeSessions);
    expect(after.archivedSessions).toBe(before.archivedSessions);
    expect(after.activeSessions[0]).toBe(current);
  });

  test('allows an equal-timestamp archive update to change membership', () => {
    const current = {
      ...session('equal-archive', '/repo'),
      time: { created: 1, updated: 10 },
    } as Session;
    useGlobalSessionsStore.getState().applySnapshot([current], []);

    useGlobalSessionsStore.getState().upsertSession({
      ...current,
      time: { created: 1, updated: 10, archived: 10 },
    } as Session);

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(useGlobalSessionsStore.getState().archivedSessions.map((item) => item.id)).toEqual([current.id]);
  });

  test('keeps a successfully archived session archived when a stale snapshot resolves last', () => {
    const active = session('archive-race', '/repo');
    const optimisticArchived = session('archive-race', '/repo', undefined, 100);
    const authoritativeArchived = session('archive-race', '/repo', undefined, 110);
    useGlobalSessionsStore.getState().applySnapshot([active], []);

    const handle = beginMutation({
      kind: 'archive',
      sessionIds: [active.id],
      snapshots: [active],
      archivedAt: 100,
    });
    settleGlobalSessionMembershipMutation(handle, { successfulIds: [active.id], failedIds: [] });

    useGlobalSessionsStore.getState().applySnapshot([active], []);
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([optimisticArchived]);

    useGlobalSessionsStore.getState().applySnapshot([], [authoritativeArchived]);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([authoritativeArchived]);

    useGlobalSessionsStore.getState().applySnapshot([active], []);
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([active]);
  });

  test('does not resurrect successfully deleted archived sessions from a stale snapshot', () => {
    const archivedA = session('delete-race-a', '/repo', undefined, 50);
    const archivedB = session('delete-race-b', '/repo', undefined, 60);
    useGlobalSessionsStore.getState().applySnapshot([], [archivedA, archivedB]);

    const handle = beginMutation({
      kind: 'delete',
      sessionIds: [archivedA.id, archivedB.id],
    });
    settleGlobalSessionMembershipMutation(handle, {
      successfulIds: [archivedA.id, archivedB.id],
      failedIds: [],
    });

    useGlobalSessionsStore.getState().applySnapshot([], [archivedA, archivedB]);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([]);

    useGlobalSessionsStore.getState().applySnapshot([], []);
    useGlobalSessionsStore.getState().applySnapshot([], [archivedA]);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([archivedA]);
  });

  test('keeps a successfully unarchived session active when a stale archived snapshot resolves last', () => {
    const archived = session('unarchive-race', '/repo', undefined, 70);
    const active = session('unarchive-race', '/repo');
    useGlobalSessionsStore.getState().applySnapshot([], [archived]);

    const handle = beginMutation({
      kind: 'unarchive',
      sessionIds: [archived.id],
      snapshots: [archived],
    });
    settleGlobalSessionMembershipMutation(handle, { successfulIds: [archived.id], failedIds: [] });

    useGlobalSessionsStore.getState().applySnapshot([], [archived]);
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([active]);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([]);

    useGlobalSessionsStore.getState().applySnapshot([active], []);
    useGlobalSessionsStore.getState().applySnapshot([], [archived]);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([archived]);
  });

  test('restores only failed archive sessions while keeping successful sessions protected', () => {
    const successful = session('archive-partial-success', '/repo');
    const failed = session('archive-partial-failure', '/repo');
    useGlobalSessionsStore.getState().applySnapshot([successful, failed], []);

    const handle = beginMutation({
      kind: 'archive',
      sessionIds: [successful.id, failed.id],
      snapshots: [successful, failed],
      archivedAt: 100,
    });
    settleGlobalSessionMembershipMutation(handle, {
      successfulIds: [successful.id],
      failedIds: [failed.id],
    });
    useGlobalSessionsStore.getState().restoreSessions([failed]);

    useGlobalSessionsStore.getState().applySnapshot([successful, failed], []);
    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual([failed.id]);
    expect(useGlobalSessionsStore.getState().archivedSessions.map((item) => item.id)).toEqual([successful.id]);
  });

  test('does not clear delete protection from incomplete or failed global snapshots', () => {
    const archived = session('delete-incomplete', '/repo', undefined, 80);
    useGlobalSessionsStore.getState().applySnapshot([], [archived]);

    const handle = beginMutation({ kind: 'delete', sessionIds: [archived.id] });
    settleGlobalSessionMembershipMutation(handle, { successfulIds: [archived.id], failedIds: [] });

    useGlobalSessionsStore.getState().applySnapshot([], [], 'ready', {
      activeComplete: true,
      archivedComplete: false,
    });
    useGlobalSessionsStore.getState().applySnapshot([], [], 'error', {
      activeComplete: false,
      archivedComplete: false,
    });
    useGlobalSessionsStore.getState().applySnapshot([], [archived]);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([]);
  });

  test('ignores settlement from an older opposite mutation for the same session', () => {
    const active = session('overlapping-membership', '/repo');
    useGlobalSessionsStore.getState().applySnapshot([active], []);

    const archiveHandle = beginMutation({
      kind: 'archive',
      sessionIds: [active.id],
      snapshots: [active],
      archivedAt: 100,
    });
    const optimisticArchived = useGlobalSessionsStore.getState().archivedSessions[0];
    const unarchiveHandle = beginMutation({
      kind: 'unarchive',
      sessionIds: [active.id],
      snapshots: [optimisticArchived],
    });

    settleGlobalSessionMembershipMutation(archiveHandle, { successfulIds: [active.id], failedIds: [] });
    useGlobalSessionsStore.getState().applySnapshot([], [optimisticArchived]);

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual([active.id]);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([]);

    settleGlobalSessionMembershipMutation(unarchiveHandle, { successfulIds: [active.id], failedIds: [] });
  });

  test('queues a fresh global load when another mutation settles during reconciliation', async () => {
    const originalLoadSessions = useGlobalSessionsStore.getState().loadSessions;
    const firstLoad = deferred<{ activeSessions: Session[]; archivedSessions: Session[] }>();
    const secondLoad = deferred<{ activeSessions: Session[]; archivedSessions: Session[] }>();
    let loadCount = 0;
    useGlobalSessionsStore.setState({
      loadSessions: () => {
        loadCount += 1;
        return loadCount === 1 ? firstLoad.promise : secondLoad.promise;
      },
    });

    try {
      const firstRefresh = queueGlobalSessionsRefreshAfterMutation();
      await Promise.resolve();
      expect(loadCount).toBe(1);

      const secondRefresh = queueGlobalSessionsRefreshAfterMutation();
      await Promise.resolve();
      expect(loadCount).toBe(1);

      firstLoad.resolve({ activeSessions: [], archivedSessions: [] });
      await Promise.resolve();
      await Promise.resolve();
      expect(loadCount).toBe(2);

      secondLoad.resolve({ activeSessions: [], archivedSessions: [] });
      await Promise.all([firstRefresh, secondRefresh]);
    } finally {
      useGlobalSessionsStore.setState({ loadSessions: originalLoadSessions });
    }
  });
});
