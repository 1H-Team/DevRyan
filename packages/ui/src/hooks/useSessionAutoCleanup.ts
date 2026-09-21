import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { protectRetentionSelection, runSessionRetention } from '@/lib/sessionRetention';
import { ensureGlobalSessionsLoaded, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useUIStore } from '@/stores/useUIStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_DELETE_KEEP_RECENT = 5;
const AUTO_DELETE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const getSessionLastActivity = (session: Session): number => {
  return session.time?.updated ?? session.time?.created ?? 0;
};

type BuildAutoDeleteCandidatesOptions = {
  sessions: Session[];
  currentSessionId: string | null;
  cutoffDays: number;
  keepRecent?: number;
  now?: number;
};

export const buildAutoDeleteCandidates = ({
  sessions,
  currentSessionId,
  cutoffDays,
  keepRecent = AUTO_DELETE_KEEP_RECENT,
  now = Date.now(),
}: BuildAutoDeleteCandidatesOptions): string[] => {
  if (!Array.isArray(sessions) || cutoffDays <= 0) {
    return [];
  }

  const cutoffTime = now - cutoffDays * DAY_MS;
  const sorted = [...sessions].sort(
    (a, b) => getSessionLastActivity(b) - getSessionLastActivity(a)
  );
  const protectedIds = new Set(sorted.slice(0, keepRecent).map((session) => session.id));

  return sorted
    .filter((session) => {
      if (!session?.id) return false;
      if (protectedIds.has(session.id)) return false;
      if (session.id === currentSessionId) return false;
      if (session.share) return false;
      const lastActivity = getSessionLastActivity(session);
      if (!lastActivity) return false;
      return lastActivity < cutoffTime;
    })
    .map((session) => session.id);
};

type CleanupResult = {
  completedIds: string[];
  failedIds: string[];
  action: 'archive' | 'delete';
  skippedReason?: string;
  skipped?: Array<{ id: string | null; reason: string }>;
};

type CleanupOptions = {
  autoRun?: boolean;
  enabled?: boolean;
};

export const useSessionAutoCleanup = (enabledOrOptions?: boolean | CleanupOptions) => {
  const options = typeof enabledOrOptions === 'object' ? enabledOrOptions : undefined;
  const autoRun = options?.autoRun !== false;
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (options?.enabled ?? true);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isLoading = useSessionUIStore((state) => state.isLoading);
  const globalSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const hasLoadedGlobalSessions = useGlobalSessionsStore((state) => state.hasLoaded);

  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const setAutoDeleteLastRunAt = useUIStore((state) => state.setAutoDeleteLastRunAt);

  const [isRunning, setIsRunning] = React.useState(false);
  const runningRef = React.useRef(false);

  React.useEffect(() => {
    void protectRetentionSelection(currentSessionId).catch(() => { /* An unacknowledged client blocks cleanup on the server. */ });
  }, [currentSessionId]);

  React.useEffect(() => {
    void ensureGlobalSessionsLoaded(getAllSyncSessions());
  }, []);

  const candidates = React.useMemo(() => {
    if (autoDeleteAfterDays <= 0) {
      return [];
    }
    return buildAutoDeleteCandidates({
      sessions: globalSessions,
      currentSessionId,
      cutoffDays: autoDeleteAfterDays,
    });
  }, [autoDeleteAfterDays, currentSessionId, globalSessions]);

  const runCleanup = React.useCallback(
      async ({ force = false }: { force?: boolean } = {}): Promise<CleanupResult> => {
      if (runningRef.current) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'running' };
      }

      if (!autoDeleteEnabled || autoDeleteAfterDays <= 0) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'disabled' };
      }

      if (isLoading) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'loading' };
      }

      const now = Date.now();
      if (!force && autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'cooldown' };
      }

      runningRef.current = true;
      setIsRunning(true);
      try {
        await protectRetentionSelection(currentSessionId);
        const result = await runSessionRetention();
        const completedIds = result.completed;
        if (result.action === 'archive') useGlobalSessionsStore.getState().archiveSessions(completedIds);
        else useGlobalSessionsStore.getState().removeSessions(completedIds);
        return { completedIds, failedIds: result.failed.map((entry) => entry.id), action: result.action,
          skipped: result.skipped, skippedReason: result.skipped.find((entry) => entry.id === null)?.reason };
      } catch (error) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction,
          skippedReason: error instanceof Error ? error.message : 'retention_unavailable' };
      } finally {
        runningRef.current = false;
        setIsRunning(false);
        setAutoDeleteLastRunAt(Date.now());
      }
    },
    [
      autoDeleteAfterDays,
      autoDeleteEnabled,
      autoDeleteLastRunAt,
      currentSessionId,
      isLoading,
      sessionRetentionAction,
      setAutoDeleteLastRunAt,
    ]
  );

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!autoRun) {
      return;
    }
    if (!autoDeleteEnabled || autoDeleteAfterDays <= 0) {
      return;
    }
    if (isLoading || !hasLoadedGlobalSessions || globalSessions.length === 0) {
      return;
    }
    const now = Date.now();
    if (autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
      return;
    }
    void runCleanup();
  }, [
    autoDeleteAfterDays,
    autoDeleteEnabled,
    autoDeleteLastRunAt,
    autoRun,
    enabled,
    hasLoadedGlobalSessions,
    globalSessions.length,
    isLoading,
    runCleanup,
  ]);

  return {
    candidates,
    isRunning,
    runCleanup,
    keepRecentCount: AUTO_DELETE_KEEP_RECENT,
    action: sessionRetentionAction,
  };
};
