import React from 'react';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getAllSyncSessionStatuses, getSyncSessionStatusAnyDirectory, getSyncBlockingRequestCountAnyDirectory } from '@/sync/sync-refs';
import { useAllSessionStatuses, useSyncChildStores } from '@/sync/sync-context';
import { aggregateLiveSessions } from '@/sync/live-aggregate';
import type { State } from '@/sync/types';
import {
  resolveQueuedSessionScopeIds,
  resolveQueuedSubtreeStatusType,
  shouldDispatchQueuedSession,
  type SessionStatusType,
} from './queuedMessageAutoSendStatus';
import { resolveSessionSendConfig } from '@/sync/send-config';
import { getPdfAttachmentValidation } from '@/lib/attachments/attachmentCapabilities';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  flushQueuedMessagesForSession,
  QueuedSendAuthorizationRequiredError,
} from '@/components/chat/queuedSend';
import { guardQueuedBuilderSend } from '@/components/chat/agentHandoffGuardContext';

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const { t } = useI18n();
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const isConnected = useConfigStore((state) => state.isConnected);
  const sessionStatusRecord = useAllSessionStatuses(enabled);
  const childStores = useSyncChildStores();
  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const missedIdleEdgesRef = React.useRef<Set<string>>(new Set());
  const enabledRef = React.useRef(enabled); enabledRef.current = enabled;
  const lifecycleRef = React.useRef({ mounted: false, epoch: 0 });
  // Claimed queues disappear from the store while the request is pending. Keep
  // observing those roots so their descendant idle edge cannot be lost.
  const queuedRootIds = [...new Set([...Object.keys(queuedMessages).filter(id => queuedMessages[id]?.length), ...inFlightSessionsRef.current])].sort();
  const rootsKey = JSON.stringify(queuedRootIds);
  const scopeCache = React.useRef<{ roots: string; sources: State['session'][]; signature: string; scopes: Record<string, string[] | null> } | undefined>(undefined);
  const readScopes = React.useCallback(() => {
    const states = enabled && queuedRootIds.length ? Array.from(childStores.children.values(), store => store.getState()) : [];
    const sources = states.map(state => state.session);
    const previous = scopeCache.current;
    if (previous?.roots === rootsKey && previous.sources.length === sources.length && sources.every((source, index) => source === previous.sources[index])) return previous.scopes;
    const sessions = aggregateLiveSessions(states);
    const scopes = Object.fromEntries(queuedRootIds.map(id => [id, resolveQueuedSessionScopeIds(id, sessions)]));
    const signature = JSON.stringify(scopes);
    const stableScopes = previous?.signature === signature ? previous.scopes : scopes;
    scopeCache.current = { roots: rootsKey, sources, signature, scopes: stableScopes };
    return stableScopes;
  }, [childStores, enabled, queuedRootIds, rootsKey]);
  // Only loaded lineage changes can invalidate this snapshot. Streaming parts,
  // titles and timestamps never create a new structural subscription value.
  const sessionScopes = React.useSyncExternalStore(
    React.useCallback(notify => enabled && queuedRootIds.length ? childStores.subscribeAll(notify) : () => {}, [childStores, enabled, queuedRootIds.length]),
    readScopes, readScopes,
  );

  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());
  const previousConnectionStateRef = React.useRef<boolean | undefined>(undefined);

  React.useEffect(() => {
    const lifecycle = lifecycleRef.current;
    const missedIdleEdges = missedIdleEdgesRef.current;
    lifecycle.mounted = true;
    return () => { lifecycle.mounted = false; lifecycle.epoch += 1; missedIdleEdges.clear(); };
  }, []);

  React.useEffect(() => {
    const previousConnectionState = previousConnectionStateRef.current;
    previousConnectionStateRef.current = isConnected;

    if (!enabled) {
      lifecycleRef.current.epoch += 1;
      missedIdleEdgesRef.current.clear();
      return;
    }
    for (const id of missedIdleEdgesRef.current) {
      if (!sessionScopes[id]) missedIdleEdgesRef.current.delete(id);
    }

    const dispatchSessionQueue = async (sessionId: string, queueSnapshot: QueuedMessage[]) => {
      if (queueSnapshot.length === 0) {
        return;
      }
      if (inFlightSessionsRef.current.has(sessionId)) {
        return;
      }
      const currentScope = resolveQueuedSessionScopeIds(sessionId, aggregateLiveSessions(
        Array.from(childStores.children.values(), store => store.getState()),
      ));
      const currentStatus = resolveQueuedSubtreeStatusType(
        currentScope,
        getAllSyncSessionStatuses(),
        getSyncSessionStatusAnyDirectory,
        getSyncBlockingRequestCountAnyDirectory,
      );
      if (!lifecycleRef.current.mounted || !enabledRef.current || !useConfigStore.getState().isConnected || currentStatus !== 'idle') {
        return;
      }

      inFlightSessionsRef.current.add(sessionId);
      const epoch = lifecycleRef.current.epoch;
      let failed = false;
      try {
        const hasCapturedConfigs = queueSnapshot.every(message => (
          message.sendConfig?.providerID && message.sendConfig.modelID
          && typeof message.sendConfig.planMode === 'boolean'
        ));
        const fallbackSendConfig = hasCapturedConfigs
          ? queueSnapshot[0].sendConfig!
          : resolveSessionSendConfig(sessionId);
        if (!fallbackSendConfig.providerID || !fallbackSendConfig.modelID) return;
        await flushQueuedMessagesForSession({
          sessionId,
          waitForCurrentTurnBeforeFirstSend: true,
          fallbackSendConfig: {
            providerID: fallbackSendConfig.providerID,
            modelID: fallbackSendConfig.modelID,
            agent: fallbackSendConfig.agent,
            variant: fallbackSendConfig.variant,
            planMode: fallbackSendConfig.planMode,
          },
          authorizeSend: guardQueuedBuilderSend,
          prepareQueuedMessage: (message, sendConfig) => {
            const agents = useConfigStore.getState().getVisibleAgents();
            const { sanitizedText, mention } = parseAgentMentions(message.content, agents);
            const attachments = message.attachments ?? [];
            const validation = getPdfAttachmentValidation({
              providerID: sendConfig.providerID,
              modelID: sendConfig.modelID,
              files: attachments,
            });

            if (validation.hasPdf && validation.status === 'unsupported') {
              toast.error(t('chat.chatInput.toast.pdfUnsupported'));
              throw new Error('Queued message PDF attachments are unsupported by the selected model');
            }
            if (validation.hasPdf && validation.status === 'unknown') {
              toast.warning(t('chat.chatInput.toast.pdfUnknownSupport'));
            }

            return {
              content: sanitizedText,
              attachments,
              agentMentionName: mention?.name,
              providerID: sendConfig.providerID,
              modelID: sendConfig.modelID,
              agent: sendConfig.agent,
              variant: sendConfig.variant,
              planMode: sendConfig.planMode,
            };
          },
        });
      } catch (error) {
        if (error instanceof QueuedSendAuthorizationRequiredError) return;
        failed = true;
        console.warn('[queue] queued auto-send failed:', error);
      } finally {
        inFlightSessionsRef.current.delete(sessionId);
        const missedIdle = missedIdleEdgesRef.current.delete(sessionId);
        if (failed && missedIdle && epoch === lifecycleRef.current.epoch) {
          // Consume one actual readiness edge, never retry a steady idle failure.
          // The dispatch rechecks current lineage, status and connection itself.
          void dispatchSessionQueue(sessionId, useMessageQueueStore.getState().getQueueForSession(sessionId));
        }
      }
    };

    const statusRecord = sessionStatusRecord ?? {};
    const nextStatusMap = new Map(previousStatusRef.current);
    for (const [sessionId, status] of Object.entries(statusRecord)) {
      if (status) {
        nextStatusMap.set(sessionId, status.type as SessionStatusType);
      }
    }

    const queueEntries = queuedRootIds.map(id => [id, queuedMessages[id] ?? []] as const);
    queueEntries.forEach(([sessionId, queue]) => {
      const currentStatusType = resolveQueuedSubtreeStatusType(
        sessionScopes[sessionId],
        statusRecord,
        getSyncSessionStatusAnyDirectory,
        // Queue ownership follows the OpenCode session id. During reconnects or
        // directory switches, the blocking request can live in another child store.
        getSyncBlockingRequestCountAnyDirectory,
      );
      const previousStatusType = previousStatusRef.current.get(sessionId);

      if (shouldDispatchQueuedSession({
        queueLength: inFlightSessionsRef.current.has(sessionId) ? 1 : queue.length,
        currentStatus: currentStatusType,
        previousStatus: previousStatusType,
        isConnected,
        previousConnectionState,
      })) {
        if (inFlightSessionsRef.current.has(sessionId)) missedIdleEdgesRef.current.add(sessionId);
        else void dispatchSessionQueue(sessionId, queue);
      }
      if (currentStatusType !== 'idle') missedIdleEdgesRef.current.delete(sessionId);

      nextStatusMap.set(sessionId, currentStatusType);
    });

    previousStatusRef.current = nextStatusMap;
  }, [enabled, isConnected, queuedMessages, sessionStatusRecord, sessionScopes, queuedRootIds, childStores, t]);
}
