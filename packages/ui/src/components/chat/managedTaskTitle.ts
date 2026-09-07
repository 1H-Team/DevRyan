import React from 'react';
import { isManagedTaskPlaceholderSession } from '@openchamber/orchestration-runtime';
import { isCursorAcpErrorTitle, isPlaceholderSessionTitle, resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { useDirectoryStore } from '@/sync/sync-context';
import { subscribeToSessionBranch } from '@/sync/session-selectors';

type TaskTitleIdentity = { childSessionId: string | null; agent: string; directory: string };

/** A task label is never proof that its canonical child title has loaded. */
export const resolveManagedTaskTitle = (
  task: Pick<TaskTitleIdentity, 'childSessionId' | 'agent'> | undefined,
  title: string | undefined,
): string | null => {
  if (!task?.childSessionId || !title?.trim() || isPlaceholderSessionTitle(title)
    || isCursorAcpErrorTitle(title)
    || isManagedTaskPlaceholderSession({ title, agent: task.agent, parentID: 'managed-parent' })) return null;
  return resolveDisplaySessionTitle({ title, fallback: '' }) || null;
};

export const useManagedTaskTitle = (task: TaskTitleIdentity | undefined): string | null => {
  const store = useDirectoryStore(task?.directory);
  const childSessionId = task?.childSessionId;
  const agent = task?.agent;
  const subscribe = React.useCallback((notify: () => void) => (
    childSessionId ? subscribeToSessionBranch(store, notify) : () => undefined
  ), [childSessionId, store]);
  const getSnapshot = React.useCallback(() => (
    resolveManagedTaskTitle(
      childSessionId && agent ? { childSessionId, agent } : undefined,
      childSessionId ? store.getState().session.find((session) => session.id === childSessionId)?.title : undefined,
    )
  ), [agent, childSessionId, store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
