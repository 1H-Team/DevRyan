import React from 'react';
import type { SessionStatus } from '@opencode-ai/sdk/v2/client';

import { isQueuedMessageFlushInFlight } from '@/components/chat/queuedSend';
import { buildProviderRecoveryInput } from '@/lib/messages/providerRecovery';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useProviderRecoveryStore } from '@/stores/useProviderRecoveryStore';
import { hostOwnsPrimaryRecovery } from '@/stores/usePrimaryRecoveryStore';
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
  decideInterruptedProviderRecovery,
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
  const pendingInitialIdleRecoveryRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    const previousStatuses = previousStatusesRef.current;
    const activeUserMessageIds = activeUserMessageIdsRef.current;
    const cappedRetryUserMessageIds = cappedRetryUserMessageIdsRef.current;
    const cappedRetryAbortsInFlight = cappedRetryAbortsInFlightRef.current;
    const pendingInitialIdleRecovery = pendingInitialIdleRecoveryRef.current;
    let active = true;
    if (!enabled) {
      previousStatuses.clear();
      activeUserMessageIds.clear();
      cappedRetryUserMessageIds.clear();
      cappedRetryAbortsInFlight.clear();
      pendingInitialIdleRecovery.clear();
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
        if (hostOwnsPrimaryRecovery(sessionId)) continue;

        nextStatuses.set(sessionId, status.type);
        const messages = directory ? getSyncMessages(sessionId, directory) : [];
        const userMessageId = latestUserMessageId(messages);
        const recoveryStore = useProviderRecoveryStore.getState();
        if (recoveryStore.recoveriesBySessionId[sessionId]) {
          recoveryStore.reconcileLatestUserMessage(sessionId, userMessageId);
        }
        if (status.type === 'busy' || status.type === 'retry') {
          pendingInitialIdleRecovery.delete(sessionId);
          if (directory) {
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
        if (status.type !== 'idle' || !directory) continue;
        const queuedMessageCount = useMessageQueueStore.getState().getQueueForSession(sessionId).length
          + (isQueuedMessageFlushInFlight(sessionId) ? 1 : 0);
        const blockingRequestCount = getSyncBlockingRequestCountAnyDirectory(sessionId);
        let decision: { reason: string } | null = null;
        if (previous === 'busy' || previous === 'retry') {
          pendingInitialIdleRecovery.delete(sessionId);
          decision = decideProviderErrorRecovery({
            messages,
            observedActiveUserMessageId: activeUserMessageIds.get(sessionId),
            queuedMessageCount,
            blockingRequestCount,
          });
        } else if (previous === undefined || pendingInitialIdleRecovery.has(sessionId)) {
          if (messages.length === 0) {
            pendingInitialIdleRecovery.add(sessionId);
          } else {
            pendingInitialIdleRecovery.delete(sessionId);
            decision = decideInterruptedProviderRecovery({
              messages,
              queuedMessageCount,
              blockingRequestCount,
            });
          }
        }
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
      for (const sessionId of pendingInitialIdleRecovery) {
        if (!nextStatuses.has(sessionId)) pendingInitialIdleRecovery.delete(sessionId);
      }
    };

    processStatusSnapshot();
    const unsubscribe = childStores.subscribeProviderRecoveryInputs(processStatusSnapshot);
    return () => {
      active = false;
      unsubscribe();
      previousStatuses.clear();
      activeUserMessageIds.clear();
      cappedRetryUserMessageIds.clear();
      cappedRetryAbortsInFlight.clear();
      pendingInitialIdleRecovery.clear();
      useProviderRecoveryStore.getState().reset();
    };
  }, [childStores, enabled]);
}
