import React, { useEffect } from 'react';
import { RiBarChartLine, RiServerLine, type RemixiconComponentType } from '@remixicon/react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  PlanDocumentIcon,
  SidebarRightIcon,
  TerminalPanelIcon,
} from '@/components/icons/ToolbarIcons';
import { McpIcon } from '@/components/icons/McpIcon';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { quotaRefreshCoordinator, useQuotaStore } from '@/stores/useQuotaStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { cn } from '@/lib/utils';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { eventMatchesShortcut, formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import {
  getAllModelFamilies,
  getUsageModelDisplayInfo,
  groupModelsByFamily,
  sortModelFamilies,
} from '@/lib/quota/model-families';
import type { UsageWindow, UsageWindows } from '@/types';
import { resolveActiveUsageProviderId } from '@/components/layout/usage/usage-groups';
import type { RateLimitGroup } from '@/components/layout/usage/types';
import { isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import { DesktopServicesMenu } from '@/components/layout/DesktopServicesMenu';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS, HeaderIconActionButton } from '@/components/layout/headerIconButton';
import { useSessionPlanFileStore } from '@/stores/useSessionPlanFileStore';
import { hasAuthCapability, useAuthPrincipal } from '@/lib/authSession';

const SidebarRightExpandIcon = (props: React.ComponentProps<typeof SidebarRightIcon>) => (
  <SidebarRightIcon {...props} chevronDirection="left" />
);

interface DesktopRightChromeActionsProps {
  browserActionPortalRef?: React.Ref<HTMLSpanElement>;
}

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const getActiveContextMode = (panelState: {
  isOpen: boolean;
  activeTabId: string | null;
  tabs: Array<{ id: string; mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview' | 'browser' }>;
} | undefined): 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview' | 'browser' | null => {
  if (!panelState?.isOpen || !Array.isArray(panelState.tabs) || panelState.tabs.length === 0) {
    return null;
  }

  const activeTab = panelState.tabs.find((tab) => tab.id === panelState.activeTabId) ?? panelState.tabs[panelState.tabs.length - 1];
  return activeTab?.mode ?? null;
};

export const DesktopRightChromeActions: React.FC<DesktopRightChromeActionsProps> = ({
  browserActionPortalRef,
}) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const canUseTerminal = hasAuthCapability(principal, 'terminal');
  const toggleBottomTerminal = useUIStore((state) => state.toggleBottomTerminal);
  const toggleRightSidebar = useUIStore((state) => state.toggleRightSidebar);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const toggleContextPlan = useUIStore((state) => state.toggleContextPlan);
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const savedPlanPath = useSessionPlanFileStore((state) => {
    if (!currentSessionId) return null;
    const record = state.recordsBySession[currentSessionId];
    return record?.status === 'saved' ? record.path : null;
  });
  const worktreePath = useSessionUIStore((state) => {
    if (!currentSessionId) return '';
    return state.worktreeMetadata.get(currentSessionId)?.path ?? '';
  });
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });

  const quotaResults = useQuotaStore((state) => state.results);
  const quotaProviderRefreshState = useQuotaStore((state) => state.providerRefreshState);
  const fetchAllQuotas = quotaRefreshCoordinator.refreshNow;
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaTrendHistory = useQuotaStore((state) => state.trendHistory);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedModels = useQuotaStore((state) => state.selectedModels);
  const expandedFamilies = useQuotaStore((state) => state.expandedFamilies);
  const toggleFamilyExpanded = useQuotaStore((state) => state.toggleFamilyExpanded);

  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);

  const [isDesktopApp, setIsDesktopApp] = React.useState(() => isDesktopShell());
  const [isDesktopServicesOpen, setIsDesktopServicesOpen] = React.useState(false);
  const [isUsageRefreshSpinning, setIsUsageRefreshSpinning] = React.useState(false);
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');
  const [desktopServicesTab, setDesktopServicesTab] = React.useState<'instance' | 'usage' | 'mcp'>('usage');
  const [activeUsageProviderId, setActiveUsageProviderId] = React.useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  useEffect(() => {
    if (!isDesktopApp && desktopServicesTab === 'instance') {
      setDesktopServicesTab('usage');
    }
  }, [desktopServicesTab, isDesktopApp]);

  const refreshCurrentInstanceLabel = React.useCallback(async () => {
    if (typeof window === 'undefined' || !isDesktopApp) {
      return;
    }

    try {
      const cfg = await desktopHostsGet();
      const currentHref = window.location.href;
      const localOrigin = window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;

      if (locationMatchesHost(currentHref, localOrigin)) {
        setCurrentInstanceLabel('Local');
        return;
      }

      const match = cfg.hosts.find((host) => locationMatchesHost(currentHref, host.url));
      if (match?.label?.trim()) {
        setCurrentInstanceLabel(redactSensitiveUrl(match.label.trim()));
        return;
      }

      setCurrentInstanceLabel('Instance');
    } catch {
      setCurrentInstanceLabel('Local');
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void refreshCurrentInstanceLabel();
  }, [refreshCurrentInstanceLabel]);
  const rateLimitGroups = React.useMemo(() => {
    const groups: RateLimitGroup[] = [];

    for (const provider of QUOTA_PROVIDERS) {
      if (!dropdownProviderIds.includes(provider.id)) {
        continue;
      }
      const result = quotaResults.find((entry) => entry.providerId === provider.id);
      const windows = (result?.usage?.windows ?? {}) as Record<string, UsageWindow>;
      const models = result?.usage?.models;
      const isAntigravityProvider = provider.id === 'antigravity';
      const entries = isAntigravityProvider ? [] : Object.entries(windows);

      const group: RateLimitGroup = {
        providerId: provider.id,
        providerName: provider.name,
        entries,
        usageUpdatedAt: result?.usageUpdatedAt
          ?? quotaProviderRefreshState[provider.id]?.lastSuccessAt
          ?? null,
        resetCredits: result?.usage?.resetCredits,
        error: quotaProviderRefreshState[provider.id]?.refreshError
          ?? ((result && !result.ok && result.configured) ? result.error : undefined),
      };

      if (models && Object.keys(models).length > 0) {
        const providerSelectedModels = selectedModels[provider.id] ?? [];
        const hasExplicitSelection = providerSelectedModels.length > 0;
        const modelGroups = groupModelsByFamily(models, provider.id);
        const families = getAllModelFamilies(provider.id);
        const sortedFamilies = sortModelFamilies(families);

        group.modelFamilies = [];

        for (const family of sortedFamilies) {
          const modelNames = modelGroups.get(family.id) ?? [];
          if (modelNames.length === 0) continue;

          const selectedModelNames = hasExplicitSelection
            ? modelNames.filter((m: string) => providerSelectedModels.includes(m))
            : modelNames;
          if (selectedModelNames.length === 0) continue;

          const familyModels: NonNullable<RateLimitGroup['modelFamilies']>[number]['models'] = [];
          for (const modelName of selectedModelNames) {
            const modelUsage = models[modelName] as UsageWindows | undefined;
            if (modelUsage?.windows) {
              const windowEntries = Object.entries(modelUsage.windows);
              if (windowEntries.length > 0) {
                const displayInfo = getUsageModelDisplayInfo(modelName, modelUsage);
                familyModels.push({
                  modelName,
                  label: windowEntries[0][0],
                  window: windowEntries[0][1],
                  displayLabel: displayInfo.contextLabel
                    ? `${displayInfo.displayName} · ${displayInfo.contextLabel}`
                    : displayInfo.displayName,
                });
              }
            }
          }

          if (familyModels.length > 0) {
            if (isAntigravityProvider) {
              group.modelRows = [...(group.modelRows ?? []), ...familyModels];
            } else {
              group.modelFamilies.push({
                familyId: family.id,
                familyLabel: family.label,
                models: familyModels,
              });
            }
          }
        }

        const otherModelNames = modelGroups.get(null) ?? [];
        const selectedOtherModels = hasExplicitSelection
          ? otherModelNames.filter((m: string) => providerSelectedModels.includes(m))
          : otherModelNames;
        if (selectedOtherModels.length > 0) {
          const otherModels: NonNullable<RateLimitGroup['modelFamilies']>[number]['models'] = [];
          for (const modelName of selectedOtherModels) {
            const modelUsage = models[modelName] as UsageWindows | undefined;
            if (modelUsage?.windows) {
              const windowEntries = Object.entries(modelUsage.windows);
              if (windowEntries.length > 0) {
                const displayInfo = getUsageModelDisplayInfo(modelName, modelUsage);
                otherModels.push({
                  modelName,
                  label: windowEntries[0][0],
                  window: windowEntries[0][1],
                  displayLabel: displayInfo.contextLabel
                    ? `${displayInfo.displayName} · ${displayInfo.contextLabel}`
                    : displayInfo.displayName,
                });
              }
            }
          }
          if (otherModels.length > 0) {
            if (isAntigravityProvider) {
              group.modelRows = [...(group.modelRows ?? []), ...otherModels];
            } else {
              group.modelFamilies.push({
                familyId: null,
                familyLabel: t('header.services.modelFamily.other'),
                models: otherModels,
              });
            }
          }
        }
      }

      if (
        entries.length > 0 ||
        group.resetCredits ||
        (group.modelRows && group.modelRows.length > 0) ||
        (group.modelFamilies && group.modelFamilies.length > 0) ||
        group.error
      ) {
        groups.push(group);
      }
    }

    return groups;
  }, [dropdownProviderIds, quotaProviderRefreshState, quotaResults, selectedModels, t]);

  const hasRateLimits = rateLimitGroups.length > 0;
  const resolvedActiveUsageProviderId = React.useMemo(
    () => resolveActiveUsageProviderId(rateLimitGroups, activeUsageProviderId),
    [activeUsageProviderId, rateLimitGroups],
  );

  React.useEffect(() => {
    if (activeUsageProviderId !== resolvedActiveUsageProviderId) {
      setActiveUsageProviderId(resolvedActiveUsageProviderId);
    }
  }, [activeUsageProviderId, resolvedActiveUsageProviderId]);

  const handleUsageRefresh = React.useCallback(() => {
    if (isUsageRefreshSpinning) return;
    setIsUsageRefreshSpinning(true);
    const minSpinPromise = new Promise((resolve) => setTimeout(resolve, 500));
    Promise.all([fetchAllQuotas({ forceRefresh: true }), minSpinPromise]).finally(() => {
      setIsUsageRefreshSpinning(false);
    });
  }, [fetchAllQuotas, isUsageRefreshSpinning]);

  const worktreeDirectory = React.useMemo(() => normalize(worktreePath || ''), [worktreePath]);
  const openDirectory = React.useMemo(() => {
    return worktreeDirectory || normalize(activeProject?.path || '');
  }, [activeProject?.path, worktreeDirectory]);

  const planTabAvailable = planModeEnabled && currentSessionId ? isSessionPlanAvailable(currentSessionId) : false;
  const showPlanTab = planTabAvailable;

  const handleOpenContextPlan = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    toggleContextPlan(directory, savedPlanPath, currentSessionId);
  }, [currentSessionId, openDirectory, savedPlanPath, toggleContextPlan]);

  const isContextPlanActive = React.useMemo(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return false;
    }
    const panelState = contextPanelByDirectory[directory];
    return getActiveContextMode(panelState) === 'plan';
  }, [contextPanelByDirectory, openDirectory]);

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  const servicesTabs = React.useMemo(() => {
    const base: Array<{ value: 'instance' | 'usage' | 'mcp'; label: string; icon: RemixiconComponentType }> = [];
    base.push({ value: 'usage', label: t('layout.services.usage'), icon: RiBarChartLine });
    base.push({ value: 'mcp', label: 'MCP', icon: McpIcon as unknown as RemixiconComponentType });
    if (isDesktopApp) {
      base.push({ value: 'instance', label: t('layout.services.instance'), icon: RiServerLine });
    }
    return base;
  }, [isDesktopApp, t]);

  const servicesTabItems = React.useMemo(() => {
    return servicesTabs.map((tab) => ({
      id: tab.value,
      label: tab.label,
      icon: <tab.icon className="h-4 w-4" />,
    }));
  }, [servicesTabs]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const toggleServicesCombo = getEffectiveShortcutCombo('toggle_services_menu', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleServicesCombo)) {
        e.preventDefault();

        if (isDesktopServicesOpen) {
          setIsDesktopServicesOpen(false);
        } else {
          setIsDesktopServicesOpen(true);
          void refreshCurrentInstanceLabel();
          if (desktopServicesTab === 'usage' && quotaResults.length === 0) {
            void fetchAllQuotas();
          }
        }
        return;
      }

      const cycleServicesCombo = getEffectiveShortcutCombo('cycle_services_tab', shortcutOverrides);
      if (eventMatchesShortcut(e, cycleServicesCombo)) {
        e.preventDefault();

        const tabValues = servicesTabs.map((tab) => tab.value) as Array<'instance' | 'usage' | 'mcp'>;
        if (tabValues.length === 0) {
          return;
        }

        const currentIndex = tabValues.indexOf(desktopServicesTab);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % tabValues.length;
        const nextTab = tabValues[nextIndex];
        setDesktopServicesTab(nextTab);
        setIsDesktopServicesOpen(true);
        void refreshCurrentInstanceLabel();
        if (nextTab === 'usage' && quotaResults.length === 0) {
          void fetchAllQuotas();
        }
        return;
      }

      const toggleContextPlanCombo = getEffectiveShortcutCombo('toggle_context_plan', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleContextPlanCombo)) {
        e.preventDefault();
        handleOpenContextPlan();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    shortcutOverrides,
    isDesktopServicesOpen,
    desktopServicesTab,
    servicesTabs,
    quotaResults.length,
    fetchAllQuotas,
    refreshCurrentInstanceLabel,
    handleOpenContextPlan,
  ]);

  return (
    <div className="app-region-no-drag flex items-center gap-1.5">
      {showPlanTab ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('header.actions.openPlanAria')}
              onClick={handleOpenContextPlan}
              className={cn(DESKTOP_HEADER_ICON_BUTTON_CLASS, isContextPlanActive && 'bg-[var(--interactive-hover)]')}
            >
              <PlanDocumentIcon className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.planWithShortcut', { shortcut: shortcutLabel('toggle_context_plan') })}</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DesktopServicesMenu
        isDesktopApp={isDesktopApp}
        currentInstanceLabel={currentInstanceLabel}
        isDesktopServicesOpen={isDesktopServicesOpen}
        setIsDesktopServicesOpen={setIsDesktopServicesOpen}
        refreshCurrentInstanceLabel={refreshCurrentInstanceLabel}
        desktopServicesTab={desktopServicesTab}
        setDesktopServicesTab={setDesktopServicesTab}
        quotaResultsLength={quotaResults.length}
        fetchAllQuotas={fetchAllQuotas}
        servicesTabItems={servicesTabItems}
        quotaTrendHistory={quotaTrendHistory}
        handleUsageRefresh={handleUsageRefresh}
        isQuotaLoading={isQuotaLoading}
        isUsageRefreshSpinning={isUsageRefreshSpinning}
        hasRateLimits={hasRateLimits}
        rateLimitGroups={rateLimitGroups}
        activeUsageProviderId={resolvedActiveUsageProviderId}
        setActiveUsageProviderId={setActiveUsageProviderId}
        expandedFamilies={expandedFamilies}
        toggleFamilyExpanded={toggleFamilyExpanded}
        shortcutLabel={shortcutLabel}
      />
      {canUseTerminal ? (
        <HeaderIconActionButton
          title={t('header.actions.terminalPanelWithShortcut', { shortcut: shortcutLabel('toggle_terminal') })}
          ariaLabel={t('header.actions.toggleTerminalPanelAria')}
          onClick={toggleBottomTerminal}
          className={cn(DESKTOP_HEADER_ICON_BUTTON_CLASS, 'h-[37.5px] w-[37.5px]')}
          iconClassName="h-[18px] w-[18px]"
          Icon={TerminalPanelIcon}
        />
      ) : null}
      <span
        ref={browserActionPortalRef}
        className="contents"
        data-desktop-browser-action-slot="true"
      />
      <HeaderIconActionButton
        title={t('header.actions.rightSidebarWithShortcut', { shortcut: shortcutLabel('toggle_right_sidebar') })}
        ariaLabel={t('header.actions.toggleRightSidebarAria')}
        onClick={toggleRightSidebar}
        Icon={isRightSidebarOpen ? SidebarRightIcon : SidebarRightExpandIcon}
      />
    </div>
  );
};
