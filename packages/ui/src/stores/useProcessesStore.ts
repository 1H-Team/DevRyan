import { create } from 'zustand';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { ManagedProcessInfo, ProcessesSnapshot } from '@/lib/api/types';

export const PROCESSES_POLL_INTERVAL_MS = 5_000;
// Fixed tab id in the bottom terminal dock; never a real terminal tab id.
export const PROCESSES_TAB_ID = '__processes__';

export type ProcessSessionGroup = {
  sessionId: string | null;
  processes: ManagedProcessInfo[];
};

// Known sessions first (in first-seen order), unattributed processes last.
export const groupProcessesBySession = (processes: ManagedProcessInfo[]): ProcessSessionGroup[] => {
  const groups = new Map<string, ManagedProcessInfo[]>();
  const unattributed: ManagedProcessInfo[] = [];
  for (const process of processes) {
    if (!process.sessionId) {
      unattributed.push(process);
      continue;
    }
    const existing = groups.get(process.sessionId);
    if (existing) existing.push(process);
    else groups.set(process.sessionId, [process]);
  }
  const result: ProcessSessionGroup[] = [...groups.entries()].map(([sessionId, entries]) => ({ sessionId, processes: entries }));
  if (unattributed.length > 0) result.push({ sessionId: null, processes: unattributed });
  return result;
};

export const formatProcessAge = (ageMs: number | null | undefined): string => {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return '—';
  const totalSeconds = Math.floor(ageMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
};

type ProcessesState = {
  snapshot: ProcessesSnapshot | null;
  directory: string | null;
  isLoading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  stoppingPids: number[];
  refresh: (directory?: string | null) => Promise<void>;
  stop: (pid: number, startedAt: number | null) => Promise<boolean>;
  startPolling: (directory: string | null, intervalMs?: number) => () => void;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollSubscribers = 0;
let refreshSequence = 0;

const getProcessesAPI = () => getRegisteredRuntimeAPIs()?.processes ?? null;

export const useProcessesStore = create<ProcessesState>((set, get) => ({
  snapshot: null,
  directory: null,
  isLoading: false,
  error: null,
  lastFetchedAt: null,
  stoppingPids: [],

  refresh: async (directory = get().directory) => {
    const api = getProcessesAPI();
    if (!api) return;
    const sequence = ++refreshSequence;
    set({ isLoading: true, directory: directory ?? null });
    try {
      const snapshot = await api.list(directory ?? undefined);
      // A slower earlier request must not overwrite a newer snapshot.
      if (sequence !== refreshSequence) return;
      set({ snapshot, error: null, isLoading: false, lastFetchedAt: Date.now() });
    } catch (error) {
      if (sequence !== refreshSequence) return;
      set({ error: error instanceof Error ? error.message : String(error), isLoading: false });
    }
  },

  stop: async (pid, startedAt) => {
    const api = getProcessesAPI();
    if (!api || get().stoppingPids.includes(pid)) return false;
    set((state) => ({ stoppingPids: [...state.stoppingPids, pid] }));
    try {
      const result = await api.stop(pid, startedAt);
      await get().refresh();
      return result.terminated;
    } finally {
      set((state) => ({ stoppingPids: state.stoppingPids.filter((entry) => entry !== pid) }));
    }
  },

  startPolling: (directory, intervalMs = PROCESSES_POLL_INTERVAL_MS) => {
    pollSubscribers += 1;
    set({ directory: directory ?? null });
    void get().refresh(directory);
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void get().refresh();
      }, intervalMs);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pollSubscribers = Math.max(0, pollSubscribers - 1);
      if (pollSubscribers === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  },
}));
