import React from 'react';
import { RiRefreshLine, RiRobot2Line } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { botsApi, type BotSummary } from '@/lib/botsApi';
import { releaseBotChannelPrewarm, warmBotChannel } from '@/lib/botPrewarmLease';
import { botsDesktopApi } from '@/lib/botsDesktopApi';
import { useI18n } from '@/lib/i18n';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotSharedFilesStore } from '@/stores/useBotSharedFilesStore';
import { useBotsStore } from '@/stores/useBotsStore';
import { resolveBotRuntimeRecovery } from '../botPresentation';
import { botRuntimeProgressLabel, useBotRuntimeOperation } from '../useBotRuntimeOperation';
import { BotComposer, type BotRuntimeRecoveryAction } from './BotComposer';
import { BotMessageList } from './BotMessageList';
import { resolveBotTypingRunId } from './botTypingState';

const EMPTY_RUN_IDS: readonly string[] = Object.freeze([]);

type BotChatViewProps = {
  bot: BotSummary;
  channelId: string | null;
};

export const BotChatView: React.FC<BotChatViewProps> = ({ bot, channelId }) => {
  const { t } = useI18n();
  const capabilities = useBotsStore((state) => state.capabilities);
  const channel = useBotChannelStore((state) => channelId ? state.channelsById[channelId] : undefined);
  const opening = useBotChannelStore((state) => state.openingOwnerChannelByBotId[bot.id] === true);
  const openError = useBotChannelStore((state) => state.ownerChannelErrorCodeByBotId[bot.id]);
  const acceptingMessage = useBotChannelStore((state) => (
    channelId ? state.pendingMessageIdByChannelId[channelId] !== undefined : false
  ));
  const runIds = useBotOperationsStore((state) => (
    channelId ? state.runIdsByChannelId[channelId] ?? EMPTY_RUN_IDS : EMPTY_RUN_IDS
  ));
  const latestRun = useBotOperationsStore((state) => {
    for (let index = runIds.length - 1; index >= 0; index -= 1) {
      const run = state.runsById[runIds[index]];
      if (run) return run;
    }
    return null;
  });
  const [runtimeActionError, setRuntimeActionError] = React.useState<string | null>(null);
  const runtimeOperation = useBotRuntimeOperation(botsDesktopApi);
  const recoveryKind = resolveBotRuntimeRecovery(capabilities, botsDesktopApi.isAvailable());
  const typingRunId = resolveBotTypingRunId(latestRun);
  const prewarmChannelId = channel?.id;
  const canPrewarmChannel = channel?.canSend === true && channel.lifecycle === 'active';
  const channelAvailable = channel !== undefined;

  React.useEffect(() => {
    if (!channelId || !channelAvailable) return;
    if (useBotChannelStore.getState().nextCursorByChannelId[channelId] !== undefined) return;
    void useBotChannelStore.getState().loadInitialMessages(channelId).catch(() => undefined);
  }, [channelAvailable, channelId]);

  React.useEffect(() => {
    if (!channelId || !channelAvailable) return;
    void botsApi.listSharedFiles(bot.id, channelId).then(({ sharedFiles }) => {
      useBotSharedFilesStore.getState().replaceChannel(channelId, sharedFiles);
    }).catch(() => undefined);
  }, [bot.id, channelAvailable, channelId]);

  React.useEffect(() => {
    useBotChannelStore.getState().setActiveChannel(channelId);
    return () => {
      if (useBotChannelStore.getState().activeChannelId === channelId) {
        useBotChannelStore.getState().setActiveChannel(null);
      }
    };
  }, [channelId]);

  React.useEffect(() => {
    if (!prewarmChannelId || !canPrewarmChannel) return;
    void warmBotChannel(prewarmChannelId).catch(() => undefined);
    return () => { void releaseBotChannelPrewarm(prewarmChannelId); };
  }, [canPrewarmChannel, prewarmChannelId]);

  React.useEffect(() => {
    if (!prewarmChannelId || !canPrewarmChannel || !latestRun) return;
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(latestRun.state)) return;
    void warmBotChannel(prewarmChannelId).catch(() => undefined);
  }, [canPrewarmChannel, latestRun, prewarmChannelId]);

  const recoveryAction = React.useMemo<BotRuntimeRecoveryAction | null>(() => {
    if (!recoveryKind) return null;
    return {
      label: recoveryKind,
      pending: runtimeOperation.pending,
      pendingLabel: botRuntimeProgressLabel(runtimeOperation.progress, t),
      onRun: async () => {
        setRuntimeActionError(null);
        try {
          if (recoveryKind === 'setup') await botsDesktopApi.setup();
          else if (recoveryKind === 'update') await botsDesktopApi.update();
          else await botsDesktopApi.repair();
          await useBotsStore.getState().loadCapabilities();
        } catch (error) {
          setRuntimeActionError(error instanceof Error ? error.message : t('bots.runtime.actionFailed'));
        } finally {
          await runtimeOperation.refresh();
        }
      },
    };
  }, [recoveryKind, runtimeOperation, t]);

  if (!channel) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <RiRobot2Line className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 typography-ui-header font-medium text-foreground">
            {opening ? t('bots.chat.openingChannel') : t('bots.chat.channelUnavailable')}
          </p>
          {openError ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void useBotChannelStore.getState().ensureOwnerChannel(bot.id).catch(() => undefined)}
            >
              <RiRefreshLine /> {t('bots.chat.retryChannel')}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-bot-chat-view={bot.id}>
      <BotMessageList
        bot={bot}
        channelId={channel.id}
        typingRunId={typingRunId}
        acceptingMessage={acceptingMessage}
      />
      <BotComposer
        botId={bot.id}
        channel={channel}
        runtimeState={capabilities?.state ?? 'runtime_unavailable'}
        runtimeAvailable={capabilities?.available === true && bot.lifecycle === 'active'}
        recoveryAction={recoveryAction}
        recoveryError={runtimeActionError || (
          recoveryKind && runtimeOperation.progress?.phase === 'failed'
            ? runtimeOperation.progress.message || null
            : null
        )}
      />
    </div>
  );
};
