import type { WorktreeMetadata } from '@/types/worktree';

/** Retain proven session ownership even after a branch disappears from navigation. */
export function retainDiscoveredSessionWorktrees(
  previous: Map<string, WorktreeMetadata>,
  sessions: readonly { id: string; directory?: string }[],
  discovered: Iterable<WorktreeMetadata[]>,
): Map<string, WorktreeMetadata> {
  const byPath = new Map<string, WorktreeMetadata>();
  for (const entries of discovered) for (const entry of entries) byPath.set(entry.path.replace(/\/+$/, ''), entry);
  let next = previous;
  for (const session of sessions) {
    const entry = session.directory ? byPath.get(session.directory.replace(/\/+$/, '')) : undefined;
    if (!entry || previous.get(session.id)?.path === entry.path
      && previous.get(session.id)?.projectDirectory === entry.projectDirectory) continue;
    if (next === previous) next = new Map(previous);
    next.set(session.id, entry);
  }
  return next;
}

const listeners = new Set<() => void>();
let revision = 0;
export const worktreeDiscoveryRevision = () => revision;
const invalidateLocalDiscovery = () => {
  revision++;
  for (const listener of listeners) listener();
};
// Main-window and mini-chat renderers share an origin but not a module instance.
let channel: BroadcastChannel | null = null;
export const invalidateWorktreeDiscovery = () => {
  invalidateLocalDiscovery();
  channel?.postMessage('invalidate');
};
export const subscribeWorktreeDiscovery = (listener: () => void) => {
  listeners.add(listener);
  if (!channel && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('devryan:worktree-discovery');
    channel.addEventListener('message', event => { if (event.data === 'invalidate') invalidateLocalDiscovery(); });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { channel?.close(); channel = null; }
  };
};

const MAX_SUPERSEDED_RELOADS = 2;

/** An invalidated request cannot repopulate either the cache or its consumers:
 * its caller transparently receives a fresh post-invalidation read instead. */
export function createWorktreeDiscoveryCache<T>(now = Date.now) {
  const cache = new Map<string, { value: T; at: number; revision: number }>();
  const inflight = new Map<string, { promise: Promise<T>; revision: number }>();
  const read = (key: string, load: () => Promise<T>, refresh = false, reloads = 0): Promise<T> => {
    const current = worktreeDiscoveryRevision();
    const cached = cache.get(key);
    if (!refresh && cached?.revision === current && now() - cached.at < 30_000) return Promise.resolve(cached.value);
    const pending = inflight.get(key);
    if (pending?.revision === current) return pending.promise;
    const promise = load().then(value => {
      if (worktreeDiscoveryRevision() !== current) {
        // A mutation landed mid-flight; this listing may predate it.
        if (reloads >= MAX_SUPERSEDED_RELOADS) throw new Error('Worktree discovery superseded');
        return read(key, load, true, reloads + 1);
      }
      cache.set(key, { value, at: now(), revision: current });
      return value;
    }).finally(() => { if (inflight.get(key)?.promise === promise) inflight.delete(key); });
    inflight.set(key, { promise, revision: current });
    return promise;
  };
  return { read: (key: string, load: () => Promise<T>, refresh = false) => read(key, load, refresh) };
}

/** Omitted projects represent failed discovery, not an authoritative empty list. */
export function mergeWorktreeDiscovery(
  previous: Map<string, WorktreeMetadata[]>,
  discovered: Map<string, WorktreeMetadata[]>,
  projectPaths: Set<string>,
): Map<string, WorktreeMetadata[]> {
  const next = new Map<string, WorktreeMetadata[]>();
  for (const project of projectPaths) {
    const old = previous.get(project);
    const incoming = discovered.get(project);
    if (!incoming) { if (old) next.set(project, old); continue; }
    const byPath = new Map(old?.map(entry => [entry.path, entry]));
    const entries = incoming.map(entry => {
      const prior = byPath.get(entry.path);
      return prior && JSON.stringify(prior) === JSON.stringify(entry) ? prior : entry;
    });
    if (entries.length) next.set(project, old && old.length === entries.length
      && entries.every((entry, index) => entry === old[index]) ? old : entries);
  }
  return next.size === previous.size && [...next].every(([key, value]) => previous.get(key) === value) ? previous : next;
}

const normalizeDirectory = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';

export const buildKnownSessionDirectories = (
  projects: Array<{ path: string }>,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  historicalWorktrees: ReadonlyMap<string, WorktreeMetadata>,
): Set<string> => {
  const directories = new Set<string>();
  for (const project of projects) {
    const normalized = normalizeDirectory(project.path)?.toLowerCase();
    if (normalized) directories.add(normalized);
  }
  const projectDirectories = new Set(directories);
  for (const metadata of historicalWorktrees.values()) {
    if (projectDirectories.has(normalizeDirectory(metadata.projectDirectory)?.toLowerCase() ?? '')) {
      const directory = normalizeDirectory(metadata.path)?.toLowerCase();
      if (directory) directories.add(directory);
    }
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    for (const worktree of worktrees) {
      const normalized = normalizeDirectory(worktree.path)?.toLowerCase();
      if (normalized) directories.add(normalized);
    }
  }
  return directories;
};


// This is navigation history only; it never creates an execution attachment or
// makes a worktree authoritative. The caller uses principal-scoped storage.
export const WORKTREE_HISTORY_KEY = 'oc.sessions.discoveredWorktreeHistory.v1';
export function readWorktreeHistory(storage: Pick<Storage, 'getItem'>): Map<string, WorktreeMetadata> {
  const history = new Map<string, WorktreeMetadata>();
  try {
    const rows: unknown = JSON.parse(storage.getItem(WORKTREE_HISTORY_KEY) ?? '[]');
    if (!Array.isArray(rows)) return history;
    for (const row of rows.slice(-5000)) {
      if (!Array.isArray(row) || row.length !== 3 || !row.every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096)) continue;
      const [id, path, projectDirectory] = row;
      history.set(id, { source: 'sdk', path, projectDirectory, branch: '', headState: 'detached', label: '' });
    }
  } catch { /* Unavailable or malformed history does not fail discovery. */ }
  return history;
}
export function writeWorktreeHistory(storage: Pick<Storage, 'setItem'>, history: ReadonlyMap<string, WorktreeMetadata>): void {
  try {
    storage.setItem(WORKTREE_HISTORY_KEY, JSON.stringify([...history].slice(-5000).map(([id, entry]) => [id, entry.path, entry.projectDirectory])));
  } catch { /* Navigation remains usable when persistence is unavailable. */ }
}
