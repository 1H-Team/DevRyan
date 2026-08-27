import React from 'react';
import { RiAttachment2 } from '@remixicon/react';

import { BotAvatar } from '@/components/bots/BotAvatar';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { BotSummary } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotLiveMessageStore } from '@/stores/useBotLiveMessageStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotSharedFilesStore } from '@/stores/useBotSharedFilesStore';
import { stripAssistantImageMarkdown } from '../../../../../shared-runtime/lib/assistant-image-sources.js';
import { BotResultAttachments } from './BotResultAttachments';

type BotMessageRowProps = {
  bot: BotSummary;
  messageId: string;
  showAvatar?: boolean;
};

const formatMessageTime = (value: string): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
};

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

const markOptimisticRender = (): void => {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.clearMarks?.('bot.optimistic-render');
      performance.mark('bot.optimistic-render');
    }
  } catch {
    // Rendering must not depend on browser performance instrumentation.
  }
};

export const BotMessageRow = React.memo<BotMessageRowProps>(({ bot, messageId, showAvatar = true }) => {
  const { t } = useI18n();
  const message = useBotChannelStore((state) => state.messagesById[messageId]);
  const notConfirmed = useBotChannelStore((state) => state.unconfirmedMessageIds[messageId] === true);
  const liveMessage = useBotLiveMessageStore((state) => state.messagesById[messageId]);
  const sharedFileCount = useBotSharedFilesStore(
    (state) => state.fileIdsByMessageId[messageId]?.length ?? 0,
  );
  const runId = message?.runId ?? liveMessage?.runId ?? null;
  const runState = useBotOperationsStore((state) => (
    runId ? state.runsById[runId]?.state : undefined
  ));
  React.useLayoutEffect(() => {
    if (message?.role === 'user' && message.runId === null && message.finalizedAt === null) {
      markOptimisticRender();
    }
  }, [message?.finalizedAt, message?.role, message?.runId]);

  if (!message && !liveMessage) return null;

  const role = message?.role ?? 'assistant';
  const isUser = role === 'user';
  const isAssistant = role === 'assistant';
  if (!isUser && !isAssistant) return null;
  const text = liveMessage?.text ?? message?.body.text ?? '';
  const attachmentIds = message?.body.attachmentIds ?? [];
  const attachmentCount = message?.attachmentCount ?? 0;
  if (isAssistant && text.trim().length === 0 && attachmentCount === 0 && sharedFileCount === 0) return null;
  const actorLabel = isUser ? t('bots.chat.message.you') : bot.name;
  const isUpdating = (liveMessage !== undefined || message?.finalizedAt === null)
    && (runState === undefined || !TERMINAL_RUN_STATES.has(runState));
  const createdAt = message?.createdAt ?? liveMessage?.createdAt ?? '';
  const displayedText = isAssistant ? stripAssistantImageMarkdown(text) : text;

  return (
    <article
      data-bot-message-id={messageId}
      data-bot-message-role={role}
      className={cn('group flex min-w-0', isUser ? 'justify-end' : 'justify-start')}
      aria-label={t('bots.chat.message.aria', { actor: actorLabel })}
    >
      <div className={cn(
        'flex min-w-0 max-w-[92%] items-end gap-3 sm:max-w-[78%]',
        isUser && 'flex-row-reverse',
      )}>
        {isAssistant ? (
          showAvatar ? (
            <BotAvatar bot={bot} className="h-14 w-14 rounded-full typography-ui-label" />
          ) : <span className="h-14 w-14 shrink-0" aria-hidden />
        ) : null}
        <div className="min-w-0">
          <div
            className={cn(
              'min-w-0 break-words rounded-2xl px-3.5 py-2.5',
              isUser
                ? 'rounded-br-md bg-foreground typography-body text-background'
                : 'rounded-bl-md border border-border/60 bg-[var(--surface-subtle)]/55 typography-markdown-body text-foreground',
            )}
          >
            {isUser ? (
              <p className="whitespace-pre-wrap break-words">{text}</p>
            ) : (
              <MarkdownRenderer
                content={displayedText}
                messageId={messageId}
                isStreaming={isUpdating}
                disableStreamAnimation={false}
                enableFileReferences={false}
                variant="assistant"
              />
            )}
            {isAssistant ? (
              <BotResultAttachments botId={bot.id} messageId={messageId} text={text} />
            ) : null}
            {attachmentIds.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t('bots.chat.attachments.label')}>
                {attachmentIds.map((attachmentId, index) => (
                  <li
                    key={attachmentId}
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-md border px-2 typography-micro',
                      isUser ? 'border-background/30 text-background/80' : 'border-border/60 text-muted-foreground',
                    )}
                  >
                    <RiAttachment2 className="h-3 w-3" aria-hidden />
                    {t('bots.chat.attachments.item', { number: index + 1 })}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className={cn('mt-1 flex items-center gap-1.5 px-1', isUser && 'justify-end')}>
            <time
              className="rounded-sm typography-micro text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              dateTime={createdAt}
              tabIndex={0}
              aria-label={`${actorLabel}, ${formatMessageTime(createdAt)}`}
            >
              {formatMessageTime(createdAt)}
            </time>
            {notConfirmed ? (
              <span className="typography-micro text-[var(--status-warning)]" role="status">
                {t('bots.chat.message.notConfirmed')}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
});

BotMessageRow.displayName = 'BotMessageRow';
