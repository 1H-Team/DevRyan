import React from 'react';
import { RiLoader4Line } from '@remixicon/react';

import { BotAvatar } from '@/components/bots/BotAvatar';
import type { BotSummary } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useBotChannelStore, type BotChannelStore } from '@/stores/useBotChannelStore';

type BotSidebarRowProps = {
  bot: BotSummary;
  selected: boolean;
  opening: boolean;
  channelId: string | null;
  channelStore?: BotChannelStore;
  onSelect: (botId: string) => void;
};

const lifecycleTone: Record<BotSummary['lifecycle'], string> = {
  draft: 'bg-muted-foreground/60',
  active: 'bg-[var(--status-success)]',
  paused: 'bg-[var(--status-warning)]',
  retired: 'bg-muted-foreground/40',
};

const conversationPreview = (text: string): string => text
  .replace(/```[\s\S]*?```/gu, ' ')
  .replace(/\[([^\]]+)\]\([^\s)]+\)/gu, '$1')
  .replace(/[*_~`>#-]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

const formatConversationTime = (value: string | null): string => {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
};

export const BotSidebarRow = React.memo<BotSidebarRowProps>(({
  bot,
  selected,
  opening,
  channelId,
  channelStore = useBotChannelStore,
  onSelect,
}) => {
  const { t } = useI18n();
  const preview = channelStore((state) => channelId ? state.previewsByChannelId[channelId] : undefined);
  const previewText = preview
    ? conversationPreview(preview.text) || (preview.attachmentCount > 0 ? t('bots.sidebar.attachmentPreview') : '')
    : t('bots.sidebar.startConversation');
  const timestamp = formatConversationTime(preview?.createdAt ?? null);
  const accessiblePreview = previewText.replace(/[.!?]+$/u, '');

  return (
    <button
      type="button"
      data-bot-sidebar-row={bot.id}
      aria-current={selected ? 'page' : undefined}
      aria-label={[t('bots.sidebar.openAria', { name: bot.name }), accessiblePreview, timestamp]
        .filter(Boolean)
        .join('. ')}
      onClick={() => onSelect(bot.id)}
      className={cn(
        'group flex min-h-[72px] w-full min-w-0 items-center gap-3 rounded-lg border px-2.5 py-2.5 text-left',
        'transition-[background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        selected
          ? 'border-border bg-interactive-selection/90 text-foreground shadow-sm'
          : 'border-transparent text-foreground hover:border-border/50 hover:bg-interactive-hover/60',
      )}
    >
      <span className="relative h-11 w-11 shrink-0">
        <BotAvatar bot={bot} className="h-11 w-11 rounded-full typography-ui-label" />
        <span
          className={cn('absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-sidebar', lifecycleTone[bot.lifecycle])}
          aria-hidden
        />
      </span>
      <span className="min-w-0 flex-1 self-stretch py-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5">{bot.name}</span>
          {timestamp ? (
            <time className="shrink-0 typography-micro text-muted-foreground" dateTime={preview?.createdAt}>
              {timestamp}
            </time>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate typography-meta text-muted-foreground">
          {previewText}
        </span>
      </span>
      {opening ? (
        <RiLoader4Line
          className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-label={t('bots.sidebar.opening')}
        />
      ) : null}
    </button>
  );
});

BotSidebarRow.displayName = 'BotSidebarRow';
