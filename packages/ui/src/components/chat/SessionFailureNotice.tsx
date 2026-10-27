import { usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';
import React from 'react';
import { useNotificationStore } from '@/sync/notification-store';
import { describeSessionFailure, isSessionCancellation, sessionFailureRetryAt } from '@/sync/session-failure';

// Provider reset times: a clock time today, with the date when later.
const formatResetTime = (at: number): string => {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? `at ${time}` : `on ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
};

export const SessionFailureNotice = React.memo(({ sessionId }: { sessionId: string }) => {
  const failure = useNotificationStore((state) => {
    for (let index = state.list.length - 1; index >= 0; index--) {
      const notification = state.list[index];
      if (notification.session === sessionId && notification.type === 'error' && !notification.resolvedByMessageId) return notification;
    }
    return undefined;
  });
  const hostFailure = usePrimaryRecoveryStore((state) => state.snapshots[sessionId]?.record?.failureObserved === true);
  if (failure?.type === 'error' && isSessionCancellation(failure.error)) return null;
  if ((!failure || failure.type !== 'error') && !hostFailure) return null;
  const described = describeSessionFailure(failure?.type === 'error' ? failure.error : undefined);
  const retryAt = failure?.type === 'error' ? sessionFailureRetryAt(failure.error, failure.time) : undefined;
  const resets = retryAt !== undefined && retryAt > Date.now() ? formatResetTime(retryAt) : undefined;
  return <div className="chat-message-column px-4 py-3"><div role="alert"
    className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 typography-meta">
    <p className="font-medium">{described.code === 'execution_recovery_unavailable' ? 'Automatic recovery stopped' : 'Request failed'}</p>
    <p className="mt-1">{described.message}</p>
    {resets && <p className="mt-1 text-muted-foreground">Resets {resets}.</p>}
  </div></div>;
});
SessionFailureNotice.displayName = 'SessionFailureNotice';
