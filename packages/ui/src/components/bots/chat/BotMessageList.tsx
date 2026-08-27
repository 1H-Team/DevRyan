import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import type { BotSummary } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotLiveMessageStore } from '@/stores/useBotLiveMessageStore';
import { useBotSharedFilesStore } from '@/stores/useBotSharedFilesStore';
import { BotMessageRow } from './BotMessageRow';
import { BotRunFailureNotice } from './BotRunFailureNotice';
import { BotTypingIndicator } from './BotTypingIndicator';
import {
  isWithinBotAutoFollowThreshold,
  restoreBotPrependScrollTop,
} from './botScrollFollow';
import { shouldShowBotTypingIndicator } from './botTypingState';

const EMPTY_MESSAGE_IDS: readonly string[] = Object.freeze([]);

type BotMessageListProps = {
  bot: BotSummary;
  channelId: string;
  typingRunId: string | null;
  acceptingMessage?: boolean;
};

type PendingPrepend = {
  channelId: string;
  firstMessageId: string | null;
  scrollHeight: number;
  scrollTop: number;
};

export const BotMessageList: React.FC<BotMessageListProps> = ({
  bot,
  channelId,
  typingRunId,
  acceptingMessage = false,
}) => {
  const { t } = useI18n();
  const sharedMessageIds = useBotSharedFilesStore(useShallow((state) => (
    (state.fileIdsByChannelId[channelId] ?? []).map((fileId) => state.filesById[fileId]?.messageId)
      .filter((messageId): messageId is string => typeof messageId === 'string')
  )));
  const sharedMessageIdSet = React.useMemo(() => new Set(sharedMessageIds), [sharedMessageIds]);
  const canonicalMessageIds = useBotChannelStore(useShallow((state) => (
    (state.messageIdsByChannelId[channelId] ?? EMPTY_MESSAGE_IDS).filter((messageId) => {
      const message = state.messagesById[messageId];
      if (message?.role !== 'user' && message?.role !== 'assistant') return false;
      if (message.role === 'assistant' && message.assistantPhase === 'acknowledgment') return false;
      return message.role === 'user'
        || message.body.text.trim().length > 0
        || message.attachmentCount > 0
        || sharedMessageIdSet.has(messageId);
    })
  )));
  const liveMessageId = useBotLiveMessageStore(
    (state) => state.messageIdByChannelId[channelId] ?? null,
  );
  const messageIds = React.useMemo(() => (
    liveMessageId && !canonicalMessageIds.includes(liveMessageId)
      ? [...canonicalMessageIds, liveMessageId]
      : canonicalMessageIds
  ), [canonicalMessageIds, liveMessageId]);
  const nextCursor = useBotChannelStore((state) => state.nextCursorByChannelId[channelId]);
  const loading = useBotChannelStore((state) => state.loadingByChannelId[channelId] === true);
  const loadError = useBotChannelStore((state) => state.loadErrorCodeByChannelId[channelId]);
  const canonicalTypingIndicator = useBotChannelStore((state) => shouldShowBotTypingIndicator({
    typingRunId,
    messageIds: canonicalMessageIds,
    messagesById: state.messagesById,
  }));
  const showTypingIndicator = (acceptingMessage || canonicalTypingIndicator) && liveMessageId === null;
  const latestMessageId = messageIds.at(-1);
  const latestContentText = useBotChannelStore((state) => (
    latestMessageId ? state.messagesById[latestMessageId]?.body.text ?? '' : ''
  ));
  const latestAttachmentCount = useBotChannelStore((state) => (
    latestMessageId ? state.messagesById[latestMessageId]?.attachmentCount ?? 0 : 0
  ));
  const latestFinalizedAt = useBotChannelStore((state) => (
    latestMessageId ? state.messagesById[latestMessageId]?.finalizedAt ?? null : null
  ));
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const pinnedRef = React.useRef(true);
  const resizeObserverAvailableRef = React.useRef(false);
  const pendingPrependRef = React.useRef<PendingPrepend | null>(null);
  const messageSnapshot = useBotChannelStore.getState().messagesById;
  const liveSnapshot = useBotLiveMessageStore.getState().messagesById;
  const runHasAttachments = new Map<string, boolean>();
  for (const messageId of messageIds) {
    const message = messageSnapshot[messageId];
    if (message?.runId && message.role === 'user') {
      runHasAttachments.set(message.runId, message.attachmentCount > 0);
    }
  }

  const scrollToBottom = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  React.useLayoutEffect(() => {
    pinnedRef.current = true;
    pendingPrependRef.current = null;
    scrollToBottom();
  }, [channelId, scrollToBottom]);

  React.useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') {
      resizeObserverAvailableRef.current = false;
      return;
    }

    resizeObserverAvailableRef.current = true;
    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(content);
    return () => {
      observer.disconnect();
      resizeObserverAvailableRef.current = false;
    };
  }, [scrollToBottom]);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const pendingPrepend = pendingPrependRef.current;
    if (
      pendingPrepend
      && pendingPrepend.channelId === channelId
      && pendingPrepend.firstMessageId !== (messageIds[0] ?? null)
    ) {
      element.scrollTop = restoreBotPrependScrollTop({
        previousScrollHeight: pendingPrepend.scrollHeight,
        previousScrollTop: pendingPrepend.scrollTop,
        nextScrollHeight: element.scrollHeight,
      });
      pendingPrependRef.current = null;
      return;
    }
    if (!resizeObserverAvailableRef.current) scrollToBottom();
  }, [
    channelId,
    latestAttachmentCount,
    latestContentText,
    latestFinalizedAt,
    messageIds,
    scrollToBottom,
    showTypingIndicator,
  ]);

  const loadOlderMessages = React.useCallback(async () => {
    const element = scrollRef.current;
    if (element) {
      pendingPrependRef.current = {
        channelId,
        firstMessageId: messageIds[0] ?? null,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
      pinnedRef.current = false;
    }
    try {
      await useBotChannelStore.getState().loadOlderMessages(channelId);
    } finally {
      const pendingPrepend = pendingPrependRef.current;
      const firstMessageId = useBotChannelStore.getState().messageIdsByChannelId[channelId]?.[0] ?? null;
      if (pendingPrepend?.channelId === channelId && pendingPrepend.firstMessageId === firstMessageId) {
        pendingPrependRef.current = null;
        const current = scrollRef.current;
        if (current) {
          pinnedRef.current = isWithinBotAutoFollowThreshold(
            current.scrollHeight,
            current.scrollTop,
            current.clientHeight,
          );
        }
      }
    }
  }, [channelId, messageIds]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 sm:px-6"
      style={{ overflowAnchor: 'none' }}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinnedRef.current = isWithinBotAutoFollowThreshold(
          element.scrollHeight,
          element.scrollTop,
          element.clientHeight,
        );
      }}
      aria-label={t('bots.chat.transcriptAria')}
      tabIndex={0}
    >
      <div ref={contentRef} className="mx-auto w-full max-w-[760px]">
        {nextCursor ? (
          <div className="mb-2 flex justify-center">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={loading}
              onClick={() => void loadOlderMessages().catch(() => undefined)}
            >
              {loading ? t('bots.chat.loadingOlder') : t('bots.chat.loadOlder')}
            </Button>
          </div>
        ) : null}

        {messageIds.length > 0 || showTypingIndicator ? (
          <div className="space-y-3 py-2" role="log" aria-live="polite" aria-relevant="additions text">
            {messageIds.map((messageId, index) => {
              const message = messageSnapshot[messageId];
              const liveMessage = liveSnapshot[messageId];
              const previousId = index > 0 ? messageIds[index - 1] : null;
              const previousRole = previousId
                ? messageSnapshot[previousId]?.role ?? (liveSnapshot[previousId] ? 'assistant' : null)
                : null;
              const next = index + 1 < messageIds.length
                ? messageSnapshot[messageIds[index + 1]]
                : undefined;
              const runId = message?.runId ?? liveMessage?.runId ?? null;
              const failureRunId = runId && runId !== next?.runId
                ? runId
                : null;
              return (
                <React.Fragment key={messageId}>
                  <BotMessageRow
                    bot={bot}
                    messageId={messageId}
                    showAvatar={(message?.role === 'assistant' || Boolean(liveMessage))
                      && previousRole !== 'assistant'}
                  />
                  {failureRunId ? (
                    <BotRunFailureNotice
                      runId={failureRunId}
                      channelId={channelId}
                      sourceHasAttachments={runHasAttachments.get(failureRunId) === true}
                    />
                  ) : null}
                </React.Fragment>
              );
            })}
            {showTypingIndicator ? <BotTypingIndicator bot={bot} /> : null}
          </div>
        ) : loading ? (
          <p className="py-12 text-center typography-ui-label text-muted-foreground" role="status">
            {t('bots.chat.loadingMessages')}
          </p>
        ) : (
          <div className="py-16 text-center">
            <p className="typography-ui-header font-medium text-foreground">{t('bots.chat.empty.title')}</p>
            <p className="mt-1 typography-ui-label text-muted-foreground">{t('bots.chat.empty.description')}</p>
          </div>
        )}

        {loadError ? (
          <p className="mt-3 text-center typography-meta text-[var(--status-error)]" role="alert">
            {t('bots.chat.loadFailed')}
          </p>
        ) : null}
      </div>
    </div>
  );
};
