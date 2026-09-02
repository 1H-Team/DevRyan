import React from 'react';

import { BotTypingDots } from './BotTypingDots';
import type { BotSummary } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';

export const BotTypingIndicator: React.FC<{ bot: BotSummary }> = ({ bot }) => {
  const { t } = useI18n();

  return (
    <div
      className="flex min-w-0 justify-start"
      role="status"
      aria-label={t('bots.chat.typing', { bot: bot.name })}
      data-bot-typing-indicator={bot.id}
    >
      <div className="min-w-0 max-w-[78%]">
        <div
          className="flex h-10 items-center rounded-2xl rounded-bl-md border border-border/60 bg-[var(--surface-subtle)]/55 px-4"
          aria-hidden="true"
        >
          <BotTypingDots className="gap-1.5" />
        </div>
      </div>
    </div>
  );
};
