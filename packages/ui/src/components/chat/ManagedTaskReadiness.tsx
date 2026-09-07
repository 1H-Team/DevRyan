import React from 'react';
import { managedOrchestrationSelectors, useManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';
import { useSyncResyncSession } from '@/sync/sync-context';
import type { ManagedTaskDispatchFallback, PendingManagedTaskDispatch } from './managedTaskDispatch';
import { useManagedTaskTitle } from './managedTaskTitle';

export type ManagedTaskCandidate = {
  key: string;
  taskId?: string;
  fallback?: ManagedTaskDispatchFallback;
  pending?: PendingManagedTaskDispatch;
};

export type ManagedTaskPresentation = {
  taskId: string | null;
  title: string | null;
  agent: string;
  childSessionId: string | null;
  directory: string | undefined;
  error: 'start' | 'title' | null;
  errorMessage: string | null;
};

export const MANAGED_TITLE_RECOVERY_DELAYS = [500, 10_000, 80_000] as const;

/** Leaf observers stay mounted while the card is hidden. Only presentation
 * changes reach the list; streaming previews never rebuild its groups. */
export const ManagedTaskReadiness = React.memo(({
  candidate,
  rootSessionId,
  recoverMissingDispatch,
  onChange,
}: {
  candidate: ManagedTaskCandidate;
  rootSessionId?: string;
  recoverMissingDispatch: boolean;
  onChange: (key: string, value: ManagedTaskPresentation | null) => void;
}) => {
  const dispatchCallId = candidate.pending?.dispatchCallId ?? candidate.fallback?.dispatchCallId;
  const taskId = useManagedOrchestrationStore(React.useMemo(() => (state) => {
    const sourceId = candidate.taskId || (dispatchCallId
      ? managedOrchestrationSelectors.taskIdForDispatchCall(rootSessionId ?? '', dispatchCallId)(state)
      : null);
    return sourceId ? managedOrchestrationSelectors.taskIdForRecovery(sourceId, {
      rootSessionId: rootSessionId ?? '',
      dispatchCallId: dispatchCallId ?? null,
      childSessionId: candidate.fallback?.childSessionId ?? null,
      directory: candidate.fallback?.directory ?? '',
    })(state) ?? sourceId : null;
  }, [candidate.taskId, candidate.fallback?.childSessionId, candidate.fallback?.directory, dispatchCallId, rootSessionId]));
  const authoritativeTask = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.task(taskId ?? ''), [taskId],
  ));
  const task = authoritativeTask ?? candidate.fallback;
  const title = useManagedTaskTitle(task);
  const resyncSession = useSyncResyncSession();
  const [titleUnavailable, setTitleUnavailable] = React.useState(false);
  const childSessionId = task?.childSessionId ?? null;
  const directory = task?.directory;
  const ready = title !== null;
  const hasAuthoritativeTask = Boolean(authoritativeTask);
  const hasFallback = Boolean(candidate.fallback);

  React.useEffect(() => {
    if (!rootSessionId || hasAuthoritativeTask || (!hasFallback && !recoverMissingDispatch)) return;
    const timer = window.setTimeout(() => {
      void useManagedOrchestrationStore.getState().loadSnapshot({ rootSessionId });
    }, MANAGED_TITLE_RECOVERY_DELAYS[0]);
    return () => window.clearTimeout(timer);
  }, [rootSessionId, hasAuthoritativeTask, hasFallback, recoverMissingDispatch]);

  React.useEffect(() => {
    setTitleUnavailable(false);
    if (!childSessionId || !directory || ready) return;
    let stopped = false;
    let attempt = 0;
    let timer: number;
    const recover = async () => {
      try {
        await resyncSession(childSessionId, { directory, reason: 'manual' });
      } catch { /* Retain the row and expose exhausted recovery below. */ }
      if (stopped) return;
      attempt += 1;
      if (attempt >= MANAGED_TITLE_RECOVERY_DELAYS.length) setTitleUnavailable(true);
      else timer = window.setTimeout(() => void recover(), MANAGED_TITLE_RECOVERY_DELAYS[attempt]);
    };
    timer = window.setTimeout(() => void recover(), MANAGED_TITLE_RECOVERY_DELAYS[0]);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [childSessionId, directory, ready, resyncSession]);

  const terminalWithoutTitle = !ready && Boolean(task && ['failed', 'aborted', 'interrupted'].includes(task.status));
  const startError = !authoritativeTask && !candidate.fallback && candidate.pending?.status === 'error';
  const error = startError || (terminalWithoutTitle && !childSessionId) ? 'start'
    : (terminalWithoutTitle || titleUnavailable) && !ready ? 'title' : null;
  const errorMessage = startError ? candidate.pending?.errorMessage ?? null
    : terminalWithoutTitle && authoritativeTask ? authoritativeTask.failureReason : null;
  const agent = task?.agent ?? candidate.pending?.agent ?? '';
  React.useLayoutEffect(() => {
    onChange(candidate.key, {
      taskId: authoritativeTask?.taskId ?? null, title, agent, childSessionId, directory, error, errorMessage,
    });
  }, [candidate.key, authoritativeTask?.taskId, title, agent, childSessionId, directory, error, errorMessage, onChange]);
  React.useLayoutEffect(() => () => onChange(candidate.key, null), [candidate.key, onChange]);
  return null;
});

ManagedTaskReadiness.displayName = 'ManagedTaskReadiness';
