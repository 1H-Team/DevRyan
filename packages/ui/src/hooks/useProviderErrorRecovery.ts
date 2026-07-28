import React from 'react';
import type { SessionStatus } from '@opencode-ai/sdk/v2/client';

import { isQueuedMessageFlushInFlight } from '@/components/chat/queuedSend';
import { buildProviderRecoveryInput } from '@/lib/messages/providerRecovery';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useProviderRecoveryStore } from '@/stores/useProviderRecoveryStore';
import { aggregateLiveSessionStatuses } from '@/sync/live-aggregate';
import {
  getSyncBlockingRequestCountAnyDirectory,
  getSyncMessages,
  getSyncSessionDirectoryAnyDirectory,
  getSyncSessions,
} from '@/sync/sync-refs';
import { useSyncChildStores } from '@/sync/sync-context';
import { abortCurrentOperationConfirmed } from '@/sync/session-actions';
import {
  decideProviderErrorRecovery,
  decideProviderRetryLoopRecovery,
  isPrimaryProviderRecoverySession,
} from './providerErrorRecoveryDecision';

const latestUserMessageId = (messages: ReturnType<typeof getSyncMessages>) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index].id;
  }
  return undefined;
};

export function useProviderErrorRecovery(enabled = true): void {
  const childStores = useSyncChildStores();
  const previousStatusesRef = React.useRef<Map<string, SessionStatus['type']>>(new Map());
  const activeUserMessageIdsRef = React.useRef<Map<string, string>>(new Map());
  const cappedRetryUserMessageIdsRef = React.useRef<Map<string, string>>(new Map());
  const cappedRetryAbortsInFlightRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    const previousStatuses = previousStatusesRef.current;
    const activeUserMessageIds = activeUserMessageIdsRef.current;
    const cappedRetryUserMessageIds = cappedRetryUserMessageIdsRef.current;
    const cappedRetryAbortsInFlight = cappedRetryAbortsInFlightRef.current;
    let active = true;
    if (!enabled) {
      previousStatuses.clear();
      activeUserMessageIds.clear();
      cappedRetryUserMessageIds.clear();
      cappedRetryAbortsInFlight.clear();
      return;
    }

    const processStatusSnapshot = () => {
      const statuses = aggregateLiveSessionStatuses(
        Array.from(childStores.children.values(), (store) => store.getState()),
      );
      const nextStatuses = new Map<string, SessionStatus['type']>();
      for (const [sessionId, status] of Object.entries(statuses)) {
        const directory = getSyncSessionDirectoryAnyDirectory(sessionId);
        const session = directory
          ? getSyncSessions(directory).find((candidate) => candidate.id === sessionId)
          : undefined;
        if (!isPrimaryProviderRecoverySession(session)) continue;

        nextStatuses.set(sessionId, status.type);
        if (status.type === 'busy' || status.type === 'retry') {
          if (directory) {
            const messages = getSyncMessages(sessionId, directory);
            const userMessageId = latestUserMessageId(messages);
            if (userMessageId) activeUserMessageIds.set(sessionId, userMessageId);
            const retryDecision = decideProviderRetryLoopRecovery(status);
            const hasPendingWork = useMessageQueueStore.getState().getQueueForSession(sessionId).length > 0
              || isQueuedMessageFlushInFlight(sessionId)
              || getSyncBlockingRequestCountAnyDirectory(sessionId) > 0;
            if (
              retryDecision
              && userMessageId
              && !hasPendingWork
              && cappedRetryUserMessageIds.get(sessionId) !== userMessageId
              && !cappedRetryAbortsInFlight.has(sessionId)
            ) {
              cappedRetryAbortsInFlight.add(sessionId);
              void abortCurrentOperationConfirmed(sessionId, status).then((confirmed) => {
                if (!active || !confirmed) return;
                cappedRetryUserMessageIds.set(sessionId, userMessageId);
                const currentDirectory = getSyncSessionDirectoryAnyDirectory(sessionId);
                if (!currentDirectory) return;
                const currentMessages = getSyncMessages(sessionId, currentDirectory);
                if (latestUserMessageId(currentMessages) !== userMessageId) return;
                const recovery = buildProviderRecoveryInput({
                  sessionId,
                  directory: currentDirectory,
                  reason: retryDecision.reason,
                  messages: currentMessages,
                });
                if (recovery) useProviderRecoveryStore.getState().offerRecovery(recovery);
              }).finally(() => {
                cappedRetryAbortsInFlight.delete(sessionId);
              });
            }
          }
          continue;
        }
        const previous = previousStatuses.get(sessionId);
        if ((previous !== 'busy' && previous !== 'retry') || status.type !== 'idle' || !directory) continue;
        const messages = getSyncMessages(sessionId, directory);
        const decision = decideProviderErrorRecovery({
          messages,
          observedActiveUserMessageId: activeUserMessageIds.get(sessionId),
          queuedMessageCount: useMessageQueueStore.getState().getQueueForSession(sessionId).length
            + (isQueuedMessageFlushInFlight(sessionId) ? 1 : 0),
          blockingRequestCount: getSyncBlockingRequestCountAnyDirectory(sessionId),
        });
        activeUserMessageIds.delete(sessionId);
        if (!decision) continue;
        const recovery = buildProviderRecoveryInput({
          sessionId,
          directory,
          reason: decision.reason,
          messages,
        });
        if (recovery) useProviderRecoveryStore.getState().offerRecovery(recovery);
      }
      previousStatuses.clear();
      for (const [sessionId, status] of nextStatuses) previousStatuses.set(sessionId, status);
    };

    processStatusSnapshot();
    const unsubscribe = childStores.subscribeSessionStatuses(processStatusSnapshot);
    return () => {
      active = false;
      unsubscribe();
      previousStatuses.clear();
      activeUserMessageIds.clear();
      cappedRetryUserMessageIds.clear();
      cappedRetryAbortsInFlight.clear();
      useProviderRecoveryStore.getState().reset();
    };
  }, [childStores, enabled]);
}
