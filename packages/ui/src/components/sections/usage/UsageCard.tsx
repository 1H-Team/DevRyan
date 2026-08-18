import React from 'react';
import type { UsageWindow } from '@/types';
import { buildQuotaWindowDisplayState, formatWindowLabel, hasUsageProgress, type UsageTrendHistory } from '@/lib/quota';
import { UsageProgressBar } from './UsageProgressBar';
import { PaceIndicator } from './PaceIndicator';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { Checkbox } from '@/components/ui/checkbox';

interface UsageCardProps {
  title: string;
  displayTitle?: string;
  window: UsageWindow;
  subtitle?: string | null;
  description?: string | null;
  showToggle?: boolean;
  toggleEnabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  trendHistory?: UsageTrendHistory;
  trendKey?: string;
}

export const UsageCard: React.FC<UsageCardProps> = ({
  title,
  displayTitle,
  window,
  subtitle,
  description = window.description ?? null,
  showToggle = false,
  toggleEnabled = false,
  onToggle,
  trendHistory,
  trendKey,
}) => {
  const displayMode = useQuotaStore((state) => state.displayMode);
  const showPredictionValues = useQuotaStore((state) => state.showPredictionValues);
  const windowLabel = formatWindowLabel(title);
  const visibleTitle = displayTitle ?? windowLabel;
  const showProgress = hasUsageProgress(window);

  const displayState = React.useMemo(() => buildQuotaWindowDisplayState(
    window,
    title,
    displayMode,
    trendHistory,
    trendKey,
  ), [displayMode, title, trendHistory, trendKey, window]);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {showToggle && (
            <Checkbox
              checked={toggleEnabled}
              onChange={(checked) => onToggle?.(checked)}
              ariaLabel="Show in Dropdown"
            />
          )}
          <div className="min-w-0 flex flex-col">
            <span className="typography-ui-label text-foreground truncate">{visibleTitle}</span>
            {subtitle && (
              <span className="typography-meta text-muted-foreground truncate">{subtitle}</span>
            )}
            {description && (
              <span className="typography-meta text-muted-foreground">{description}</span>
            )}
          </div>
        </div>
        <div className="typography-ui-label text-foreground tabular-nums flex items-center justify-end">
          {displayState.metricLabel === '-' ? '' : displayState.metricLabel}
        </div>
      </div>

      {showProgress ? (
        <div className="mt-2.5">
          <UsageProgressBar
            percent={displayState.displayPercent}
            tonePercent={window.usedPercent}
            expectedMarkerPercent={displayState.expectedMarkerPercent}
            className="h-1.5"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="typography-micro text-muted-foreground">
              {displayState.resetLabel ? `Resets ${displayState.resetLabel}` : ''}
            </span>
            <span className="typography-micro text-muted-foreground">
              {displayState.barLabel}
            </span>
          </div>
        </div>
      ) : displayState.resetLabel ? (
        <div className="mt-1 typography-micro text-muted-foreground">
          {`Resets ${displayState.resetLabel}`}
        </div>
      ) : null}

      {showProgress && showPredictionValues && displayState.paceInfo && (
        <div className="mt-1.5">
          <PaceIndicator paceInfo={displayState.paceInfo} displayMode={displayMode} />
        </div>
      )}
    </div>
  );
};
