import type { Session } from '@opencode-ai/sdk/v2';

export const SESSION_CHILDREN_FETCH_TTL_MS = 5000;
export const SESSION_CHILDREN_FETCH_MAX_ENTRIES = 100;

const pruneSessionChildrenFetchCache = (
  cache: Map<string, SessionChildrenFetchCacheEntry>,
  activeKey: string,
  now: number,
  ttlMs: number,
  maxEntries: number,
): void => {
  for (const [key, entry] of cache) {
    if (key === activeKey || entry.promise) {
      continue;
    }
    if (typeof entry.fetchedAt === 'number' && now - entry.fetchedAt >= ttlMs) {
      cache.delete(key);
    }
  }

  const completedEntries: Array<{ key: string; fetchedAt: number }> = [];
  for (const [key, entry] of cache) {
    if (entry.promise || key === activeKey) {
      continue;
    }
    if (typeof entry.fetchedAt === 'number') {
      completedEntries.push({ key, fetchedAt: entry.fetchedAt });
    }
  }

  if (completedEntries.length <= maxEntries) {
    return;
  }

  completedEntries.sort((a, b) => a.fetchedAt - b.fetchedAt);
  const excess = completedEntries.length - maxEntries;
  for (let index = 0; index < excess; index += 1) {
    cache.delete(completedEntries[index].key);
  }
};

export const getSessionChildrenFetchKey = (directory: string, parentSessionId: string): string => {
  return `${directory}::${parentSessionId}`;
};

export const clearSessionChildrenForDirectory = (
  cache: Map<string, SessionChildrenFetchCacheEntry>,
  directory: string,
): number => {
  const prefix = `${directory}::`;
  let cleared = 0;
  for (const key of cache.keys()) {
    if (!key.startsWith(prefix)) continue;
    cache.delete(key);
    cleared += 1;
  }
  return cleared;
};

export type SessionChildrenFetchCacheEntry = {
  promise?: Promise<void>;
  fetchedAt?: number;
  refreshKey?: string;
};

export type SessionChildrenFetchResult = {
  promise?: Promise<void>;
  isLoading: boolean;
  hasFetched: boolean;
  started: boolean;
};

export type SessionChildrenHookStatus = {
  isLoading: boolean;
  hasFetched: boolean;
  parentID?: string;
  directory?: string;
  refreshKey?: string;
};

export const getEffectiveSessionChildrenFetchStatus = ({
  enabled,
  parentID,
  directory,
  refreshKey,
  status,
}: {
  enabled: boolean;
  parentID: string;
  directory: string;
  refreshKey: string;
  status: SessionChildrenHookStatus;
}): { isLoading: boolean; hasFetched: boolean } => {
  if (!enabled || !parentID || !directory) {
    return { isLoading: false, hasFetched: false };
  }

  if (status.parentID !== parentID || status.directory !== directory || status.refreshKey !== refreshKey) {
    return { isLoading: true, hasFetched: false };
  }

  return {
    isLoading: status.isLoading,
    hasFetched: status.hasFetched,
  };
};

export const ensureSessionChildrenFetch = (
  cache: Map<string, SessionChildrenFetchCacheEntry>,
  key: string,
  refreshKey: string,
  fetchChildren: () => Promise<void>,
  now = Date.now(),
  ttlMs = SESSION_CHILDREN_FETCH_TTL_MS,
  maxEntries = SESSION_CHILDREN_FETCH_MAX_ENTRIES,
): SessionChildrenFetchResult => {
  pruneSessionChildrenFetchCache(cache, key, now, ttlMs, maxEntries);

  const existing = cache.get(key);
  const fetchedAt = existing?.fetchedAt;
  const sameRefreshKey = existing?.refreshKey === refreshKey;
  const hasFetched = sameRefreshKey && typeof fetchedAt === 'number';

  if (existing?.promise && sameRefreshKey) {
    return {
      promise: existing.promise,
      isLoading: true,
      hasFetched,
      started: false,
    };
  }

  if (hasFetched && typeof fetchedAt === 'number' && now - fetchedAt < ttlMs) {
    return {
      isLoading: false,
      hasFetched: true,
      started: false,
    };
  }

  let sourcePromise: Promise<void>;
  try {
    sourcePromise = fetchChildren();
  } catch (error) {
    sourcePromise = Promise.reject(error);
  }

  const promise = sourcePromise
    .then(() => {
      const latest = cache.get(key);
      if (latest?.promise === promise) {
        cache.set(key, { fetchedAt: Date.now(), refreshKey });
      }
    })
    .catch(() => {
      const latest = cache.get(key);
      if (latest?.promise === promise) {
        cache.delete(key);
      }
    });

  cache.set(key, { promise, fetchedAt: sameRefreshKey ? existing?.fetchedAt : undefined, refreshKey });

  return {
    promise,
    isLoading: true,
    hasFetched,
    started: true,
  };
};

type MergeChildSessionsOptions = {
  directory?: string | null;
};

type SessionWithDirectory = Session & {
  directory?: string | null;
  parentID?: string | null;
  project?: { worktree?: string | null } | null;
};

const getSessionDirectory = (session?: Session | null): string | null => {
  const record = session as SessionWithDirectory | null | undefined;
  return record?.directory ?? record?.project?.worktree ?? null;
};

const withInheritedChildDirectory = (
  child: Session,
  sessionsById: Map<string, Session>,
  options?: MergeChildSessionsOptions,
): Session => {
  if (getSessionDirectory(child)) {
    return child;
  }

  const parentID = (child as SessionWithDirectory).parentID;
  const inheritedDirectory = parentID
    ? getSessionDirectory(sessionsById.get(parentID)) ?? options?.directory ?? null
    : options?.directory ?? null;
  if (!inheritedDirectory) {
    return child;
  }

  return { ...child, directory: inheritedDirectory } as Session;
};

export const mergeChildSessions = (
  sessions: Session[],
  childSessions: Session[],
  options?: MergeChildSessionsOptions,
): Session[] => {
  const validChildren = childSessions.filter((session) => typeof session?.id === 'string' && session.id.length > 0);
  if (validChildren.length === 0) {
    return sessions;
  }

  const byId = new Map<string, Session>();
  for (const session of sessions) {
    if (!session?.id) continue;
    byId.set(session.id, session);
  }

  let changed = false;
  for (const child of validChildren) {
    const normalizedChild = withInheritedChildDirectory(child, byId, options);
    if (byId.get(normalizedChild.id) !== normalizedChild) {
      changed = true;
    }
    byId.set(normalizedChild.id, normalizedChild);
  }

  if (!changed) {
    return sessions;
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
};
