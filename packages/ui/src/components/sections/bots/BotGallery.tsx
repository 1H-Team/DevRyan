import React from 'react';
import {
  RiAddLine,
  RiRobot2Line,
} from '@remixicon/react';

import type { BotSummary } from '@/lib/botsApi';
import { cn } from '@/lib/utils';
import { BotAvatar } from '@/components/bots/BotAvatar';

const lifecycleDot = (lifecycle: BotSummary['lifecycle']): string => {
  if (lifecycle === 'active') return 'bg-[var(--status-success)]';
  if (lifecycle === 'paused') return 'bg-[var(--status-warning)]';
  if (lifecycle === 'retired') return 'bg-muted-foreground/35';
  return 'bg-[var(--status-info)]';
};

export type BotGalleryProps = {
  bots: readonly BotSummary[];
  selectedBotId: string | null;
  loading?: boolean;
  error?: string | null;
  canCreate: boolean;
  onSelect: (botId: string) => void;
  onCreate: () => void;
};

export const BotGallery: React.FC<BotGalleryProps> = ({
  bots,
  selectedBotId,
  loading = false,
  error = null,
  canCreate,
  onSelect,
  onCreate,
}) => (
  <aside className="flex min-h-0 w-full shrink-0 flex-col border-b border-border bg-sidebar md:w-64 md:border-b-0 md:border-r">
    <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-3">
      <div className="min-w-0">
        <h2 className="typography-ui-label font-semibold text-foreground">Bots</h2>
      </div>
      {canCreate ? (
        <button
          type="button"
          className="app-region-no-drag flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
          aria-label="Create Bot"
          aria-haspopup="dialog"
          title="Create Bot"
          onClick={onCreate}
        >
          <RiAddLine className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>

    <div className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-busy={loading || undefined}>
      {loading ? (
        <p className="px-2 py-3 typography-ui text-muted-foreground" role="status">Loading Bots…</p>
      ) : error ? (
        <div className="px-3 py-8 text-center" role="alert">
          <RiRobot2Line className="mx-auto h-5 w-5 text-muted-foreground/60" aria-hidden />
          <p className="mt-2 typography-ui-label text-foreground">Catalog unavailable</p>
          <p className="mt-1 typography-micro text-muted-foreground">{error}</p>
        </div>
      ) : bots.length === 0 ? (
        <div className="px-3 py-8 text-center">
          <RiRobot2Line className="mx-auto h-5 w-5 text-muted-foreground/60" aria-hidden />
          <p className="mt-2 typography-ui-label text-foreground">No Bots assigned</p>
          <p className="mt-1 typography-micro text-muted-foreground">
            {canCreate ? 'Create the first Bot.' : 'Someone with Bot settings access can add you.'}
          </p>
        </div>
      ) : (
        <ul aria-label="Bots" className="space-y-0.5">
          {bots.map((bot) => {
            const selected = bot.id === selectedBotId;
            return (
              <li key={bot.id}>
                <button
                  type="button"
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => onSelect(bot.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors',
                    'hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                    selected && 'bg-interactive-active',
                  )}
                >
                  <BotAvatar bot={bot} className="h-9 w-9 rounded-[10px] typography-ui-label" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate typography-ui-label font-medium text-foreground">{bot.name}</span>
                    {/* A title that just repeats the name is noise, not a subtitle. */}
                    {bot.title && bot.title !== bot.name ? (
                      <span className="block truncate typography-micro text-muted-foreground">{bot.title}</span>
                    ) : null}
                    <span className="mt-0.5 flex items-center gap-1.5 typography-micro capitalize text-muted-foreground">
                      <span className={cn('h-1.5 w-1.5 rounded-full', lifecycleDot(bot.lifecycle))} aria-hidden />
                      {bot.activeRevisionId ? bot.lifecycle : 'Setup Incomplete'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  </aside>
);
