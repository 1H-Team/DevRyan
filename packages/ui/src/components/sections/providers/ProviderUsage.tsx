import React from 'react';

import { SettingsDetailHeader } from '@/components/sections/shared/SettingsDetailHeader';
import { ProviderUsagePanel } from '@/components/sections/usage/ProviderUsagePanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import {
  QUOTA_PROVIDER_MAP,
  formatProviderWindowLabel,
  getPeakUsageWindow,
  getQuotaProviderIdForProvider,
  resolveUsageTone,
} from '@/lib/quota';
import { cn } from '@/lib/utils';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId } from '@/types';

import { useCanReadUsage } from './useProviderUsage';

/**
 * Inline Usage section for a Providers-catalog provider; renders nothing without a usage source.
 * A connected provider still shows the panel (reason and retry) while usage discovery is failing.
 */
export const ProviderUsageSection: React.FC<{ providerId: string; connected?: boolean }> = ({
  providerId,
  connected = false,
}) => {
  const canReadUsage = useCanReadUsage();
  const quotaProviderId = getQuotaProviderIdForProvider(providerId);
  const hasResult = useQuotaStore((state) => (
    quotaProviderId ? state.results.some((entry) => entry.providerId === quotaProviderId) : false
  ));
  const discoveryFailed = useQuotaStore((state) => state.configuredProviderIds === null && state.error !== null);
  if (!canReadUsage || !quotaProviderId || !(hasResult || (connected && discoveryFailed))) return null;
  return <ProviderUsagePanel key={quotaProviderId} quotaProviderId={quotaProviderId} variant="section" className="mb-8" />;
};

/** Detail view for a usage source without a matching Providers row. */
export const UsageOnlyProviderView: React.FC<{ quotaProviderId: QuotaProviderId }> = ({ quotaProviderId }) => {
  const { t } = useI18n();
  const providerName = QUOTA_PROVIDER_MAP[quotaProviderId]?.name ?? quotaProviderId;

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8">
        <SettingsDetailHeader
          icon={<ProviderLogo providerId={quotaProviderId} className="h-5 w-5" />}
          title={providerName}
          subtitle={t('settings.providers.usageOnly.description')}
        />
        <ProviderUsagePanel key={quotaProviderId} quotaProviderId={quotaProviderId} variant="page" embedded />
      </div>
    </ScrollableOverlay>
  );
};

const METER_TONE_CLASSES = {
  safe: 'bg-[var(--status-success)]',
  warn: 'bg-[var(--status-warning)]',
  critical: 'bg-[var(--status-error)]',
} as const;

/**
 * Thin progress line for a sidebar row showing the provider's most-used usage
 * window. Renders nothing when usage is unreadable or reports no progress.
 */
export const ProviderUsageMeter: React.FC<{ quotaProviderId: QuotaProviderId | null; className?: string }> = ({
  quotaProviderId,
  className,
}) => {
  const { t } = useI18n();
  const canReadUsage = useCanReadUsage();
  const usage = useQuotaStore((state) => (
    quotaProviderId ? state.results.find((entry) => entry.providerId === quotaProviderId)?.usage ?? null : null
  ));
  const peak = React.useMemo(() => getPeakUsageWindow(usage), [usage]);
  if (!canReadUsage || !quotaProviderId || !peak) return null;

  const label = t('settings.providers.sidebar.usage.meterLabel', {
    percent: `${peak.usedPercent}%`,
    window: formatProviderWindowLabel(quotaProviderId, peak.label),
  });

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={peak.usedPercent}
      title={label}
      className={cn('h-[3px] w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', METER_TONE_CLASSES[resolveUsageTone(peak.usedPercent)])}
        style={{ width: `${Math.max(peak.usedPercent, 2)}%` }}
      />
    </div>
  );
};
