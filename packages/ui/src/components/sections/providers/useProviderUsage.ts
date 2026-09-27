import React from 'react';

import { getVisibleUsageProviders } from '@/components/sections/usage/usage-provider-visibility';
import { canReadSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import { getUsageOnlyQuotaProviders, type QuotaProviderMeta } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId } from '@/types';

export const useCanReadUsage = (): boolean => {
  const principal = useAuthPrincipal();
  return canReadSettingsPage(principal, 'usage');
};

/** Usage sources that no Providers row covers, hidden when usage is not readable. */
export const useUsageOnlyQuotaProviders = (catalogProviderIds: readonly string[]): QuotaProviderMeta[] => {
  const canReadUsage = useCanReadUsage();
  const results = useQuotaStore((state) => state.results);
  return React.useMemo(
    () => (canReadUsage ? getUsageOnlyQuotaProviders(getVisibleUsageProviders(results), catalogProviderIds) : []),
    [canReadUsage, catalogProviderIds, results],
  );
};

/**
 * Whether a usage-only selection should be kept: while quota discovery has not
 * finished, or while that source still reports usage.
 */
export const useUsageOnlySelectionAvailable = (quotaProviderId: QuotaProviderId | null): boolean => {
  const canReadUsage = useCanReadUsage();
  return useQuotaStore((state) => {
    if (!quotaProviderId || !canReadUsage) return false;
    if (state.configuredProviderIds === null) return true;
    return state.results.some((entry) => entry.providerId === quotaProviderId);
  });
};
