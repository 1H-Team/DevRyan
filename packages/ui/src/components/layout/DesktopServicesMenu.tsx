import React from 'react';
import { RiServerLine } from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { UsageTrendHistory } from '@/lib/quota';
import { UsageProviderPanel } from '@/components/layout/usage/UsageProviderPanel';
import { UsageProviderTabs } from '@/components/layout/usage/UsageProviderTabs';
import type { RateLimitGroup } from '@/components/layout/usage/types';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { DevShutdownMenuItem } from '@/components/layout/DevShutdownMenuItem';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS } from '@/components/layout/headerIconButton';

const formatTime = (timestamp: number | null) => {
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '-';
  }
};

export type DesktopServicesMenuProps = {
  isDesktopApp: boolean;
  currentInstanceLabel: string;
  isDesktopServicesOpen: boolean;
  setIsDesktopServicesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refreshCurrentInstanceLabel: () => Promise<void>;
  desktopServicesTab: 'instance' | 'usage' | 'mcp';
  setDesktopServicesTab: React.Dispatch<React.SetStateAction<'instance' | 'usage' | 'mcp'>>;
  quotaResultsLength: number;
  fetchAllQuotas: () => Promise<unknown>;
  servicesTabItems: SortableTabsStripItem[];
  quotaLastUpdated: number | null;
  quotaTrendHistory: UsageTrendHistory;
  handleUsageRefresh: () => void;
  isQuotaLoading: boolean;
  isUsageRefreshSpinning: boolean;
  hasRateLimits: boolean;
  rateLimitGroups: RateLimitGroup[];
  activeUsageProviderId: string | null;
  setActiveUsageProviderId: React.Dispatch<React.SetStateAction<string | null>>;
  expandedFamilies: Record<string, string[]>;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  shortcutLabel: (actionId: string) => string;
};

export const DesktopServicesMenu = React.memo(function DesktopServicesMenu({
  isDesktopApp,
  currentInstanceLabel,
  isDesktopServicesOpen,
  setIsDesktopServicesOpen,
  refreshCurrentInstanceLabel,
  desktopServicesTab,
  setDesktopServicesTab,
  quotaResultsLength,
  fetchAllQuotas,
  servicesTabItems,
  quotaLastUpdated,
  quotaTrendHistory,
  handleUsageRefresh,
  isQuotaLoading,
  isUsageRefreshSpinning,
  hasRateLimits,
  rateLimitGroups,
  activeUsageProviderId,
  setActiveUsageProviderId,
  expandedFamilies,
  toggleFamilyExpanded,
  shortcutLabel,
}: DesktopServicesMenuProps) {
  const { t } = useI18n();
  const selectedGroup = React.useMemo(() => (
    rateLimitGroups.find((group) => group.providerId === activeUsageProviderId) ?? null
  ), [activeUsageProviderId, rateLimitGroups]);
  return (
    <DropdownMenu
      open={isDesktopServicesOpen}
      onOpenChange={(open) => {
        setIsDesktopServicesOpen(open);
        if (open) {
          void refreshCurrentInstanceLabel();
          if (desktopServicesTab === 'usage' && quotaResultsLength === 0) {
            void fetchAllQuotas();
          }
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={isDesktopApp
                ? t('header.services.openWithCurrent', { current: currentInstanceLabel })
                : t('header.services.open')}
              className={cn(
                DESKTOP_HEADER_ICON_BUTTON_CLASS,
                'h-[37.5px] w-[37.5px]'
              )}
            >
              <RiServerLine className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {isDesktopApp
              ? t('header.services.tooltip.currentInstanceWithShortcuts', {
                  current: currentInstanceLabel,
                  toggle: shortcutLabel('toggle_services_menu'),
                  nextTab: shortcutLabel('cycle_services_tab'),
                })
              : t('header.services.tooltip.servicesWithShortcuts', {
                  toggle: shortcutLabel('toggle_services_menu'),
                  nextTab: shortcutLabel('cycle_services_tab'),
                })}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-[min(27rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto bg-[var(--surface-elevated)] p-0"
      >
        <div className="sticky top-0 z-20 bg-[var(--surface-elevated)] px-2 py-1">
          <div className="h-9">
            <SortableTabsStrip
              items={servicesTabItems}
              activeId={desktopServicesTab}
              onSelect={(tabID) => {
                const value = tabID as 'instance' | 'usage' | 'mcp';
                setDesktopServicesTab(value);
                if (value === 'usage' && quotaResultsLength === 0) {
                  void fetchAllQuotas();
                }
              }}
              layoutMode="fit"
              variant="active-pill"
              activePillInsetClassName="gap-0.5 px-px py-0"
              activePillButtonClassName="h-8 text-sm"
              activePillLowercase={false}
              className="h-full"
            />
          </div>
        </div>

        {isDesktopApp && desktopServicesTab === 'instance' ? (
          <DesktopHostSwitcherDialog
            embedded
            open={isDesktopServicesOpen && desktopServicesTab === 'instance'}
            onOpenChange={() => {}}
            onHostSwitched={() => setIsDesktopServicesOpen(false)}
          />
        ) : null}

        {desktopServicesTab === 'mcp' ? (
          <McpDropdownContent active={isDesktopServicesOpen && desktopServicesTab === 'mcp'} />
        ) : null}

        {desktopServicesTab === 'usage' ? (
          <div className="overflow-x-hidden">
            {hasRateLimits ? (
              <UsageProviderTabs
                groups={rateLimitGroups}
                activeProviderId={activeUsageProviderId}
                onSelectProvider={setActiveUsageProviderId}
              />
            ) : null}
            <UsageProviderPanel
              group={selectedGroup}
              quotaLastUpdated={quotaLastUpdated}
              quotaTrendHistory={quotaTrendHistory}
              handleUsageRefresh={handleUsageRefresh}
              isQuotaLoading={isQuotaLoading}
              isUsageRefreshSpinning={isUsageRefreshSpinning}
              expandedFamilies={expandedFamilies}
              toggleFamilyExpanded={toggleFamilyExpanded}
              formatUpdatedTime={formatTime}
            />
          </div>
        ) : null}
        <DevShutdownMenuItem />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
