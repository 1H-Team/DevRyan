import React from 'react';
import {
  RiArrowDownLine,
  RiDownloadLine,
  RiLoader4Line,
  RiLoopRightLine,
  RiRefreshLine,
  RiUploadLine,
} from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { GitRemote } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;

const COMPACT_ACTION_BUTTON_CLASS_NAME = cn(
  'inline-flex h-6 w-6 items-center justify-center rounded bg-transparent text-muted-foreground',
  'transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50'
);

interface SyncChangesButtonProps {
  syncAction: SyncAction;
  remotes: GitRemote[];
  onSync: (remote: GitRemote) => void;
  disabled: boolean;
  aheadCount?: number;
  behindCount?: number;
  trackingRemoteName?: string;
  hasUncommittedChanges?: boolean;
  className?: string;
  iconClassName?: string;
}

interface SyncActionsProps {
  syncAction: SyncAction;
  remotes: GitRemote[];
  onFetch: (remote: GitRemote) => void;
  onPull?: (remote: GitRemote) => void;
  onPush?: () => void;
  onRefresh?: () => void;
  disabled: boolean;
  remoteActionsDisabled?: boolean;
  iconOnly?: boolean;
  isRefreshing?: boolean;
  aheadCount?: number;
  behindCount?: number;
  trackingRemoteName?: string;
  hasUncommittedChanges?: boolean;
}

export const SyncChangesButton: React.FC<SyncChangesButtonProps> = ({
  syncAction,
  remotes = [],
  onSync,
  disabled,
  aheadCount = 0,
  behindCount = 0,
  trackingRemoteName,
  hasUncommittedChanges = false,
  className,
  iconClassName = 'size-3.5',
}) => {
  const { t } = useI18n();
  const trackingRemote = remotes.find((remote) => remote.name === trackingRemoteName) ?? remotes[0];
  const blocksRebaseSync = behindCount > 0 && hasUncommittedChanges;
  const hasKnownSyncWork = aheadCount > 0 || behindCount > 0;
  const isDisabled = disabled || syncAction !== null || !trackingRemote || blocksRebaseSync;
  const tooltipLabel = blocksRebaseSync
    ? t('gitView.sync.commitOrStashTooltip')
    : trackingRemote
    ? hasKnownSyncWork
      ? t('gitView.sync.syncChangesTooltip', { ahead: aheadCount, behind: behindCount })
      : t('gitView.sync.syncChanges')
    : t('gitView.sync.noRemoteTooltip');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            if (trackingRemote) {
              onSync(trackingRemote);
            }
          }}
          disabled={isDisabled}
          className={cn(COMPACT_ACTION_BUTTON_CLASS_NAME, className)}
          aria-label={t('gitView.sync.syncChanges')}
          title={t('gitView.sync.syncChanges')}
        >
          {syncAction === 'sync' ? (
            <RiLoader4Line className={cn(iconClassName, 'animate-spin')} />
          ) : (
            <RiLoopRightLine className={iconClassName} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
};

export const SyncActions: React.FC<SyncActionsProps> = ({
  syncAction,
  remotes = [],
  onFetch,
  onPull,
  onPush,
  onRefresh,
  disabled,
  remoteActionsDisabled = false,
  isRefreshing = false,
  aheadCount = 0,
  behindCount = 0,
  trackingRemoteName,
}) => {
  const { t } = useI18n();
  const trackingRemote = remotes.find((remote) => remote.name === trackingRemoteName) ?? remotes[0];
  const isBusy = syncAction !== null;
  const isRemoteActionDisabled = disabled || remoteActionsDisabled || isBusy || !trackingRemote;
  const isPullDisabled = isRemoteActionDisabled || behindCount <= 0;
  const isPushDisabled = disabled || remoteActionsDisabled || isBusy || aheadCount <= 0;
  const isRefreshDisabled = disabled || isBusy || isRefreshing;

  const handleRemoteAction = (action: (remote: GitRemote) => void) => {
    if (!trackingRemote) {
      return;
    }
    action(trackingRemote);
  };

  const renderActionButton = ({
    label,
    tooltip,
    disabled: actionDisabled,
    onClick,
    icon,
  }: {
    label: string;
    tooltip: string;
    disabled: boolean;
    onClick: () => void;
    icon: React.ReactNode;
  }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={actionDisabled}
          className={COMPACT_ACTION_BUTTON_CLASS_NAME}
          aria-label={label}
          title={label}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{tooltip}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="inline-flex items-center gap-1 bg-transparent">
      {renderActionButton({
        label: trackingRemote ? t('gitView.sync.fetchFromRemote', { name: trackingRemote.name }) : t('gitView.sync.fetch'),
        tooltip: trackingRemote ? t('gitView.sync.fetchFromRemote', { name: trackingRemote.name }) : t('gitView.sync.noRemoteTooltip'),
        disabled: isRemoteActionDisabled,
        onClick: () => handleRemoteAction(onFetch),
        icon: syncAction === 'fetch'
          ? <RiLoader4Line className="size-3.5 animate-spin" />
          : <RiDownloadLine className="size-3.5" />,
      })}
      {renderActionButton({
        label: t('gitView.sync.pull'),
        tooltip: behindCount > 0 ? t('gitView.sync.pullTooltipBehind', { count: behindCount }) : t('gitView.sync.pullTooltip'),
        disabled: isPullDisabled || !onPull,
        onClick: () => { if (onPull) handleRemoteAction(onPull); },
        icon: syncAction === 'pull'
          ? <RiLoader4Line className="size-3.5 animate-spin" />
          : <RiArrowDownLine className="size-3.5" />,
      })}
      {renderActionButton({
        label: t('gitView.sync.push'),
        tooltip: aheadCount > 0 ? t('gitView.sync.pushTooltipAhead', { count: aheadCount }) : t('gitView.sync.pushTooltip'),
        disabled: isPushDisabled || !onPush,
        onClick: () => { onPush?.(); },
        icon: syncAction === 'push'
          ? <RiLoader4Line className="size-3.5 animate-spin" />
          : <RiUploadLine className="size-3.5" />,
      })}
      {renderActionButton({
        label: t('gitView.sync.refresh'),
        tooltip: t('gitView.sync.refresh'),
        disabled: isRefreshDisabled || !onRefresh,
        onClick: () => { onRefresh?.(); },
        icon: isRefreshing
          ? <RiLoader4Line className="size-3.5 animate-spin" />
          : <RiRefreshLine className="size-3.5" />,
      })}
    </div>
  );
};
