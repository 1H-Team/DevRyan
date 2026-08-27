import React from 'react';

import type { BotSummary } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { BotAvatar } from '../BotAvatar';

type BotIdentityHeaderProps = {
  bot: BotSummary | null;
  mobile: boolean;
  style?: React.CSSProperties;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
};

export const BotIdentityHeader: React.FC<BotIdentityHeaderProps> = ({
  bot,
  mobile,
  style,
  onMouseDown,
}) => {
  const { t } = useI18n();

  if (mobile) {
    return (
      <div
        className="app-region-drag relative flex min-h-20 items-center gap-3 px-14 py-3 select-none"
        data-bot-identity-header="mobile"
      >
        {bot ? <BotAvatar bot={bot} className="h-14 w-14 shrink-0 rounded-full typography-ui-label" /> : null}
        <span className="flex min-h-14 min-w-0 flex-1 flex-col justify-center">
          <span className="line-clamp-2 break-words typography-ui-label font-semibold text-foreground">
            {bot?.name || t('bots.sidebar.title')}
          </span>
          {bot?.title ? (
            <span className="line-clamp-2 break-words typography-micro text-muted-foreground">{bot.title}</span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div
      onMouseDown={onMouseDown}
      className="app-region-drag relative flex min-h-[88px] w-full select-none items-center py-3"
      style={style}
      data-bot-identity-header="desktop"
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        {bot ? <BotAvatar bot={bot} className="h-16 w-16 shrink-0 rounded-full typography-ui-label" /> : null}
        <span className="flex min-h-16 min-w-0 flex-1 flex-col justify-center py-1">
          <span className="line-clamp-2 break-words typography-ui-label font-semibold text-foreground">
            {bot?.name || t('bots.sidebar.title')}
          </span>
          {bot?.title ? (
            <span className="line-clamp-2 break-words typography-micro text-muted-foreground">{bot.title}</span>
          ) : null}
        </span>
      </div>
    </div>
  );
};
