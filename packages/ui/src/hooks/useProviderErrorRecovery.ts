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
} from '@/sync/sync-refs';
import { useSyncChildStores } from '@/sync/sync-context';
import { decideProviderErrorRecovery } from './providerErrorRecoveryDecision';

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

  React.useEffect(() => {
    const previousStatuses = previousStatusesRef.current;
    const activeUserMessageIds = activeUserMessageIdsRef.current;
    if (!enabled) {
      previousStatuses.clear();
      activeUserMessageIds.clear();
      return;
    }

    const processStatusSnapshot = () => {
      const statuses = aggregateLiveSessionStatuses(
        Array.from(childStores.children.values(), (store) => store.getState()),
      );
      const nextStatuses = new Map<string, SessionStatus['type']>();
      for (const [sessionId, status] of Object.entries(statuses)) {
        nextStatuses.set(sessionId, status.type);
        const directory = getSyncSessionDirectoryAnyDirectory(sessionId);
        if (status.type === 'busy' || status.type === 'retry') {
          if (directory) {
            const userMessageId = latestUserMessageId(getSyncMessages(sessionId, directory));
            if (userMessageId) activeUserMessageIds.set(sessionId, userMessageId);
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
      unsubscribe();
      previousStatuses.clear();
      activeUserMessageIds.clear();
      useProviderRecoveryStore.getState().reset();
    };
  }, [childStores, enabled]);
}
