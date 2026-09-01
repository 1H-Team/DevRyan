import React from 'react';
import { RiAttachment2 } from '@remixicon/react';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { BotSummary } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotSharedFilesStore } from '@/stores/useBotSharedFilesStore';
import { stripAssistantImageMarkdown } from '../../../../../shared-runtime/lib/assistant-image-sources.js';
import { BotResultAttachments } from './BotResultAttachments';

type BotMessageRowProps = {
  bot: BotSummary;
  messageId: string;
};

const formatMessageTime = (value: string): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
};

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

export const BotMessageRow = React.memo<BotMessageRowProps>(({ bot, messageId }) => {
  const { t } = useI18n();
  const message = useBotChannelStore((state) => state.messagesById[messageId]);
  const notConfirmed = useBotChannelStore((state) => state.unconfirmedMessageIds[messageId] === true);
  const sharedFileCount = useBotSharedFilesStore(
    (state) => state.fileIdsByMessageId[messageId]?.length ?? 0,
  );
  React.useLayoutEffect(() => {
    if (message?.role === 'user' && message.runId === null && message.finalizedAt === null) {
      markOptimisticRender();
    }
    if (message?.role === 'assistant' && message.assistantPhase !== 'acknowledgment' && message.finalizedAt !== null) {
      try {
        if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
          performance.clearMarks?.(`bot.final-render:${messageId}`);
          performance.mark(`bot.final-render:${messageId}`);
        }
      } catch {
        // Rendering must not depend on browser performance instrumentation.
      }
    }
  }, [message?.assistantPhase, message?.body.text, message?.finalizedAt, message?.role, message?.runId, messageId]);

  if (!message) return null;

  const role = message.role;
  const isUser = role === 'user';
  const isAssistant = role === 'assistant';
  if (!isUser && !isAssistant) return null;
  if (isAssistant && (message.assistantPhase === 'acknowledgment' || message.finalizedAt === null)) return null;
  const text = message.body.text;
  const attachmentIds = message?.body.attachmentIds ?? [];
  const attachmentCount = message?.attachmentCount ?? 0;
  if (isAssistant && text.trim().length === 0
    && attachmentCount === 0 && sharedFileCount === 0) return null;
  const actorLabel = isUser ? t('bots.chat.message.you') : bot.name;
  const createdAt = message.createdAt;
  const displayedText = isAssistant ? stripAssistantImageMarkdown(text) : text;

  return (
    <article
      data-bot-message-id={messageId}
      data-bot-message-role={role}
      className={cn('group flex min-w-0', isUser ? 'justify-end' : 'justify-start')}
      aria-label={t('bots.chat.message.aria', { actor: actorLabel })}
    >
      <div className="min-w-0 max-w-[92%] sm:max-w-[78%]">
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
                loadingFallback={<p data-bot-final-text-fallback className="whitespace-pre-wrap break-words">{displayedText}</p>}
                messageId={messageId}
                isStreaming={false}
                disableStreamAnimation={true}
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
