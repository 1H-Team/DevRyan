import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { SettingsSidebarHeader } from '@/components/sections/shared/SettingsSidebarHeader';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { canEditSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import { cn } from '@/lib/utils';
import { quotaRefreshCoordinator, useQuotaStore } from '@/stores/useQuotaStore';
import { RiRefreshLine } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';
import { UsageOptionsMenu } from './UsageOptionsMenu';
import { getVisibleUsageProviders } from './usage-provider-visibility';

interface UsageSidebarProps {
  onItemSelect?: () => void;
}

/** Provider list for the standalone Usage page (accounts without Providers access). */
export const UsageSidebar: React.FC<UsageSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const results = useQuotaStore((state) => state.results);
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const isLoading = useQuotaStore((state) => state.isLoading);

  const visibleProviders = React.useMemo(() => getVisibleUsageProviders(results), [results]);

  return (
    <SettingsSidebarLayout
      variant="background"
      header={(
        <SettingsSidebarHeader
          title={t('settings.usage.sidebar.title')}
          titleActions={(
            <>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 w-7 px-0 text-muted-foreground"
                onClick={() => void quotaRefreshCoordinator.refreshNow({ forceRefresh: true }).catch(() => undefined)}
                aria-label={t('settings.usage.sidebar.actions.refreshAria')}
                title={t('settings.usage.sidebar.actions.refreshTitle')}
                disabled={isLoading}
              >
                <RiRefreshLine className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              </Button>
              <UsageOptionsMenu canEdit={canEditSettingsPage(principal, 'usage')} />
            </>
          )}
          countLabel={t('settings.usage.sidebar.total', { count: visibleProviders.length })}
        />
      )}
    >
      {visibleProviders.map((provider) => {
        const result = results.find((entry) => entry.providerId === provider.id);
        const isSelected = provider.id === selectedProviderId;
        const configured = result?.configured ?? false;

        return (
          <div
            key={provider.id}
            className={cn(
              'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
              isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
            )}
          >
            <button
              type="button"
              onClick={() => {
                setSelectedProvider(provider.id);
                onItemSelect?.();
              }}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
              <span className="typography-ui-label font-normal truncate flex-1 min-w-0 text-foreground">
                {provider.name}
              </span>
              {!configured && (
                <span className="typography-micro text-muted-foreground/60 flex-shrink-0">{t('settings.usage.sidebar.status.notSet')}</span>
              )}
            </button>
          </div>
        );
      })}
    </SettingsSidebarLayout>
  );
};
