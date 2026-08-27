import React from 'react';
import { RiRobot2Line } from '@remixicon/react';
import { useShallow } from 'zustand/react/shallow';

import { BotSidebarRow } from './BotSidebarRow';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { useBotChannelStore, type BotChannelStore } from '@/stores/useBotChannelStore';
import { useBotsStore, type BotsStore } from '@/stores/useBotsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMainSidebarAudienceStore } from '@/stores/useMainSidebarAudienceStore';

export const VSCODE_UNSUPPORTED_BOT_ID = 'vscode-unsupported';

type BotSidebarSectionProps = {
  onBotSelected?: (botId: string) => void;
  vscodeRuntime?: boolean;
  botsStore?: BotsStore;
  channelStore?: BotChannelStore;
  standalone?: boolean;
};

export const BotSidebarSection: React.FC<BotSidebarSectionProps> = ({
  onBotSelected,
  vscodeRuntime = isVSCodeRuntime(),
  botsStore = useBotsStore,
  channelStore = useBotChannelStore,
  standalone = false,
}) => {
  const { t } = useI18n();
  const botIds = botsStore((state) => state.botIds);
  const botsById = botsStore((state) => state.botsById);
  const selectedBotId = botsStore((state) => state.selectedBotId);
  const principalId = botsStore((state) => state.principalId);
  const capabilities = botsStore((state) => state.capabilities);
  const capabilitiesLoading = botsStore((state) => state.capabilitiesLoading);
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

    if (!vscodeRuntime) {
      void channelStore.getState().ensureOwnerChannel(botId).catch(() => undefined);
    }
  }, [botsStore, channelStore, isMobile, onBotSelected, vscodeRuntime]);

  const openUnsupported = React.useCallback(() => {
    botsStore.getState().selectBot(VSCODE_UNSUPPORTED_BOT_ID);
    useMainSidebarAudienceStore.getState().setAudience('bots');
    onBotSelected?.(VSCODE_UNSUPPORTED_BOT_ID);
  }, [botsStore, onBotSelected]);

  return (
    <section
      className={standalone ? 'min-w-0' : 'mb-2 min-w-0 border-b border-border/50 pb-2'}
      aria-label={t('bots.sidebar.listAria')}
    >
      {vscodeRuntime ? (
        <button
          type="button"
          aria-current={selectedBotId === VSCODE_UNSUPPORTED_BOT_ID ? 'page' : undefined}
          onClick={openUnsupported}
          className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left text-foreground transition-colors hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] border border-border/60 bg-[var(--surface-elevated)] text-muted-foreground">
            <RiRobot2Line className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block typography-ui-label font-medium">{t('bots.sidebar.title')}</span>
            <span className="block truncate typography-micro text-muted-foreground">{t('bots.sidebar.desktopRequiredShort')}</span>
          </span>
        </button>
      ) : orderedBotIds.length > 0 ? (
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
      ) : (
        <p className="px-2 py-1 typography-micro text-muted-foreground" role={capabilitiesLoading ? 'status' : undefined}>
          {capabilitiesLoading || capabilities === null
            ? t('bots.sidebar.loading')
            : t('bots.sidebar.empty')}
        </p>
      )}
    </section>
  );
};
