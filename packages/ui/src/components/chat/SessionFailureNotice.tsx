import { usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';
import React from 'react';
import { useNotificationStore } from '@/sync/notification-store';
import { describeSessionFailure, isSessionCancellation } from '@/sync/session-failure';

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
  return <div className="chat-message-column px-4 py-3"><div role="alert"
    className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 typography-meta">
    <p className="font-medium">Request failed</p>
    <p className="mt-1">{describeSessionFailure(failure?.type === 'error' ? failure.error : undefined).message}</p>
  </div></div>;
});
SessionFailureNotice.displayName = 'SessionFailureNotice';
