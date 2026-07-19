import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
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
  ensureSessionRenderable: (sessionId: string) => Promise<unknown>;
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
  ensureSessionRenderable,
}: Args): void => {
  const sessionPrefetchTimersRef = React.useRef<Map<string, number>>(new Map());
  const sessionPrefetchQueueRef = React.useRef<string[]>([]);
  const sessionPrefetchInFlightRef = React.useRef<Set<string>>(new Set());

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
      void ensureSessionRenderable(nextSessionId)
        .catch(() => undefined)
        .finally(() => {
          sessionPrefetchInFlightRef.current.delete(nextSessionId);
          pumpSessionPrefetchQueue();
        });
    }
  }, [ensureSessionRenderable]);

  const scheduleSessionPrefetch = React.useCallback((sessionId: string | null | undefined) => {
    if (!sessionId || sessionId === currentSessionId || typeof window === 'undefined') {
      return;
    }

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
      sessionPrefetchQueueRef.current.shift();
    }

    const existingTimer = sessionPrefetchTimersRef.current.get(sessionId);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      sessionPrefetchTimersRef.current.delete(sessionId);
      sessionPrefetchQueueRef.current.push(sessionId);
      pumpSessionPrefetchQueue();
    }, SESSION_PREFETCH_HOVER_DELAY_MS);
    sessionPrefetchTimersRef.current.set(sessionId, timer);
  }, [currentSessionId, pumpSessionPrefetchQueue]);

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
      neighborIds.forEach(scheduleSessionPrefetch);
    }, SESSION_PREFETCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentDirectory, currentSessionId, scheduleSessionPrefetch, sortedSessions]);

  React.useEffect(() => {
    const prefetchTimers = sessionPrefetchTimersRef.current;
    return () => {
      prefetchTimers.forEach((timer) => {
        clearTimeout(timer);
      });
      prefetchTimers.clear();
      sessionPrefetchQueueRef.current = [];
    };
  }, []);
};
