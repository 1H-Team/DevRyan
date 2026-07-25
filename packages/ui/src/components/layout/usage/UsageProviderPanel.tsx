import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiRefreshLine } from '@remixicon/react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { cn } from '@/lib/utils';
import { buildQuotaTrendKey, buildQuotaWindowDisplayState, formatWindowLabel, type UsageTrendHistory } from '@/lib/quota';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { PaceIndicator } from '@/components/sections/usage/PaceIndicator';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import { getVisibleUsageEntries } from './usage-groups';
import { UsageResetCreditsList } from './UsageResetCreditsList';
import type { RateLimitGroup } from './types';
import type { UsageWindow } from '@/types';

interface UsageProviderPanelProps {
  group: RateLimitGroup | null;
  quotaTrendHistory: UsageTrendHistory;
  handleUsageRefresh: () => void;
  isQuotaLoading: boolean;
  isUsageRefreshSpinning: boolean;
  expandedFamilies: Record<string, string[]>;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  formatUpdatedTime: (timestamp: number | null) => string;
  mobile?: boolean;
}

const UsageMetricRow = React.memo(function UsageMetricRow({
  providerId,
  scope,
  scopeId,
  label,
  window,
  displayLabel,
  quotaTrendHistory,
  mutedTitle = false,
}: {
  providerId: string;
  scope: 'window' | 'model';
  scopeId: string | null;
  label: string;
  window: UsageWindow;
  displayLabel: string;
  quotaTrendHistory: UsageTrendHistory;
  mutedTitle?: boolean;
}) {
  const displayState = buildQuotaWindowDisplayState(
    window,
    label,
    'usage',
    quotaTrendHistory,
    buildQuotaTrendKey(providerId, scope, scopeId, label),
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <span className={cn('truncate', mutedTitle ? 'typography-micro text-muted-foreground' : 'typography-ui-label text-foreground')}>
            {displayLabel}
          </span>
          {window.resetAfterFormatted ?? window.resetAtFormatted ? (
            <span className="truncate typography-micro text-muted-foreground">
              {window.resetAfterFormatted ?? window.resetAtFormatted}
            </span>
          ) : null}
        </div>
        <span className="typography-ui-label tabular-nums text-foreground">
          {displayState.metricLabel === '-' ? '' : displayState.metricLabel}
        </span>
      </div>
      <UsageProgressBar
        percent={displayState.displayPercent}
        tonePercent={window.usedPercent}
        className="h-1.5"
        expectedMarkerPercent={displayState.expectedMarkerPercent}
      />
      {displayState.paceInfo ? <PaceIndicator paceInfo={displayState.paceInfo} compact displayMode="usage" /> : null}
    </div>
  );
});

export const UsageProviderPanel = React.memo(function UsageProviderPanel({
  group,
  quotaTrendHistory,
  handleUsageRefresh,
  isQuotaLoading,
  isUsageRefreshSpinning,
  expandedFamilies,
  toggleFamilyExpanded,
  formatUpdatedTime,
  mobile = false,
}: UsageProviderPanelProps) {
  const { t } = useI18n();

  const entries = group ? getVisibleUsageEntries(group) : [];
  const providerExpandedFamilies = group ? (expandedFamilies[group.providerId] ?? []) : [];
  const hasRows = Boolean(group) && (
    entries.length > 0
    || Boolean(group?.resetCredits)
    || Boolean(group?.modelRows?.length)
    || Boolean(group?.modelFamilies?.length)
  );

  return (
    <div className="overflow-x-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--interactive-border)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {group ? <ProviderLogo providerId={group.providerId} className="h-4 w-4 shrink-0" /> : null}
          <div className="min-w-0">
            <div className="truncate typography-ui-header font-semibold text-foreground">
              {group ? group.providerName : t('header.services.rateLimits')}
            </div>
            <div className="truncate typography-micro text-muted-foreground" aria-live="polite">
              {t('header.services.updatedAt', { time: formatUpdatedTime(group?.usageUpdatedAt ?? null) })}
            </div>
          </div>
        </div>
        <button
          type="button"
          className={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'hover:text-foreground hover:bg-interactive-hover',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
          )}
          onClick={handleUsageRefresh}
          disabled={isQuotaLoading || isUsageRefreshSpinning}
          aria-label={t('header.services.refreshRateLimitsAria')}
        >
          <RiRefreshLine className={cn('h-4 w-4', isUsageRefreshSpinning && 'animate-spin')} />
        </button>
      </div>

      {!hasRows ? (
        <div className="px-4 py-5 text-center">
          <span className="typography-ui-label text-muted-foreground">
            {group?.error ?? (group ? t('header.services.noRateLimitsReported') : t('header.services.noRateLimits'))}
          </span>
        </div>
      ) : group ? (
        <div className={cn('space-y-3 pb-3 pt-3', mobile ? 'px-4' : 'px-4')}>
          {group.error ? (
            <div className="rounded-md border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-2.5 py-2 typography-micro text-[var(--status-warning)]">
              {group.error}
            </div>
          ) : null}
          {entries.map(([label, window]) => (
            <UsageMetricRow
              key={`${group.providerId}-${label}`}
              providerId={group.providerId}
              scope="window"
              scopeId={null}
              label={label}
              window={window}
              displayLabel={formatWindowLabel(label)}
              quotaTrendHistory={quotaTrendHistory}
            />
          ))}

          {group.modelRows && group.modelRows.length > 0 ? (
            <div className="space-y-2.5">
              {group.modelRows.map(({ modelName, label, window, displayLabel }) => (
                <UsageMetricRow
                  key={`${group.providerId}-${modelName}`}
                  providerId={group.providerId}
                  scope="model"
                  scopeId={modelName}
                  label={label}
                  window={window}
                  displayLabel={displayLabel}
                  quotaTrendHistory={quotaTrendHistory}
                  mutedTitle
                />
              ))}
            </div>
          ) : null}

          {group.modelFamilies && group.modelFamilies.length > 0 ? (
            <div className="space-y-0.5">
              {group.modelFamilies.map((family) => {
                const familyKey = family.familyId ?? 'other';
                const isExpanded = providerExpandedFamilies.includes(familyKey);
                return (
                  <Collapsible
                    key={familyKey}
                    open={isExpanded}
                    onOpenChange={() => toggleFamilyExpanded(group.providerId, familyKey)}
                  >
                    <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left hover:bg-[var(--interactive-hover)]/50 transition-colors">
                      <span className="typography-ui-label font-medium text-foreground">{family.familyLabel}</span>
                      {isExpanded ? <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" /> : <RiArrowRightSLine className="h-4 w-4 text-muted-foreground" />}
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="space-y-2.5 pb-1 pl-1 pt-1">
                        {family.models.map(({ modelName, label, window, displayLabel }) => (
                          <UsageMetricRow
                            key={`${group.providerId}-${modelName}`}
                            providerId={group.providerId}
                            scope="model"
                            scopeId={modelName}
                            label={label}
                            window={window}
                            displayLabel={displayLabel}
                            quotaTrendHistory={quotaTrendHistory}
                            mutedTitle
                          />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          ) : null}

          {group.resetCredits ? <UsageResetCreditsList resetCredits={group.resetCredits} /> : null}
        </div>
      ) : null}
    </div>
  );
});
