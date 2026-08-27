import React from 'react';
import { RiFolder3Line, RiGitBranchLine } from '@remixicon/react';

import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { LazyGitView, LazyViewBoundary } from '@/components/views/lazyViews';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { SidebarFilesTree } from './SidebarFilesTree';
import { hasAuthCapability, useAuthPrincipal } from '@/lib/authSession';
import { BotOperationsRail } from '@/components/bots/operations/BotOperationsRail';
import { botChannelSelectors, useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotsStore } from '@/stores/useBotsStore';
import { useMainSidebarAudienceStore } from '@/stores/useMainSidebarAudienceStore';

type RightTab = 'git' | 'files';

/**
 * Keeps git status fresh while the right sidebar is open.
 * Replaces the GitPollingProvider removed in commit b2d5ccb4.
 * The previous polling ran globally; now we only refresh when the sidebar is open.
 */
function useRightSidebarGitSync(directory: string | undefined, isSidebarOpen: boolean) {
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const pollStatusAndRefreshRepository = useGitStore((state) => state.pollStatusAndRefreshRepository);

  React.useEffect(() => {
    if (!directory || !git || !isSidebarOpen) return;

    void ensureStatus(directory, git);

    const POLL_INTERVAL = 10_000;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void pollStatusAndRefreshRepository(directory, git);
    }, POLL_INTERVAL);

    return () => clearInterval(id);
  }, [directory, git, isSidebarOpen, ensureStatus, pollStatusAndRefreshRepository]);
}

export const RightSidebarTabs: React.FC = () => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const canUseFiles = hasAuthCapability(principal, 'files');
  const canUseBots = hasAuthCapability(principal, 'bots');
  const canUseGit = hasAuthCapability(principal, 'manageGit');
  const rightSidebarTab = useUIStore((state) => state.rightSidebarTab);
  const setRightSidebarTab = useUIStore((state) => state.setRightSidebarTab);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const directory = useEffectiveDirectory();
  const requestedBotMode = useMainSidebarAudienceStore((state) => state.audience === 'bots');
  const botMode = canUseBots && requestedBotMode;
  const selectedBotId = useBotsStore((state) => state.selectedBotId);
  const botPrincipalId = useBotsStore((state) => state.principalId);
  const botChannelId = useBotChannelStore(
    botChannelSelectors.ownerChannelId(selectedBotId ?? '', botPrincipalId),
  );

  useRightSidebarGitSync(directory, isRightSidebarOpen && canUseGit && !botMode);

  React.useEffect(() => {
    if (rightSidebarTab === 'files' && !canUseFiles && canUseGit) {
      setRightSidebarTab('git');
    }
  }, [canUseFiles, canUseGit, rightSidebarTab, setRightSidebarTab]);

  const tabItems = React.useMemo(() => [
    ...(canUseGit ? [{
      id: 'git',
      label: t('layout.rightSidebar.git'),
      icon: <RiGitBranchLine className="h-3.5 w-3.5" />,
    }] : []),
    ...(canUseFiles ? [{
      id: 'files',
      label: t('layout.rightSidebar.files'),
      icon: <RiFolder3Line className="h-3.5 w-3.5" />,
    }] : []),
  ], [canUseFiles, canUseGit, t]);

  // The desktop container animates to zero width, but hidden heavy children
  // must be unmounted. GitView owns substantial DOM and directory-bound
  // effects that should exist only while the panel is actually visible.
  if (!isRightSidebarOpen) {
    return null;
  }

  if (botMode && selectedBotId) {
    return <BotOperationsRail botId={selectedBotId} channelId={botChannelId} />;
  }

  if (botMode) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-sidebar" data-bot-operations-rail>
        <div className="flex h-10 items-center border-b border-border/50 px-3 typography-ui-label font-medium text-foreground">
          {t('bots.operations.title')}
        </div>
        <div className="flex flex-1 items-center justify-center px-5 text-center typography-meta text-muted-foreground">
          {t('bots.sidebar.selectPrompt.description')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar">
      <div className="h-9 bg-sidebar pt-1 px-2">
        <SortableTabsStrip
          items={tabItems}
          activeId={rightSidebarTab}
          onSelect={(tabID) => setRightSidebarTab(tabID as RightTab)}
          layoutMode="fit"
          variant="active-pill"
          activePillLowercase={false}
          className="h-full"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {canUseGit && rightSidebarTab === 'git' && (
          <LazyViewBoundary>
            <LazyGitView />
          </LazyViewBoundary>
        )}
        {canUseFiles && rightSidebarTab === 'files' && <SidebarFilesTree />}
      </div>
    </div>
  );
};
