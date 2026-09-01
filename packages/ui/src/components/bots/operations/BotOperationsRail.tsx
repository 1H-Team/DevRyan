import React from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { RiComputerLine, RiFolderSharedLine, RiRefreshLine, RiShieldCheckLine } from '@remixicon/react';

import { retryBotsEventConnection } from '@/apps/botEventConnection';
import { Button } from '@/components/ui/button';
import { useAuthPrincipal } from '@/lib/authSession';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useBotChannelStore, type BotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsStore, type BotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotOperationsNavigationStore } from '@/stores/useBotOperationsNavigationStore';
import { useBotsStore, type BotsStore } from '@/stores/useBotsStore';
import { BotApprovalsTab } from './BotApprovalsTab';
import { BotArtifactsTab } from './BotArtifactsTab';
import { useBotComputerActivityStore } from '@/stores/useBotComputerActivityStore';
import { BotCurrentRun } from './BotCurrentRun';

type OperationsTab = 'computer' | 'approvals' | 'shared';
const isOperationsTab = (value: string | number): value is OperationsTab => (
  value === 'computer' || value === 'approvals' || value === 'shared'
);

const connectionLabelKey = {
  idle: 'bots.operations.connection.idle',
  connecting: 'bots.operations.connection.connecting',
  connected: 'bots.operations.connection.connected',
  reconnecting: 'bots.operations.connection.reconnecting',
  unsupported: 'bots.operations.connection.unsupported',
  error: 'bots.operations.connection.error',
} as const;

const sanitizedConnectionCode = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120);
  return normalized || null;
};

const tabClassName = cn(
  'inline-flex h-8 min-w-8 flex-1 items-center justify-center gap-1 rounded-md border border-transparent px-1.5 typography-micro text-muted-foreground',
  'transition-[background-color,border-color,color,box-shadow] hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
  'data-[selected]:border-border data-[selected]:bg-interactive-selection data-[selected]:font-semibold data-[selected]:text-interactive-selection-foreground data-[selected]:shadow-sm',
);

type BotOperationsRailProps = {
  botId: string;
  channelId: string | null;
  channelStore?: BotChannelStore;
  operationsStore?: BotOperationsStore;
  botsStore?: BotsStore;
};

export const BotOperationsRail: React.FC<BotOperationsRailProps> = ({
  botId,
  channelId,
  channelStore = useBotChannelStore,
  operationsStore = useBotOperationsStore,
  botsStore = useBotsStore,
}) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const [activeTab, setActiveTab] = React.useState<OperationsTab>(() => {
    const navigation = useBotOperationsNavigationStore.getState();
    return navigation.botId === botId && navigation.tab === 'approvals' ? 'approvals' : 'computer';
  });
  const navigationTab = useBotOperationsNavigationStore((state) => (
    state.botId === botId ? state.tab : null
  ));
  const channel = channelStore((state) => channelId ? state.channelsById[channelId] : undefined);
  const membership = botsStore((state) => state.membershipsByBotId[botId]);
  const connectionState = operationsStore((state) => state.connectionState);
  const connectionErrorCode = operationsStore((state) => state.connectionErrorCode);
  const pendingCount = operationsStore((state) => state.pendingApprovalIds.filter((actionId) => (
    state.actionsById[actionId]?.botId === botId
  )).length);
  const canOperate = membership !== undefined;
  React.useEffect(() => {
    if (navigationTab === 'approvals') setActiveTab('approvals');
  }, [navigationTab]);

  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-sidebar" data-bot-operations-rail>
      <div className="border-b border-border/50">
        <div className="flex h-9 items-center gap-2 px-3">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              connectionState === 'connected' ? 'bg-[var(--status-success)]' : 'bg-[var(--status-warning)]',
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">{t('bots.operations.title')}</span>
          <span className="typography-micro text-muted-foreground">{t(connectionLabelKey[connectionState])}</span>
        </div>
        {connectionState !== 'connected' && sanitizedConnectionCode(connectionErrorCode) ? (
          <div className="flex items-center gap-2 px-3 pb-2">
            <code className="min-w-0 flex-1 truncate typography-micro text-[var(--status-warning)]">
              {sanitizedConnectionCode(connectionErrorCode)}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={retryBotsEventConnection}
            >
              <RiRefreshLine /> {t('bots.operations.connection.retry')}
            </Button>
          </div>
        ) : null}
      </div>

      {!channelId || !channel ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center typography-meta text-muted-foreground">
          {t('bots.operations.openingChannel')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <BotCurrentRun
            channelId={channel.id}
            canCancel={channel.canSend && channel.accessRole !== 'reader'}
            operationsStore={operationsStore}
          />
          <Tabs.Root
            value={activeTab}
            onValueChange={(value) => {
              if (!isOperationsTab(value)) return;
              setActiveTab(value);
              if (value === 'approvals') {
                useBotOperationsNavigationStore.getState().selectTab(botId, value);
              }
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Tabs.List className="flex h-10 items-center gap-0.5 border-b border-border/50 px-2" aria-label={t('bots.operations.tabsAria')}>
              <Tabs.Tab className={tabClassName} value="computer" aria-label={t('bots.operations.tab.computer')}>
                <RiComputerLine className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden @min-[420px]:inline">{t('bots.operations.tab.computerShort')}</span>
              </Tabs.Tab>
              <Tabs.Tab className={tabClassName} value="approvals" aria-label={t('bots.operations.tab.approvals')}>
                <RiShieldCheckLine className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden @min-[420px]:inline">{t('bots.operations.tab.approvals')}</span>
                {pendingCount > 0 ? (
                  <span
                    className="text-[var(--status-warning)]"
                    aria-label={t('bots.operations.approvals.pendingCount', { count: pendingCount })}
                  >
                    {pendingCount}
                  </span>
                ) : null}
              </Tabs.Tab>
              <Tabs.Tab className={tabClassName} value="shared" aria-label={t('bots.operations.tab.shared')}>
                <RiFolderSharedLine className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden @min-[420px]:inline">{t('bots.operations.tab.shared')}</span>
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="computer" className="min-h-0 flex-1 overflow-hidden [[hidden]]:hidden">
              <div className="space-y-3 p-4 typography-meta text-muted-foreground">
                <p>The shared Bot computer appears in the conversation when the Bot uses it. Members share its files and saved logins.</p>
                <Button variant="outline" size="sm" onClick={() => useBotComputerActivityStore.getState().show(botId, channel.id)}>
                  <RiComputerLine /> Open in Conversation
                </Button>
              </div>
            </Tabs.Panel>
            <Tabs.Panel value="approvals" className="min-h-0 flex-1 overflow-y-auto [[hidden]]:hidden">
              <BotApprovalsTab
                botId={botId}
                active={activeTab === 'approvals'}
                canOperate={canOperate}
                principalId={principal.id}
                operationsStore={operationsStore}
              />
            </Tabs.Panel>
            <Tabs.Panel value="shared" className="min-h-0 flex-1 overflow-y-auto [[hidden]]:hidden">
              <BotArtifactsTab
                botId={botId}
                channelId={channel.id}
                onOpenComputer={() => {
                  setActiveTab('computer');
                  if (channel) useBotComputerActivityStore.getState().show(botId, channel.id);
                }}
              />
            </Tabs.Panel>
          </Tabs.Root>
        </div>
      )}
    </div>
  );
};
