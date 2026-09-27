import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { SettingsDetailHeader } from '@/components/sections/shared/SettingsDetailHeader';
import { SettingsEmptyState } from '@/components/sections/shared/SettingsEmptyState';
import { getSortedQuotaProviders, QUOTA_PROVIDERS } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useI18n } from '@/lib/i18n';
import { RiBarChart2Line } from '@remixicon/react';
import { ProviderUsagePanel } from './ProviderUsagePanel';

/**
 * Standalone usage view for accounts that may read usage but not providers.
 * Everyone else sees each provider's usage inline on its Providers page.
 */
export const UsagePage: React.FC = () => {
  const { t } = useI18n();
  const results = useQuotaStore((state) => state.results);
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);

  const sortedQuotaProviders = React.useMemo(() => getSortedQuotaProviders(), []);

  React.useEffect(() => {
    if (results.length === 0) {
      return;
    }
    if (selectedProviderId) {
      const selectedProviderResult = results.find((entry) => entry.providerId === selectedProviderId);
      if (selectedProviderId === 'cursor-acp' && selectedProviderResult) {
        return;
      }
      if (!selectedProviderResult || selectedProviderResult.configured) {
        return;
      }
    }
    const firstConfigured = sortedQuotaProviders.find((provider) => (
      results.some((entry) => entry.providerId === provider.id && entry.configured)
    ))?.id;
    setSelectedProvider(firstConfigured ?? null);
  }, [results, selectedProviderId, setSelectedProvider, sortedQuotaProviders]);

  if (!selectedProviderId) {
    return (
      <SettingsEmptyState
        size="page"
        icon={RiBarChart2Line}
        title={t('settings.usage.page.empty.selectProvider')}
      />
    );
  }

  const providerName = QUOTA_PROVIDERS.find((provider) => provider.id === selectedProviderId)?.name ?? selectedProviderId;

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8">
        <SettingsDetailHeader
          icon={<ProviderLogo providerId={selectedProviderId} className="h-5 w-5" />}
          title={t('settings.usage.page.header.providerUsage', { provider: providerName })}
        />
        <ProviderUsagePanel key={selectedProviderId} quotaProviderId={selectedProviderId} variant="page" />
      </div>
    </ScrollableOverlay>
  );
};
