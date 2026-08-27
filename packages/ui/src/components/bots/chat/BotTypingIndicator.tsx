import React from 'react';

import { BotAvatar } from '@/components/bots/BotAvatar';
import type { BotSummary } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';

const DOT_DELAYS = ['0ms', '160ms', '320ms'] as const;

export const BotTypingIndicator: React.FC<{ bot: BotSummary }> = ({ bot }) => {
  const { t } = useI18n();

  return (
    <div
      className="flex min-w-0 justify-start"
      role="status"
      aria-label={t('bots.chat.typing', { bot: bot.name })}
      data-bot-typing-indicator={bot.id}
    >
      <div className="flex min-w-0 max-w-[78%] items-end gap-3">
        <BotAvatar bot={bot} className="h-14 w-14 rounded-full typography-ui-label" />
        <div
          className="flex h-10 items-center gap-1.5 rounded-2xl rounded-bl-md border border-border/60 bg-[var(--surface-subtle)]/55 px-4"
          aria-hidden="true"
        >
          {DOT_DELAYS.map((animationDelay) => (
            <span
              key={animationDelay}
              className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bot-typing-dot motion-reduce:animate-none"
              style={{ animationDelay }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
