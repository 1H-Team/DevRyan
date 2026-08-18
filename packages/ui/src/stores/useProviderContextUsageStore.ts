import { create } from 'zustand';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { ProviderContextUsageSnapshot } from '@/lib/api/types';

type ProviderContextUsageEntry = {
  requestKey: string;
  status: 'loading' | 'available' | 'unavailable';
  snapshot: ProviderContextUsageSnapshot | null;
};

type ProviderContextUsageStore = {
  entries: Map<string, ProviderContextUsageEntry>;
  compactionRevisions: Map<string, number>;
};

type RefreshProviderContextUsageOptions = {
  sessionID: string;
  directory?: string | null;
  requestKey: string;
  refreshSession?: boolean;
};

const MAX_CONTEXT_ENTRIES = 100;
const inFlight = new Map<string, Promise<void>>();

export const getProviderContextUsageStoreKey = (
  sessionID: string,
  directory?: string | null,
): string => {
  const rawDirectory = directory?.trim().replace(/\\/g, '/') ?? '';
  const normalizedDirectory = rawDirectory === '/' ? '/' : rawDirectory.replace(/\/+$/, '');
  return JSON.stringify([normalizedDirectory, sessionID.trim()]);
};

export const useProviderContextUsageStore = create<ProviderContextUsageStore>(() => ({
  entries: new Map(),
  compactionRevisions: new Map(),
}));

const updateEntry = (key: string, entry: ProviderContextUsageEntry | null): void => {
  useProviderContextUsageStore.setState((state) => {
    const entries = new Map(state.entries);
    entries.delete(key);
    if (entry) entries.set(key, entry);
    while (entries.size > MAX_CONTEXT_ENTRIES) {
      const oldest = entries.keys().next().value as string | undefined;
      if (!oldest) break;
      entries.delete(oldest);
    }
    return { entries };
  });
};

export const refreshProviderContextUsage = async (
  options: RefreshProviderContextUsageOptions,
): Promise<void> => {
  const contextUsageAPI = getRegisteredRuntimeAPIs()?.contextUsage;
  if (!options.sessionID.trim()) return;

  const key = getProviderContextUsageStoreKey(options.sessionID, options.directory);
  const inFlightKey = JSON.stringify([key, options.requestKey, Boolean(options.refreshSession)]);
  const existingRequest = inFlight.get(inFlightKey);
  if (existingRequest) return existingRequest;

  const current = useProviderContextUsageStore.getState().entries.get(key);
  if (current?.requestKey === options.requestKey && current.status !== 'loading') return;
  updateEntry(key, { requestKey: options.requestKey, status: 'loading', snapshot: null });
  if (!contextUsageAPI) {
    updateEntry(key, { requestKey: options.requestKey, status: 'unavailable', snapshot: null });
    return;
  }

  const request = contextUsageAPI.getSessionUsage(options.sessionID, {
    ...(options.directory ? { directory: options.directory } : {}),
    ...(options.refreshSession ? { refreshSession: true } : {}),
  }).then((snapshot) => {
    const latest = useProviderContextUsageStore.getState().entries.get(key);
    if (latest?.requestKey !== options.requestKey) return;
    updateEntry(key, {
      requestKey: options.requestKey,
      status: snapshot.status,
      snapshot: snapshot.status === 'available' ? snapshot : null,
    });
  }).catch(() => {
    const latest = useProviderContextUsageStore.getState().entries.get(key);
    if (latest?.requestKey !== options.requestKey) return;
    updateEntry(key, { requestKey: options.requestKey, status: 'unavailable', snapshot: null });
  }).finally(() => {
    inFlight.delete(inFlightKey);
  });
  inFlight.set(inFlightKey, request);
  return request;
};

export const invalidateProviderContextUsageForCompaction = (
  sessionID: string,
  directory?: string | null,
): number => {
  const key = getProviderContextUsageStoreKey(sessionID, directory);
  let revision = 0;
  useProviderContextUsageStore.setState((state) => {
    revision = (state.compactionRevisions.get(key) ?? 0) + 1;
    const compactionRevisions = new Map(state.compactionRevisions);
    compactionRevisions.set(key, revision);
    const entries = new Map(state.entries);
    entries.delete(key);
    return { compactionRevisions, entries };
  });
  void refreshProviderContextUsage({
    sessionID,
    directory,
    requestKey: `compaction:${revision}`,
    refreshSession: true,
  });
  return revision;
};

export const clearProviderContextUsage = (
  sessionID: string,
  directory?: string | null,
): void => {
  const key = getProviderContextUsageStoreKey(sessionID, directory);
  useProviderContextUsageStore.setState((state) => {
    if (!state.entries.has(key) && !state.compactionRevisions.has(key)) return state;
    const entries = new Map(state.entries);
    const compactionRevisions = new Map(state.compactionRevisions);
    entries.delete(key);
    compactionRevisions.delete(key);
    return { entries, compactionRevisions };
  });
};

export const clearAllProviderContextUsageForSession = (sessionID: string): void => {
  useProviderContextUsageStore.setState((state) => {
    const matchesSession = (key: string): boolean => {
      try {
        const parsed = JSON.parse(key) as unknown;
        return Array.isArray(parsed) && parsed[1] === sessionID;
      } catch {
        return false;
      }
    };
    const entries = new Map([...state.entries].filter(([key]) => !matchesSession(key)));
    const compactionRevisions = new Map(
      [...state.compactionRevisions].filter(([key]) => !matchesSession(key)),
    );
    if (entries.size === state.entries.size && compactionRevisions.size === state.compactionRevisions.size) {
      return state;
    }
    return { entries, compactionRevisions };
  });
};
