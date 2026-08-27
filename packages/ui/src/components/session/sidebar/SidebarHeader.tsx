import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  RiSearchLine,
  RiChatNewLine,
  RiGitBranchLine,
  RiTimerLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { SidebarLeftCollapseIcon } from '@/components/icons/ToolbarIcons';
import { useI18n } from '@/lib/i18n';
import { ProductAudienceTabs } from '@/components/shared/ProductAudienceTabs';
import type { ProductAudience } from '@/stores/useMainSidebarAudienceStore';

type Props = {
  hideDirectoryControls: boolean;
  handleNewSession: () => void;
  onOpenMultiRun: () => void;
  onOpenScheduledTasks: () => void;
  showMultiRun?: boolean;
  headerActionIconClass: string;
  reserveHeaderActionsSpace: boolean;
  headerActionButtonClass: string;
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  showSidebarToggle?: boolean;
  onToggleSidebar?: () => void;
  hideSearchAction?: boolean;
  avoidWindowControlsOverlay?: boolean;
  reserveExternalDesktopChromeRow?: boolean;
  audience: ProductAudience;
  onAudienceChange: (audience: ProductAudience) => void;
};

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    hideDirectoryControls,
    handleNewSession,
    onOpenMultiRun,
    onOpenScheduledTasks,
    headerActionIconClass,
    reserveHeaderActionsSpace,
    headerActionButtonClass,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    showSidebarToggle = false,
    onToggleSidebar,
    hideSearchAction = false,
    avoidWindowControlsOverlay = false,
    reserveExternalDesktopChromeRow = false,
    showMultiRun = true,
    audience,
    onAudienceChange,
  } = props;

  const showCodingActions = audience === 'coding-agents' && !hideDirectoryControls;
  const showTopRow = showSidebarToggle || (showCodingActions && !hideSearchAction);
  const reserveExternalChromeOnly = reserveExternalDesktopChromeRow && !showTopRow;
  let rootSpacingClass = 'px-2.5 py-1';
  if (showSidebarToggle) {
    rootSpacingClass = avoidWindowControlsOverlay ? 'pl-[5.5rem] pr-3 pb-[11px]' : 'pl-3 pr-3 pb-[11px]';
  } else if (reserveExternalChromeOnly) {
    rootSpacingClass = audience === 'bots'
      ? 'px-2.5 pb-[7px] pt-[var(--oc-bot-chrome-height,48px)]'
      : 'px-2.5 pb-[7px] pt-[var(--oc-header-height,56px)]';
  }

  const actionsRow = showCodingActions ? (
    <div className="flex h-8 items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleNewSession}
            className={cn(headerActionButtonClass, 'h-8 min-w-0 flex-1 justify-start gap-2 px-2')}
            aria-label={t('sessions.sidebar.header.actions.newChat')}
          >
            <RiChatNewLine className={cn(headerActionIconClass, 'flex-shrink-0')} />
            <span className="truncate typography-ui-label font-medium">{t('sessions.sidebar.header.actions.newChat')}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.newChat')}</p></TooltipContent>
      </Tooltip>

      {showMultiRun ? <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpenMultiRun}
            className={cn(headerActionButtonClass, 'flex-shrink-0')}
            aria-label={t('sessions.sidebar.header.actions.newMultiRun')}
          >
            <RiGitBranchLine className={headerActionIconClass} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.newMultiRun')}</p></TooltipContent>
      </Tooltip> : null}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpenScheduledTasks}
            className={cn(headerActionButtonClass, 'flex-shrink-0')}
            aria-label={t('sessions.sidebar.header.actions.scheduledTasks')}
          >
            <RiTimerLine className={headerActionIconClass} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.scheduledTasks')}</p></TooltipContent>
      </Tooltip>
    </div>
  ) : null;

  return (
    <div
      className={cn(
        'select-none flex-shrink-0',
        rootSpacingClass,
      )}
      style={showSidebarToggle && avoidWindowControlsOverlay ? { paddingTop: 'var(--oc-safe-area-top, 0px)' } : undefined}
    >
      {reserveHeaderActionsSpace ? (
        <div
          className={cn(
            'flex h-auto flex-col',
            showTopRow ? 'gap-2' : 'gap-1',
            showSidebarToggle
              ? avoidWindowControlsOverlay
                ? 'min-h-[calc(var(--oc-header-height,56px)-var(--oc-safe-area-top,0px))] justify-center'
                : 'min-h-[var(--oc-header-height,56px)] justify-center'
              : 'min-h-8',
          )}
        >
          {showTopRow ? (
            <div className={cn('flex items-center gap-1.5', showSidebarToggle ? 'h-[48px]' : 'h-8')}>
              {showSidebarToggle && onToggleSidebar ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onToggleSidebar}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md typography-ui-label font-medium text-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50"
                      aria-label={t('sessions.sidebar.header.actions.closeSessions')}
                    >
                      <SidebarLeftCollapseIcon className="h-[18px] w-[18px]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.closeSessions')}</p></TooltipContent>
                </Tooltip>
              ) : null}
              {!showCodingActions || hideSearchAction ? null : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setIsSessionSearchOpen(true)}
                      className={headerActionButtonClass}
                      aria-label={t('sessions.sidebar.header.actions.searchSessions')}
                      aria-expanded={isSessionSearchOpen}
                    >
                      <RiSearchLine className={headerActionIconClass} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.searchSessions')}</p></TooltipContent>
                </Tooltip>
              )}
            </div>
          ) : null}
          <ProductAudienceTabs
            audience={audience}
            onAudienceChange={onAudienceChange}
            idPrefix="main-sidebar-audience"
            panelId="main-sidebar-audience-panel"
            variant="sidebar"
          />
          {actionsRow}
        </div>
      ) : (
        <ProductAudienceTabs
          audience={audience}
          onAudienceChange={onAudienceChange}
          idPrefix="main-sidebar-audience"
          panelId="main-sidebar-audience-panel"
          variant="sidebar"
        />
      )}
    </div>
  );
}
