import React from 'react';

import { useShallow } from 'zustand/react/shallow';

import { BotSidebarRow } from './BotSidebarRow';
import { resolveBotSidebarStatus, type BotSidebarStatus } from './botSidebarStatus';
import { useBotConnectionWarning } from './useBotConnectionWarning';
import { selectBotCurrentRunId } from '../operations/selectBotCurrentRun';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { retryBotsEventConnection } from '@/apps/botEventConnection';
import { useBotChannelStore, type BotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsStore, type BotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotsStore, type BotsStore } from '@/stores/useBotsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMainSidebarAudienceStore } from '@/stores/useMainSidebarAudienceStore';

type BotSidebarSectionProps = {
  onBotSelected?: (botId: string) => void;

  botsStore?: BotsStore;
  channelStore?: BotChannelStore;
  operationsStore?: BotOperationsStore;
  standalone?: boolean;
};

export const BotSidebarSection: React.FC<BotSidebarSectionProps> = ({
  onBotSelected,

  botsStore = useBotsStore,
  channelStore = useBotChannelStore,
  operationsStore = useBotOperationsStore,
  standalone = false,
}) => {
  const { t } = useI18n();
  const botIds = botsStore((state) => state.botIds);
  const botsById = botsStore((state) => state.botsById);
  const selectedBotId = botsStore((state) => state.selectedBotId);
  const principalId = botsStore((state) => state.principalId);
  const catalogLoaded = botsStore((state) => state.catalogLoaded);
  const catalogLoading = botsStore((state) => state.catalogLoading);
  const catalogErrorCode = botsStore((state) => state.catalogErrorCode);
  const connectionState = operationsStore((state) => state.connectionState);
  const connectionErrorCode = operationsStore((state) => state.connectionErrorCode);
  const connectionFailureStartedAt = operationsStore((state) => state.connectionFailureStartedAt);
  const showConnectionWarning = useBotConnectionWarning(connectionFailureStartedAt);
  const accessDisabled = connectionState === 'unsupported';
  const connectionFailed = showConnectionWarning && Boolean(connectionErrorCode)
    && connectionState !== 'connected' && !accessDisabled;
  const openingByBotId = channelStore((state) => state.openingOwnerChannelByBotId);
  const errorsByBotId = channelStore((state) => state.ownerChannelErrorCodeByBotId);
  const ownerChannelIdByBotId = channelStore(useShallow((state) => {
    const values: Record<string, string> = {};
    for (const channel of Object.values(state.channelsById)) {
      if (channel.ownerUserId === principalId && channel.lifecycle === 'active') {
        values[channel.botId] = channel.id;
      }
    }
    return values;
  }));
  const previewAtByBotId = channelStore(useShallow((state) => {
    const values: Record<string, string | null> = {};
    for (const channel of Object.values(state.channelsById)) {
      if (channel.ownerUserId === principalId && channel.lifecycle === 'active') {
        values[channel.botId] = state.previewsByChannelId[channel.id]?.createdAt ?? null;
      }
    }
    return values;
  }));
  // Run state for every visible Bot already streams into the operations store;
  // project it to one primitive per row so a Bot working in another channel
  // shows dots here without re-rendering the whole list on every event.
  const statusByBotId = operationsStore(useShallow((state) => {
    const values: Record<string, BotSidebarStatus> = {};
    for (const [botId, channelId] of Object.entries(ownerChannelIdByBotId)) {
      const runId = selectBotCurrentRunId(state, channelId);
      const status = resolveBotSidebarStatus(runId ? state.runsById[runId] ?? null : null);
      if (status) values[botId] = status;
    }
    return values;
  }));
  const isMobile = useUIStore((state) => state.isMobile);
  const orderedBotIds = React.useMemo(() => [...botIds].sort((leftId, rightId) => {
    const recency = (previewAtByBotId[rightId] ?? '').localeCompare(previewAtByBotId[leftId] ?? '');
    if (recency !== 0) return recency;
    return (botsById[leftId]?.name ?? leftId).localeCompare(botsById[rightId]?.name ?? rightId);
  }), [botIds, botsById, previewAtByBotId]);

  const selectBot = React.useCallback((botId: string) => {
    botsStore.getState().selectBot(botId);
    useMainSidebarAudienceStore.getState().setAudience('bots');
    if (!isMobile) useUIStore.getState().setRightSidebarOpen(true);
    onBotSelected?.(botId);

      void channelStore.getState().ensureOwnerChannel(botId).catch(() => undefined);

  }, [botsStore, channelStore, isMobile, onBotSelected]);

  return (
    <section
      className={standalone ? 'min-w-0' : 'mb-2 min-w-0 border-b border-border/50 pb-2'}
      aria-label={t('bots.sidebar.listAria')}
    >
      {orderedBotIds.length > 0 ? (
        <div className="space-y-0.5" role="list" aria-label={t('bots.sidebar.listAria')}>
          {orderedBotIds.map((botId) => {
            const bot = botsById[botId];
            if (!bot) return null;
            return (
              <div key={botId} role="listitem">
                <BotSidebarRow
                  bot={bot}
                  selected={selectedBotId === botId}
                  opening={openingByBotId[botId] === true}
                  channelId={ownerChannelIdByBotId[botId] ?? null}
                  channelStore={channelStore}
                  status={statusByBotId[botId] ?? null}
                  onSelect={selectBot}
                />
                {errorsByBotId[botId] ? (
                  <p className="pb-1 pl-[68px] pr-2 typography-micro text-[var(--status-error)]" role="alert">
                    {t('bots.sidebar.openFailed')}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : !catalogErrorCode ? (
        <p className="px-2 py-1 typography-micro text-muted-foreground" role={!catalogLoaded ? 'status' : undefined}>
          {accessDisabled
            ? t('bots.sidebar.accessDisabled')
            : !catalogLoaded
              ? t('bots.sidebar.loading')
              : t('bots.sidebar.empty')}
        </p>
      ) : null}
      {catalogErrorCode || connectionFailed ? (
        <div className="px-2 py-1 typography-micro text-muted-foreground">
          <p role={catalogErrorCode ? 'alert' : 'status'}>
            {catalogErrorCode ? t('bots.sidebar.loadFailed') : t('bots.sidebar.connectionFailed')}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={catalogLoading}
            onClick={retryBotsEventConnection}
          >
            {t('bots.operations.connection.retry')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
