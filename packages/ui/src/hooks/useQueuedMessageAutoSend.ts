import React from 'react';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getSyncSessionStatusAnyDirectory, getSyncBlockingRequestCountAnyDirectory } from '@/sync/sync-refs';
import { useAllSessionStatuses } from '@/sync/sync-context';
import { resolveQueuedAutoSendStatusType, type SessionStatusType } from './queuedMessageAutoSendStatus';
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
  const sessionStatusRecord = useAllSessionStatuses(enabled);

  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const dispatchSessionQueue = async (sessionId: string, queueSnapshot: QueuedMessage[]) => {
      if (queueSnapshot.length === 0) {
        return;
      }
      if (inFlightSessionsRef.current.has(sessionId)) {
        return;
      }
      const currentStatus = resolveQueuedAutoSendStatusType(
        sessionId,
        sessionStatusRecord,
        getSyncSessionStatusAnyDirectory(sessionId),
        getSyncBlockingRequestCountAnyDirectory(sessionId),
      );
      if (currentStatus !== 'idle') {
        return;
      }

      const fallbackSendConfig = resolveSessionSendConfig(sessionId);
      if (!fallbackSendConfig.providerID || !fallbackSendConfig.modelID) {
        return;
      }

      inFlightSessionsRef.current.add(sessionId);

      try {
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
        console.warn('[queue] queued auto-send failed:', error);
      } finally {
        inFlightSessionsRef.current.delete(sessionId);
      }
    };

    const statusRecord = sessionStatusRecord ?? {};
    const nextStatusMap = new Map(previousStatusRef.current);
    for (const [sessionId, status] of Object.entries(statusRecord)) {
      if (status) {
        nextStatusMap.set(sessionId, status.type as SessionStatusType);
      }
    }

    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([sessionId, queue]) => {
      const currentStatusType = resolveQueuedAutoSendStatusType(
        sessionId,
        statusRecord,
        getSyncSessionStatusAnyDirectory(sessionId),
        // Queue ownership follows the OpenCode session id. During reconnects or
        // directory switches, the blocking request can live in another child store.
        getSyncBlockingRequestCountAnyDirectory(sessionId),
      );
      const previousStatusType = previousStatusRef.current.get(sessionId);
      const becameIdle =
        (previousStatusType === 'busy'
          || previousStatusType === 'retry'
          || previousStatusType === 'blocked'
          || previousStatusType === 'unknown')
        && currentStatusType === 'idle';
      const firstSeenIdle = previousStatusType === undefined && currentStatusType === 'idle';

      if (queue.length > 0 && (becameIdle || firstSeenIdle)) {
        void dispatchSessionQueue(sessionId, queue);
      }

      nextStatusMap.set(sessionId, currentStatusType);
    });

    previousStatusRef.current = nextStatusMap;
  }, [enabled, queuedMessages, sessionStatusRecord, t]);
}
