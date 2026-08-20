import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
import { streamPerfObserve } from '@/stores/utils/streamDebug';
import {
  getSidebarSessionDirectory,
  isActiveSidebarHydrationDirectory,
} from './sidebarHydrationUtils';

const SESSION_PREFETCH_HOVER_DELAY_MS = 180;
const SESSION_PREFETCH_SETTLE_MS = 600;
const SESSION_PREFETCH_CONCURRENCY = 1;
const SESSION_PREFETCH_PENDING_LIMIT = 6;

type Args = {
  currentSessionId: string | null;
  currentDirectory: string | null;
  sortedSessions: Session[];
  prefetchSession: (sessionId: string, directory: string) => Promise<unknown>;
};

type SessionPrefetchIntent = {
  schedule: (sessionId: string, directory: string | null, delayMs?: number) => void;
  cancel: (sessionId: string) => void;
};

export const selectSessionPrefetchNeighborIds = (input: {
  currentSessionId: string | null;
  currentDirectory: string | null;
  sortedSessions: Session[];
}): string[] => {
  if (!input.currentSessionId || !input.currentDirectory) return [];
  const activeSessions = input.sortedSessions.filter((session) => (
    isActiveSidebarHydrationDirectory(
      getSidebarSessionDirectory(session),
      input.currentDirectory,
    )
  ));
  const currentIndex = activeSessions.findIndex((session) => session.id === input.currentSessionId);
  if (currentIndex < 0) return [];
  return [activeSessions[currentIndex - 1]?.id, activeSessions[currentIndex + 1]?.id]
    .filter((sessionId): sessionId is string => typeof sessionId === 'string');
};

export const useSessionPrefetch = ({
  currentSessionId,
  currentDirectory,
  sortedSessions,
  prefetchSession,
}: Args): SessionPrefetchIntent => {
  const sessionPrefetchTimersRef = React.useRef<Map<string, number>>(new Map());
  const sessionPrefetchQueueRef = React.useRef<string[]>([]);
  const sessionPrefetchInFlightRef = React.useRef<Set<string>>(new Set());
  const queuedAtRef = React.useRef<Map<string, number>>(new Map());

  const pumpSessionPrefetchQueue = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    while (sessionPrefetchInFlightRef.current.size < SESSION_PREFETCH_CONCURRENCY && sessionPrefetchQueueRef.current.length > 0) {
      const nextSessionId = sessionPrefetchQueueRef.current.shift();
      if (!nextSessionId) {
        break;
      }

      const state = useSessionUIStore.getState();
      if (state.currentSessionId === nextSessionId) {
        continue;
      }

      // Check if the session is already renderable in the sync child store.
      if (getSyncSessionMaterializationStatus(nextSessionId).renderable) {
        continue;
      }

      sessionPrefetchInFlightRef.current.add(nextSessionId);
      const queuedAt = queuedAtRef.current.get(nextSessionId);
      queuedAtRef.current.delete(nextSessionId);
      if (queuedAt !== undefined) {
        streamPerfObserve('session.load.prefetch.queue_ms', Math.max(0, performance.now() - queuedAt));
      }
      const activeDirectory = currentDirectory;
      if (!activeDirectory) continue;
      void prefetchSession(nextSessionId, activeDirectory)
        .catch(() => undefined)
        .finally(() => {
          sessionPrefetchInFlightRef.current.delete(nextSessionId);
          pumpSessionPrefetchQueue();
        });
    }
  }, [currentDirectory, prefetchSession]);

  const cancelSessionPrefetch = React.useCallback((sessionId: string) => {
    const timer = sessionPrefetchTimersRef.current.get(sessionId);
    if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer);
    sessionPrefetchTimersRef.current.delete(sessionId);
    sessionPrefetchQueueRef.current = sessionPrefetchQueueRef.current.filter((candidate) => candidate !== sessionId);
    queuedAtRef.current.delete(sessionId);
  }, []);

  const scheduleSessionPrefetch = React.useCallback((sessionId: string | null | undefined, sessionDirectory: string | null, delayMs = SESSION_PREFETCH_HOVER_DELAY_MS) => {
    if (!sessionId || sessionId === currentSessionId || typeof window === 'undefined') {
      return;
    }
    if (!currentDirectory || sessionDirectory !== currentDirectory) return;

    // Already renderable in sync
    if (getSyncSessionMaterializationStatus(sessionId).renderable) {
      return;
    }

    if (sessionPrefetchInFlightRef.current.has(sessionId)) {
      return;
    }

    if (sessionPrefetchQueueRef.current.includes(sessionId)) {
      return;
    }

    if (sessionPrefetchQueueRef.current.length >= SESSION_PREFETCH_PENDING_LIMIT) {
      const dropped = sessionPrefetchQueueRef.current.shift();
      if (dropped) queuedAtRef.current.delete(dropped);
    }

    const existingTimer = sessionPrefetchTimersRef.current.get(sessionId);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      sessionPrefetchTimersRef.current.delete(sessionId);
      sessionPrefetchQueueRef.current.push(sessionId);
      queuedAtRef.current.set(sessionId, performance.now());
      pumpSessionPrefetchQueue();
    }, delayMs);
    sessionPrefetchTimersRef.current.set(sessionId, timer);
  }, [currentDirectory, currentSessionId, pumpSessionPrefetchQueue]);

  // Wait for the active session to finish loading before prefetching neighbors.
  // On rapid session switches the timer resets, so only the final session triggers prefetch.
  React.useEffect(() => {
    if (!currentSessionId || sortedSessions.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      const neighborIds = selectSessionPrefetchNeighborIds({
        currentSessionId,
        currentDirectory,
        sortedSessions,
      });
      neighborIds.forEach((sessionId) => scheduleSessionPrefetch(sessionId, currentDirectory, 0));
    }, SESSION_PREFETCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentDirectory, currentSessionId, scheduleSessionPrefetch, sortedSessions]);

  React.useEffect(() => {
    const prefetchTimers = sessionPrefetchTimersRef.current;
    const queuedAt = queuedAtRef.current;
    return () => {
      prefetchTimers.forEach((timer) => {
        clearTimeout(timer);
      });
      prefetchTimers.clear();
      sessionPrefetchQueueRef.current = [];
      queuedAt.clear();
    };
  }, []);

  React.useEffect(() => {
    sessionPrefetchTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    sessionPrefetchTimersRef.current.clear();
    sessionPrefetchQueueRef.current = [];
    queuedAtRef.current.clear();
  }, [currentDirectory]);

  return React.useMemo(() => ({
    schedule: scheduleSessionPrefetch,
    cancel: cancelSessionPrefetch,
  }), [cancelSessionPrefetch, scheduleSessionPrefetch]);
};
