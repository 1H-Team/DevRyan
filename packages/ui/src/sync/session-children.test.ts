import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  clearSessionChildrenForDirectory,
  ensureSessionChildrenFetch,
  getEffectiveSessionChildrenFetchStatus,
  getSessionChildrenFetchKey,
  mergeChildSessions,
  SESSION_CHILDREN_FETCH_TTL_MS,
} from './session-children';

const session = (id: string, parentID?: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  directory: '/repo',
  title: id,
  time: { created: 1, updated: 1 },
  ...(parentID ? { parentID } : {}),
} as Session);

describe('session children helpers', () => {
  test('merges child sessions without replacing root sessions', () => {
    const root = session('parent');
    const existingChild = session('child-existing', 'parent');
    const nextChild = session('child-next', 'parent');

    const merged = mergeChildSessions([root, existingChild], [nextChild]);

    expect(merged.map((entry) => entry.id).sort()).toEqual(['child-existing', 'child-next', 'parent']);
    expect(merged.find((entry) => entry.id === 'parent')).toBe(root);
  });

  test('replaces an existing child with the authoritative child snapshot', () => {
    const staleChild = session('child', 'parent');
    const freshChild = {
      ...session('child', 'parent'),
      title: 'Fresh child title',
      time: { created: 1, updated: 2 },
    } as Session;

    const merged = mergeChildSessions([session('parent'), staleChild], [freshChild]);

    expect(merged.find((entry) => entry.id === 'child')?.title).toBe('Fresh child title');
  });

  test('inherits the parent directory for child snapshots without directory metadata', () => {
    const parent = session('parent');
    const childWithoutDirectory = {
      id: 'child',
      slug: 'child',
      projectID: 'project',
      title: 'child',
      time: { created: 1, updated: 1 },
      parentID: 'parent',
    } as unknown as Session;

    const merged = mergeChildSessions([parent], [childWithoutDirectory], { directory: '/repo' });

    expect((merged.find((entry) => entry.id === 'child') as Session & { directory?: string })?.directory).toBe('/repo');
  });

  test('does not rewrite child snapshots that already have directory metadata', () => {
    const parent = session('parent');
    const childWithDirectory = {
      ...session('child', 'parent'),
      directory: '/other-repo',
    } as Session;

    const merged = mergeChildSessions([parent], [childWithDirectory], { directory: '/repo' });

    expect((merged.find((entry) => entry.id === 'child') as Session & { directory?: string })?.directory).toBe('/other-repo');
  });

  test('uses directory and parent session id for the fetch dedupe key', () => {
    expect(getSessionChildrenFetchKey('/repo', 'parent')).toBe('/repo::parent');
  });

  test('dedupes repeated child refreshes while a request is in flight', () => {
    const cache = new Map();
    let fetchCount = 0;
    const first = ensureSessionChildrenFetch(cache, '/repo::parent', 'tasks:1', () => {
      fetchCount += 1;
      return new Promise(() => undefined);
    });
    const second = ensureSessionChildrenFetch(cache, '/repo::parent', 'tasks:1', () => {
      fetchCount += 1;
      return Promise.resolve();
    });

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.promise).toBe(first.promise);
    expect(fetchCount).toBe(1);
  });

  test('starts a new child refresh when the task invocation signature changes', () => {
    const cache = new Map();
    let fetchCount = 0;
    const first = ensureSessionChildrenFetch(cache, '/repo::parent', 'tasks:1', () => {
      fetchCount += 1;
      return new Promise(() => undefined);
    });
    const second = ensureSessionChildrenFetch(cache, '/repo::parent', 'tasks:2', () => {
      fetchCount += 1;
      return new Promise(() => undefined);
    });

    expect(first.started).toBe(true);
    expect(second.started).toBe(true);
    expect(second.promise).not.toBe(first.promise);
    expect(fetchCount).toBe(2);
  });

  test('reports loading until hook status catches up to the requested refresh key', () => {
    expect(getEffectiveSessionChildrenFetchStatus({
      enabled: true,
      parentID: 'parent',
      directory: '/repo',
      refreshKey: 'tasks:2',
      status: {
        isLoading: false,
        hasFetched: true,
        parentID: 'parent',
        directory: '/repo',
        refreshKey: 'tasks:1',
      },
    })).toEqual({ isLoading: true, hasFetched: false });
  });

  test('prunes expired completed entries while preserving expired in-flight entries', () => {
    const cache = new Map();
    const now = 10_000;
    const ttlMs = SESSION_CHILDREN_FETCH_TTL_MS;

    cache.set('/repo::expired-completed', { fetchedAt: now - ttlMs - 1, refreshKey: 'tasks:1' });
    cache.set('/repo::expired-in-flight', {
      promise: new Promise(() => undefined),
      fetchedAt: now - ttlMs - 1,
      refreshKey: 'tasks:1',
    });
    cache.set('/repo::fresh-completed', { fetchedAt: now - 1, refreshKey: 'tasks:1' });

    ensureSessionChildrenFetch(cache, '/repo::active', 'tasks:1', () => Promise.resolve(), now, ttlMs);

    expect(cache.has('/repo::expired-completed')).toBe(false);
    expect(cache.has('/repo::expired-in-flight')).toBe(true);
    expect(cache.has('/repo::fresh-completed')).toBe(true);
  });

  test('evicts oldest completed entries over the max cap while preserving in-flight promises', () => {
    const cache = new Map();
    const now = 10_000;
    const ttlMs = SESSION_CHILDREN_FETCH_TTL_MS;
    const maxEntries = 2;
    const withinTtl = now - ttlMs + 100;

    cache.set('/repo::oldest', { fetchedAt: withinTtl, refreshKey: 'tasks:1' });
    cache.set('/repo::middle', { fetchedAt: withinTtl + 1, refreshKey: 'tasks:1' });
    cache.set('/repo::newest', { fetchedAt: withinTtl + 2, refreshKey: 'tasks:1' });
    cache.set('/repo::in-flight', {
      promise: new Promise(() => undefined),
      fetchedAt: withinTtl - 1,
      refreshKey: 'tasks:1',
    });

    ensureSessionChildrenFetch(cache, '/repo::active', 'tasks:1', () => Promise.resolve(), now, ttlMs, maxEntries);

    expect(cache.has('/repo::oldest')).toBe(false);
    expect(cache.has('/repo::middle')).toBe(true);
    expect(cache.has('/repo::newest')).toBe(true);
    expect(cache.has('/repo::in-flight')).toBe(true);
  });

  test('starts a new fetch for an expired active key and reports prior hasFetched state', async () => {
    const cache = new Map();
    const now = 10_000;
    const ttlMs = SESSION_CHILDREN_FETCH_TTL_MS;
    const key = '/repo::parent';
    const refreshKey = 'tasks:1';

    cache.set(key, { fetchedAt: now - ttlMs - 1, refreshKey });

    let fetchCount = 0;
    const result = ensureSessionChildrenFetch(cache, key, refreshKey, () => {
      fetchCount += 1;
      return Promise.resolve();
    }, now, ttlMs);

    expect(result.started).toBe(true);
    expect(result.isLoading).toBe(true);
    expect(result.hasFetched).toBe(true);
    expect(fetchCount).toBe(1);

    await result.promise;
    const fetchedAt = cache.get(key)?.fetchedAt;
    expect(typeof fetchedAt).toBe('number');
    expect(fetchedAt!).toBeGreaterThan(now - 1);
  });

  test('clears one directory and prevents an older in-flight completion from repopulating it', async () => {
    const cache = new Map();
    let resolveFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const pending = ensureSessionChildrenFetch(
      cache,
      getSessionChildrenFetchKey('/repo/a', 'parent-a'),
      'tasks:1',
      () => fetchGate,
    );
    cache.set(getSessionChildrenFetchKey('/repo/b', 'parent-b'), {
      fetchedAt: 100,
      refreshKey: 'tasks:1',
    });

    expect(clearSessionChildrenForDirectory(cache, '/repo/a')).toBe(1);
    expect(cache.has(getSessionChildrenFetchKey('/repo/a', 'parent-a'))).toBe(false);
    expect(cache.has(getSessionChildrenFetchKey('/repo/b', 'parent-b'))).toBe(true);

    resolveFetch();
    await pending.promise;
    expect(cache.has(getSessionChildrenFetchKey('/repo/a', 'parent-a'))).toBe(false);
  });
});
