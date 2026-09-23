import { expect, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';
import { readWorktreeHistory, writeWorktreeHistory, buildKnownSessionDirectories, createWorktreeDiscoveryCache, invalidateWorktreeDiscovery, mergeWorktreeDiscovery, retainDiscoveredSessionWorktrees } from './worktreeDiscovery';
import { filterBranchBackedWorktrees } from './managedBranches';

const branch = (name: string): WorktreeMetadata => ({ source: 'sdk', projectDirectory: '/repo', label: name, path: `/worktrees/${name}`, branch: name, headState: 'branch' });

test('externally discovered worktrees retain chat ownership through detachment and removal', () => {
  const old = branch('old');
  const sessions = [{ id: 'chat', directory: old.path }, { id: 'unrelated', directory: '/elsewhere' }];
  const retained = retainDiscoveredSessionWorktrees(new Map(), sessions, [[{ ...old, branch: '', headState: 'detached' }]]);
  expect(retained.get('chat')?.projectDirectory).toBe('/repo');
  expect(retained.has('unrelated')).toBe(false);
  expect(retainDiscoveredSessionWorktrees(retained, sessions, [])).toBe(retained);
  expect(retainDiscoveredSessionWorktrees(retained, sessions, [[old]])).toBe(retained);
});

test('external deletion/detachment refresh preserves other projects and chat metadata', () => {
  const live = branch('Dev'), removed = branch('old');
  const previous = new Map([['/repo', [live, removed]], ['/other', [branch('other')]]]);
  const discovery = new Map([['/repo', filterBranchBackedWorktrees([{ ...live }, { ...removed, branch: '', headState: 'detached' }])]]);
  const next = mergeWorktreeDiscovery(previous, discovery, new Set(previous.keys()));
  expect(next.get('/repo')).toEqual([live]);
  expect(next.get('/repo')?.[0]).toBe(live);
  expect(next.get('/other')).toBe(previous.get('/other'));
  expect(previous.get('/repo')).toEqual([live, removed]);
  expect(mergeWorktreeDiscovery(next, discovery, new Set(next.keys()))).toBe(next);
});

test('successful empty discovery clears rows while failure preserves the last good list', () => {
  const previous = new Map([['/repo', [branch('Dev')]]]);
  expect(mergeWorktreeDiscovery(previous, new Map(), new Set(['/repo']))).toBe(previous);
  expect(mergeWorktreeDiscovery(previous, new Map([['/repo', []]]), new Set(['/repo'])).size).toBe(0);
});

test('an old inflight response cannot restore a branch deleted during discovery', async () => {
  const cache = createWorktreeDiscoveryCache<string[]>();
  let complete!: (rows: string[]) => void;
  let loads = 0;
  const old = cache.read('/repo', () => (++loads === 1
    ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(['Dev'])));
  invalidateWorktreeDiscovery();
  const current = await cache.read('/repo', async () => ['Dev']);
  complete(['Dev', 'deleted']);
  // The superseded caller is answered from a fresh post-invalidation read,
  // never with the stale listing and never with a spurious error.
  expect(await old).toEqual(['Dev']);
  expect(await cache.read('/repo', async () => { throw new Error('cached'); })).toEqual(current);
});

test('continuous invalidation eventually reports supersession instead of looping', async () => {
  const cache = createWorktreeDiscoveryCache<string[]>();
  let loads = 0;
  const read = cache.read('/repo', async () => { loads++; invalidateWorktreeDiscovery(); return ['stale']; });
  await expect(read).rejects.toThrow('superseded');
  expect(loads).toBe(3);
});

test('visible refresh bypasses the TTL, deduplicates loads, and never caches failure', async () => {
  const cache = createWorktreeDiscoveryCache<string[]>();
  await cache.read('/repo', async () => ['old']);
  let calls = 0;
  const load = async () => { calls++; return ['current']; };
  const first = cache.read('/repo', load, true);
  expect(cache.read('/repo', load, true)).toBe(first);
  await first;
  expect(calls).toBe(1);
  await expect(cache.read('/repo', async () => { throw new Error('offline'); }, true)).rejects.toThrow('offline');
  expect(await cache.read('/repo', load)).toEqual(['current']);
});

test('sidebar accepts retained chat directories only for registered projects', () => {
  const retained = new Map([['chat', branch('removed')], ['foreign', { ...branch('foreign'), projectDirectory: '/unregistered' }]]);
  expect([...buildKnownSessionDirectories([{ path: '/repo' }], new Map(), retained)]).toEqual(['/repo', '/worktrees/removed']);
});

test('proven ownership survives reload without restoring a live branch and ignores corrupt history', () => {
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  writeWorktreeHistory(storage, new Map([['chat', branch('removed')]]));
  const restored = readWorktreeHistory(storage);
  expect(restored.get('chat')?.projectDirectory).toBe('/repo');
  expect(restored.get('chat')?.path).toBe('/worktrees/removed');
  expect(filterBranchBackedWorktrees([...restored.values()])).toEqual([]);
  raw = '{'; expect(readWorktreeHistory(storage).size).toBe(0);
  raw = JSON.stringify([['bad', {}, '/repo'], ['valid', '/removed', '/repo']]);
  expect([...readWorktreeHistory(storage).keys()]).toEqual(['valid']);
});
