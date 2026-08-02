import React from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type {
  EvidenceAPI,
  TurnEvidenceCheckpoint,
  TurnEvidenceDiffSummary,
} from '@/lib/api/types';

type EvidenceSessionState = {
  records: TurnEvidenceCheckpoint[];
  summaries: Map<string, TurnEvidenceDiffSummary>;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  loadedAt: number;
  directory: string | null;
};

const MAX_SESSION_STORES = 40;
const SESSION_TTL_MS = 30 * 60 * 1000;
const LOAD_TTL_MS = 15_000;
const stores = new Map<string, StoreApi<EvidenceSessionState>>();
const touchedAt = new Map<string, number>();
const loads = new Map<string, Promise<void>>();
const summaryLoads = new Map<string, Promise<void>>();

const createEvidenceSessionStore = (): StoreApi<EvidenceSessionState> => createStore(() => ({
  records: [],
  summaries: new Map(),
  status: 'idle',
  error: null,
  loadedAt: 0,
  directory: null,
}));

const evictExpired = (preserve?: string) => {
  const now = Date.now();
  const candidates = [...stores.keys()]
    .filter((sessionID) => sessionID !== preserve)
    .sort((left, right) => (touchedAt.get(left) ?? 0) - (touchedAt.get(right) ?? 0));
  for (const sessionID of candidates) {
    if (
      stores.size <= MAX_SESSION_STORES
      && now - (touchedAt.get(sessionID) ?? now) < SESSION_TTL_MS
    ) continue;
    stores.delete(sessionID);
    touchedAt.delete(sessionID);
    loads.delete(sessionID);
    for (const key of summaryLoads.keys()) {
      if (key.startsWith(`${sessionID}\u0000`)) summaryLoads.delete(key);
    }
  }
};

const ensureStore = (sessionID: string): StoreApi<EvidenceSessionState> => {
  let store = stores.get(sessionID);
  if (!store) {
    store = createEvidenceSessionStore();
    stores.set(sessionID, store);
  }
  touchedAt.set(sessionID, Date.now());
  evictExpired(sessionID);
  return store;
};

export const loadEvidenceSession = (
  api: EvidenceAPI,
  sessionID: string,
  directory?: string,
  force = false,
): Promise<void> => {
  const store = ensureStore(sessionID);
  const state = store.getState();
  if (
    !force
    && state.status === 'ready'
    && state.directory === (directory || null)
    && Date.now() - state.loadedAt < LOAD_TTL_MS
  ) return Promise.resolve();
  const existing = loads.get(sessionID);
  if (existing) return existing;
  store.setState({ status: 'loading', error: null });
  const load = api.listTurns(sessionID, directory)
    .then((records) => {
      store.setState({
        records,
        status: 'ready',
        error: null,
        loadedAt: Date.now(),
        directory: directory || null,
      });
    })
    .catch((error) => {
      store.setState({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      loads.delete(sessionID);
    });
  loads.set(sessionID, load);
  return load;
};

export const loadEvidenceSummary = (
  api: EvidenceAPI,
  sessionID: string,
  checkpointID: string,
): Promise<void> => {
  const store = ensureStore(sessionID);
  if (store.getState().summaries.has(checkpointID)) return Promise.resolve();
  const key = `${sessionID}\u0000${checkpointID}`;
  const existing = summaryLoads.get(key);
  if (existing) return existing;
  const load = api.getDiff(checkpointID)
    .then((result) => {
      if (!('files' in result)) return;
      const current = store.getState().summaries;
      if (current.get(checkpointID) === result) return;
      const summaries = new Map(current);
      summaries.set(checkpointID, result);
      store.setState({ summaries });
    })
    .finally(() => {
      summaryLoads.delete(key);
    });
  summaryLoads.set(key, load);
  return load;
};

export const evictEvidenceSession = (sessionID: string): void => {
  stores.delete(sessionID);
  touchedAt.delete(sessionID);
  loads.delete(sessionID);
};

export const useEvidenceSessionStore = <T,>(
  sessionID: string,
  selector: (state: EvidenceSessionState) => T,
): T => {
  const store = React.useMemo(() => ensureStore(sessionID), [sessionID]);
  React.useEffect(() => {
    touchedAt.set(sessionID, Date.now());
  }, [sessionID]);
  return useStore(store, selector);
};
