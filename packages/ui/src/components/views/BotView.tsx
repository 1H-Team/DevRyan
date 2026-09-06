import React from 'react';
import { RiRobot2Line } from '@remixicon/react';

import { BotChatView } from '@/components/bots/chat/BotChatView';
import { useI18n } from '@/lib/i18n';
import { botChannelSelectors, useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotsStore } from '@/stores/useBotsStore';

const UnsupportedBotsView: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center px-6 text-center" data-bot-unsupported-host>
      <div className="max-w-md">

          <RiRobot2Line className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />

        <h1 className="mt-4 typography-ui-header font-semibold text-foreground">
          {t('bots.runtime.unsupportedHost')}
        </h1>
        <p className="mt-2 typography-body text-muted-foreground">
          {t('bots.runtime.unsupportedDescription')}
        </p>
      </div>
    </div>
  );
};

export const BotView: React.FC = () => {
  const { t } = useI18n();
  const selectedBotId = useBotsStore((state) => state.selectedBotId);
  const principalId = useBotsStore((state) => state.principalId);
  const capabilities = useBotsStore((state) => state.capabilities);
  const bot = useBotsStore((state) => selectedBotId ? state.botsById[selectedBotId] : undefined);
  const channelId = useBotChannelStore(
    botChannelSelectors.ownerChannelId(selectedBotId ?? '', principalId),
  );

  if (capabilities?.state === 'unsupported_host') return <UnsupportedBotsView  />;
  if (!selectedBotId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <RiRobot2Line className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
          <h1 className="mt-4 typography-ui-header font-semibold text-foreground">
            {t('bots.sidebar.selectPrompt.title')}
          </h1>
          <p className="mt-2 typography-body text-muted-foreground">
            {t('bots.sidebar.selectPrompt.description')}
          </p>
        </div>
      </div>
    );
  }
  if (!bot) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
        {t('bots.chat.botUnavailable')}
      </div>
    );
  }
  return <BotChatView bot={bot} channelId={channelId} />;
};
