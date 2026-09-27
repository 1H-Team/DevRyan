import React from 'react';
import { RiEqualizer2Line } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useQuotaStore } from '@/stores/useQuotaStore';

const REFRESH_INTERVAL_OPTIONS = [
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
] as const;

type UsageSettingsChanges = {
  usageAutoRefresh?: boolean;
  usageRefreshIntervalMs?: number;
  usageDisplayMode?: 'usage' | 'remaining';
  usageShowPredValues?: boolean;
};

const persistUsageSettings = async (changes: UsageSettingsChanges) => {
  try {
    await updateDesktopSettings(changes);
  } catch (error) {
    console.warn('Failed to save usage settings:', error);
  }
};

/**
 * Global usage display preferences shared by every provider's usage view:
 * faster auto-refresh, its interval, used-vs-remaining display, and prediction rows.
 */
export const UsageOptionsMenu: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const { t } = useI18n();
  const usageAutoRefresh = useQuotaStore((state) => state.autoRefresh);
  const usageRefreshIntervalMs = useQuotaStore((state) => state.refreshIntervalMs);
  const usageDisplayMode = useQuotaStore((state) => state.displayMode);
  const showPredictionValues = useQuotaStore((state) => state.showPredictionValues);
  const setUsageAutoRefresh = useQuotaStore((state) => state.setAutoRefresh);
  const setUsageRefreshInterval = useQuotaStore((state) => state.setRefreshInterval);
  const setUsageDisplayMode = useQuotaStore((state) => state.setDisplayMode);
  const setShowPredictionValues = useQuotaStore((state) => state.setShowPredictionValues);

  const handleUsageAutoRefreshChange = React.useCallback((enabled: boolean) => {
    setUsageAutoRefresh(enabled);
    void persistUsageSettings({ usageAutoRefresh: enabled });
  }, [setUsageAutoRefresh]);

  const handleUsageRefreshIntervalChange = React.useCallback((value: unknown) => {
    const next = Number(value);
    if (!Number.isFinite(next)) {
      return;
    }
    setUsageRefreshInterval(next);
    void persistUsageSettings({ usageRefreshIntervalMs: next });
  }, [setUsageRefreshInterval]);

  const handleUsageDisplayModeChange = React.useCallback((value: unknown) => {
    if (value !== 'usage' && value !== 'remaining') {
      return;
    }
    setUsageDisplayMode(value);
    void persistUsageSettings({ usageDisplayMode: value });
  }, [setUsageDisplayMode]);

  const handleShowPredictionValuesChange = React.useCallback((enabled: boolean) => {
    setShowPredictionValues(enabled);
    void persistUsageSettings({ usageShowPredValues: enabled });
  }, [setShowPredictionValues]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-6 w-6 px-0 text-muted-foreground hover:text-foreground"
          aria-label={t('settings.usage.options.aria')}
          title={t('settings.usage.options.aria')}
          data-settings-readonly-allowed="true"
        >
          <RiEqualizer2Line className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-60"
        // Usage preferences are personal: keep them usable inside a read-only
        // Providers page when the usage page itself is editable.
        data-settings-readonly-allowed={canEdit ? 'true' : undefined}
      >
        <DropdownMenuLabel className="typography-micro text-muted-foreground">
          {t('settings.usage.options.refreshGroup')}
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          className="pr-8"
          checked={usageAutoRefresh}
          onCheckedChange={handleUsageAutoRefreshChange}
          disabled={!canEdit}
          closeOnClick={false}
        >
          {t('settings.usage.options.autoRefresh')}
        </DropdownMenuCheckboxItem>
        <div className="px-2 pb-1 typography-micro text-muted-foreground">
          {t('settings.usage.sidebar.tooltip.autoRefresh')}
        </div>
        <DropdownMenuRadioGroup
          value={String(usageRefreshIntervalMs)}
          onValueChange={handleUsageRefreshIntervalChange}
        >
          {REFRESH_INTERVAL_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={String(option.value)}
              disabled={!canEdit || !usageAutoRefresh}
              closeOnClick={false}
              className="pl-6"
            >
              {t('settings.usage.options.interval', { interval: option.label })}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="typography-micro text-muted-foreground">
          {t('settings.usage.sidebar.field.display')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={usageDisplayMode} onValueChange={handleUsageDisplayModeChange}>
          <DropdownMenuRadioItem value="usage" disabled={!canEdit} closeOnClick={false}>
            {t('settings.usage.sidebar.field.displayModeUsage')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="remaining" disabled={!canEdit} closeOnClick={false}>
            {t('settings.usage.sidebar.field.displayModeRemaining')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuCheckboxItem
          className="pr-8"
          checked={showPredictionValues}
          onCheckedChange={handleShowPredictionValuesChange}
          disabled={!canEdit}
          closeOnClick={false}
        >
          {t('settings.usage.sidebar.field.showPredictionRows')}
        </DropdownMenuCheckboxItem>
        <div className="px-2 pb-1 typography-micro text-muted-foreground">
          {t('settings.usage.sidebar.tooltip.showPredictionRows')}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
