import React, { useCallback, useMemo } from 'react';
import {
  RiAddLine,
  RiArrowGoBackLine,
  RiLoader4Line,
  RiSubtractLine,
} from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import type { GitStatus } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ChangeDescriptor = {
  code: string;
  color: string;
  description: string;
};

const CHANGE_DESCRIPTORS: Record<string, ChangeDescriptor> = {
  '?': { code: '?', color: 'var(--status-info)', description: 'Untracked file' },
  A: { code: 'A', color: 'var(--status-success)', description: 'New file' },
  D: { code: 'D', color: 'var(--status-error)', description: 'Deleted file' },
  R: { code: 'R', color: 'var(--status-info)', description: 'Renamed file' },
  C: { code: 'C', color: 'var(--status-info)', description: 'Copied file' },
  M: { code: 'M', color: 'var(--status-warning)', description: 'Modified file' },
};

const DEFAULT_DESCRIPTOR = CHANGE_DESCRIPTORS.M;

function getChangeSymbol(file: GitStatus['files'][number]): string {
  const indexCode = file.index?.trim();
  const workingCode = file.working_dir?.trim();

  if (indexCode && indexCode !== '?') return indexCode.charAt(0);
  if (workingCode) return workingCode.charAt(0);

  return indexCode?.charAt(0) || workingCode?.charAt(0) || 'M';
}

function describeChange(file: GitStatus['files'][number]): ChangeDescriptor {
  const symbol = getChangeSymbol(file);
  return CHANGE_DESCRIPTORS[symbol] ?? DEFAULT_DESCRIPTOR;
}

interface ChangeRowProps {
  file: GitStatus['files'][number];
  onViewDiff: () => void;
  onRevert: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  isReverting: boolean;
  isStaging?: boolean;
  stats?: { insertions: number; deletions: number };
  rowPaddingClassName?: string;
  indentPx?: number;
}

export const ChangeRow = React.memo<ChangeRowProps>(function ChangeRow({
  file,
  onViewDiff,
  onRevert,
  onStage,
  onUnstage,
  isReverting,
  isStaging = false,
  stats,
  rowPaddingClassName,
  indentPx = 0,
}) {
  const descriptor = useMemo(() => describeChange(file), [file]);
  const { t } = useI18n();
  const indicatorLabel = descriptor.description;
  const insertions = stats?.insertions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const fileName = useMemo(() => {
    const lastSlash = file.path.lastIndexOf('/');
    return lastSlash === -1 ? file.path : file.path.slice(lastSlash + 1);
  }, [file.path]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onViewDiff();
      }
    },
    [onViewDiff]
  );

  const handleRevertClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onRevert();
    },
    [onRevert]
  );
  const handleStageClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onStage?.();
    },
    [onStage]
  );
  const handleUnstageClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnstage?.();
    },
    [onUnstage]
  );
  const stageAction = onUnstage
    ? {
        onClick: handleUnstageClick,
        label: t('gitView.changes.unstageFileAria', { path: file.path }),
        tooltip: t('gitView.changes.unstageFileTooltip'),
        icon: <RiSubtractLine className="size-3.5" />,
      }
    : onStage
      ? {
          onClick: handleStageClick,
          label: t('gitView.changes.stageFileAria', { path: file.path }),
          tooltip: t('gitView.changes.stageFileTooltip'),
          icon: <RiAddLine className="size-3.5" />,
        }
      : null;

  return (
    <div
      className={`group flex items-center gap-1.5 py-0.5 hover:bg-sidebar/40 cursor-pointer ${rowPaddingClassName ?? 'px-3'}`}
      role="button"
      tabIndex={0}
      onClick={onViewDiff}
      onKeyDown={handleKeyDown}
      style={indentPx > 0 ? { paddingLeft: `${indentPx}px` } : undefined}
    >
        <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={file.path}>
          {fileName}
        </span>
        <span
          className={cn(
            'shrink-0 typography-micro opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100',
            isReverting && 'opacity-100'
          )}
        >
          <span style={{ color: 'var(--status-success)' }}>+{insertions}</span>
          <span className="text-muted-foreground mx-0.5">/</span>
          <span style={{ color: 'var(--status-error)' }}>-{deletions}</span>
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleRevertClick}
              disabled={isReverting}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:opacity-50',
                isReverting && 'opacity-100'
              )}
              aria-label={t('gitView.changes.revertFileAria', { path: file.path })}
            >
              {isReverting ? (
                <RiLoader4Line className="size-3.5 animate-spin" />
              ) : (
                <RiArrowGoBackLine className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent sideOffset={8}>{t('gitView.changes.revertFileTooltip')}</TooltipContent>
        </Tooltip>
        {stageAction ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={stageAction.onClick}
                disabled={isStaging}
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:opacity-50',
                  isStaging && 'opacity-100'
                )}
                aria-label={stageAction.label}
              >
                {isStaging ? (
                  <RiLoader4Line className="size-3.5 animate-spin" />
                ) : (
                  stageAction.icon
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={8}>{stageAction.tooltip}</TooltipContent>
          </Tooltip>
        ) : null}
        <span
          className="ml-auto w-4 shrink-0 text-right typography-micro font-semibold uppercase"
          style={{ color: descriptor.color }}
          title={indicatorLabel}
          aria-label={indicatorLabel}
        >
          {descriptor.code}
        </span>
    </div>
  );
});
