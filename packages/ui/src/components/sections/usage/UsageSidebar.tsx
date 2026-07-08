import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getSortedQuotaProviders } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { RiRefreshLine } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';

interface UsageSidebarProps {
  onItemSelect?: () => void;
}

export const UsageSidebar: React.FC<UsageSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const results = useQuotaStore((state) => state.results);
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const usageAutoRefresh = useQuotaStore((state) => state.autoRefresh);
  const usageRefreshIntervalMs = useQuotaStore((state) => state.refreshIntervalMs);
  const usageDisplayMode = useQuotaStore((state) => state.displayMode);
  const showPredictionValues = useQuotaStore((state) => state.showPredictionValues);
  const setUsageAutoRefresh = useQuotaStore((state) => state.setAutoRefresh);
  const setUsageRefreshInterval = useQuotaStore((state) => state.setRefreshInterval);
  const setUsageDisplayMode = useQuotaStore((state) => state.setDisplayMode);
  const setShowPredictionValues = useQuotaStore((state) => state.setShowPredictionValues);
  const loadUsageSettings = useQuotaStore((state) => state.loadSettings);

  const visibleProviders = React.useMemo(() => {
    const configuredByProviderId = new Map(results.map((entry) => [entry.providerId, entry.configured]));
    return getSortedQuotaProviders().filter((provider) => (
      configuredByProviderId.get(provider.id) === true
      || (provider.id === 'cursor-acp' && configuredByProviderId.has(provider.id))
    ));
  }, [results]);

  React.useEffect(() => {
    void loadUsageSettings();
  }, [loadUsageSettings]);

  const persistUsageSettings = React.useCallback(async (changes: { usageAutoRefresh?: boolean; usageRefreshIntervalMs?: number; usageDisplayMode?: 'usage' | 'remaining'; usageShowPredValues?: boolean; usageDropdownProviders?: string[] }) => {
    try {
      await updateDesktopSettings(changes);
    } catch (error) {
      console.warn('Failed to save usage settings:', error);
    }
  }, []);

  const handleUsageAutoRefreshChange = React.useCallback((enabled: boolean) => {
    setUsageAutoRefresh(enabled);
    void persistUsageSettings({ usageAutoRefresh: enabled });
  }, [persistUsageSettings, setUsageAutoRefresh]);

  const handleUsageRefreshIntervalChange = React.useCallback((value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next)) {
      return;
    }
    setUsageRefreshInterval(next);
    void persistUsageSettings({ usageRefreshIntervalMs: next });
  }, [persistUsageSettings, setUsageRefreshInterval]);

  const handleUsageDisplayModeChange = React.useCallback((value: string) => {
    if (value !== 'usage' && value !== 'remaining') {
      return;
    }
    setUsageDisplayMode(value);
    void persistUsageSettings({ usageDisplayMode: value });
  }, [persistUsageSettings, setUsageDisplayMode]);

  const handleShowPredictionValuesChange = React.useCallback((enabled: boolean) => {
    setShowPredictionValues(enabled);
    void persistUsageSettings({ usageShowPredValues: enabled });
  }, [persistUsageSettings, setShowPredictionValues]);

  const resolveUsageDisplayModeLabel = React.useCallback((value: string | undefined) => {
    if (value === 'usage') {
      return t('settings.usage.sidebar.field.displayModeUsage');
    }
    if (value === 'remaining') {
      return t('settings.usage.sidebar.field.displayModeRemaining');
    }
    return value ?? '';
  }, [t]);

  const bgClass = 'bg-background';

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">{t('settings.usage.sidebar.title')}</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.usage.sidebar.total', { count: visibleProviders.length })}</span>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Checkbox
                    checked={usageAutoRefresh}
                    onChange={handleUsageAutoRefreshChange}
                    ariaLabel={t('settings.usage.sidebar.actions.toggleAutoRefreshAria')}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('settings.usage.sidebar.tooltip.autoRefresh')}
              </TooltipContent>
            </Tooltip>
            <Select
              value={String(usageRefreshIntervalMs)}
              onValueChange={handleUsageRefreshIntervalChange}
              disabled={!usageAutoRefresh}
            >
              <SelectTrigger className="w-fit">
                <SelectValue placeholder={t('settings.usage.sidebar.field.intervalPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30000">30s</SelectItem>
                <SelectItem value="60000">1m</SelectItem>
                <SelectItem value="300000">5m</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm"
              variant="ghost"
              className="h-7 w-7 px-0 text-muted-foreground"
              onClick={() => fetchAllQuotas({ forceRefresh: true })}
              aria-label={t('settings.usage.sidebar.actions.refreshAria')}
              title={t('settings.usage.sidebar.actions.refreshTitle')}
              disabled={isLoading}
            >
              <RiRefreshLine className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            </Button>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="typography-micro text-muted-foreground">{t('settings.usage.sidebar.field.display')}</span>
          <Select value={usageDisplayMode} onValueChange={handleUsageDisplayModeChange}>
            <SelectTrigger className="w-fit">
              <SelectValue placeholder={t('settings.usage.sidebar.field.displayModePlaceholder')}>
                {resolveUsageDisplayModeLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="usage">{t('settings.usage.sidebar.field.displayModeUsage')}</SelectItem>
              <SelectItem value="remaining">{t('settings.usage.sidebar.field.displayModeRemaining')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="typography-micro text-foreground">{t('settings.usage.sidebar.field.showPredictionRows')}</div>
            <div className="typography-micro text-muted-foreground">{t('settings.usage.sidebar.tooltip.showPredictionRows')}</div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Checkbox
                  checked={showPredictionValues}
                  onChange={handleShowPredictionValuesChange}
                  ariaLabel={t('settings.usage.sidebar.field.showPredictionRows')}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('settings.usage.sidebar.tooltip.showPredictionRows')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
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
      </ScrollableOverlay>
    </div>
  );
};
