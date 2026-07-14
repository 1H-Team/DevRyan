import React, { useEffect } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';

import { RiArrowLeftSLine, RiBarChartLine, RiChat4Line, RiChatNewLine, RiCloseLine, RiCommandLine, RiPlayListAddLine, RiServerLine, type RemixiconComponentType } from '@remixicon/react';
import { DiffIcon } from '@/components/icons/DiffIcon';
import {
  PlanDocumentIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
  TerminalPanelIcon,
} from '@/components/icons/ToolbarIcons';
import { useUIStore, type MainTab } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions, useSession } from '@/sync/sync-context';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { quotaRefreshCoordinator, useQuotaStore } from '@/stores/useQuotaStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

import { useDeviceInfo, useTabletStandalonePwaRuntime } from '@/lib/device';
import { cn, hasModifier } from '@/lib/utils';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import {
  getAllModelFamilies,
  getUsageModelDisplayInfo,
  groupModelsByFamily,
  sortModelFamilies,
} from '@/lib/quota/model-families';

import type { UsageWindow, UsageWindows } from '@/types';
import { UsageProviderPanel } from '@/components/layout/usage/UsageProviderPanel';
import { UsageProviderTabs } from '@/components/layout/usage/UsageProviderTabs';
import { resolveActiveUsageProviderId } from '@/components/layout/usage/usage-groups';
import type { RateLimitGroup } from '@/components/layout/usage/types';
import { DevShutdownMenuItem } from '@/components/layout/DevShutdownMenuItem';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { ActiveSessionChangesBadge } from '@/components/session/ActiveSessionChangesBadge';
import { isDesktopShell, isVSCodeRuntime, startDesktopWindowDrag } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { DESKTOP_LEFT_CHROME_CLUSTER_WIDTH } from '@/components/layout/desktopChromeInsets';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS, HeaderIconActionButton } from '@/components/layout/headerIconButton';

const MOBILE_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-9 w-9 items-center justify-center gap-2 p-2 rounded-md typography-ui-label font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:text-foreground hover:bg-interactive-hover transition-colors';

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

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

interface TabConfig {
  id: MainTab;
  label: string;
  icon: RemixiconComponentType | 'diff';
  badge?: number;
  showDot?: boolean;
}

interface HeaderProps {
  onToggleLeftDrawer?: () => void;
  onToggleRightDrawer?: () => void;
  leftDrawerOpen?: boolean;
  rightDrawerOpen?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onToggleLeftDrawer,
  onToggleRightDrawer,
  leftDrawerOpen,
  rightDrawerOpen,
}) => {
  const { t } = useI18n();
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSyncedSession = useSession(currentSessionId ?? null);
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const liveSessions = useAllLiveSessions();
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });
  const activeProjectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }

    const trimmedLabel = activeProject.label?.trim();
    if (trimmedLabel) {
      return trimmedLabel;
    }

    const pathSegments = activeProject.path.split(/[\\/]/).filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? null;
  }, [activeProject]);
  const quotaResults = useQuotaStore((state) => state.results);
  const quotaProviderRefreshState = useQuotaStore((state) => state.providerRefreshState);
  const fetchAllQuotas = quotaRefreshCoordinator.refreshNow;
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaLastUpdated = useQuotaStore((state) => state.lastUpdated);
  const quotaTrendHistory = useQuotaStore((state) => state.trendHistory);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);

  const { isMobile } = useDeviceInfo();

  const headerRef = React.useRef<HTMLElement | null>(null);

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __OPENCHAMBER_MACOS_MAJOR__?: unknown }).__OPENCHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    // Fallback: WebKit reports "Mac OS X 10_15_7" format where 10 is legacy prefix
    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
    return first === 10 ? second : first;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
  const [isMobileRateLimitsOpen, setIsMobileRateLimitsOpen] = React.useState(false);
  const [isUsageRefreshSpinning, setIsUsageRefreshSpinning] = React.useState(false);
  const [mobileServicesTab, setMobileServicesTab] = React.useState<'usage' | 'mcp'>('usage');
  const [activeUsageProviderId, setActiveUsageProviderId] = React.useState<string | null>(null);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isLeftSidebarOpen = React.useMemo(() => {
    if (!isMobile) {
      return isSidebarOpen;
    }
    if (typeof onToggleLeftDrawer === 'function') {
      return Boolean(leftDrawerOpen);
    }
    return isSessionSwitcherOpen;
  }, [isMobile, isSessionSwitcherOpen, isSidebarOpen, leftDrawerOpen, onToggleLeftDrawer]);
  const selectedModels = useQuotaStore((state) => state.selectedModels);
  const expandedFamilies = useQuotaStore((state) => state.expandedFamilies);
  const toggleFamilyExpanded = useQuotaStore((state) => state.toggleFamilyExpanded);

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
        resetCredits: result?.usage?.resetCredits,
        error: quotaProviderRefreshState[provider.id]?.refreshError
          ?? ((result && !result.ok && result.configured) ? result.error : undefined),
      };

      // Add model families if provider has per-model quotas
      if (models && Object.keys(models).length > 0) {
        const providerSelectedModels = selectedModels[provider.id] ?? [];
        // hasExplicitSelection = true means user has selected specific models to show
        // If the array exists but is empty, treat as "show all" (user cleared selection)
        const hasExplicitSelection = providerSelectedModels.length > 0;
        const modelGroups = groupModelsByFamily(models, provider.id);
        const families = getAllModelFamilies(provider.id);
        const sortedFamilies = sortModelFamilies(families);

        group.modelFamilies = [];

        // Add predefined families first
        for (const family of sortedFamilies) {
          const modelNames = modelGroups.get(family.id) ?? [];
          if (modelNames.length === 0) continue;

          // Filter to selected models only, OR show all if nothing selected
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

        // Add "Other" family for remaining models
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
  const selectedGroup = React.useMemo(
    () => rateLimitGroups.find((group) => group.providerId === resolvedActiveUsageProviderId) ?? null,
    [rateLimitGroups, resolvedActiveUsageProviderId],
  );
  React.useEffect(() => {
    if (activeUsageProviderId !== resolvedActiveUsageProviderId) {
      setActiveUsageProviderId(resolvedActiveUsageProviderId);
    }
  }, [activeUsageProviderId, resolvedActiveUsageProviderId]);
  const handleUsageRefresh = React.useCallback(() => {
    if (isUsageRefreshSpinning) return;
    setIsUsageRefreshSpinning(true);
    const minSpinPromise = new Promise(resolve => setTimeout(resolve, 500));
    Promise.all([fetchAllQuotas({ forceRefresh: true }), minSpinPromise]).finally(() => {
      setIsUsageRefreshSpinning(false);
    });
  }, [fetchAllQuotas, isUsageRefreshSpinning]);

  const currentSessionLive = React.useMemo(() => {
    if (!currentSessionId) return null;
    return liveSessions.find((s) => s.id === currentSessionId)
      ?? globalActiveSessions.find((s) => s.id === currentSessionId)
      ?? currentSyncedSession
      ?? getAllSyncSessions().find((s) => s.id === currentSessionId)
      ?? null;
  }, [currentSessionId, currentSyncedSession, globalActiveSessions, liveSessions]);

  const lastResolvedSessionRef = React.useRef<{
    sessionId: string;
    session: Session;
    expiresAt: number;
  } | null>(null);
  const [sessionFallbackVersion, setSessionFallbackVersion] = React.useState(0);

  React.useEffect(() => {
    if (!currentSessionId) {
      if (lastResolvedSessionRef.current) {
        lastResolvedSessionRef.current = null;
        setSessionFallbackVersion((value) => value + 1);
      }
      return;
    }

    if (currentSessionLive) {
      lastResolvedSessionRef.current = {
        sessionId: currentSessionId,
        session: currentSessionLive,
        expiresAt: Date.now() + 2000,
      };
      return;
    }

    const cached = lastResolvedSessionRef.current;
    if (!cached || cached.sessionId !== currentSessionId) {
      return;
    }

    const remainingMs = cached.expiresAt - Date.now();
    if (remainingMs <= 0) {
      lastResolvedSessionRef.current = null;
      setSessionFallbackVersion((value) => value + 1);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (lastResolvedSessionRef.current?.sessionId === currentSessionId) {
        lastResolvedSessionRef.current = null;
      }
      setSessionFallbackVersion((value) => value + 1);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [currentSessionId, currentSessionLive]);

  void sessionFallbackVersion;
  const currentSession = (() => {
    if (currentSessionLive) {
      return currentSessionLive;
    }

    if (!currentSessionId) {
      return null;
    }

    const cached = lastResolvedSessionRef.current;
    if (cached && cached.sessionId === currentSessionId && cached.expiresAt > Date.now()) {
      return cached.session;
    }

    return null;
  })();

  const worktreePath = useSessionUIStore((state) => {
    if (!currentSessionId) return '';
    return state.worktreeMetadata.get(currentSessionId)?.path ?? '';
  });
  const worktreeDirectory = React.useMemo(() => {
    return normalize(worktreePath || '');
  }, [worktreePath]);

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof currentSession?.directory === 'string' ? currentSession.directory : '';
    return normalize(raw || '');
  }, [currentSession?.directory]);

  const draftDirectory = useSessionUIStore((state) => {
    if (!(state.currentDraftId && state.newSessionDraft?.open)) {
      return '';
    }
    return normalize(state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride ?? '');
  });

  const openDirectory = React.useMemo(() => {
    return worktreeDirectory || sessionDirectory || draftDirectory;
  }, [draftDirectory, sessionDirectory, worktreeDirectory]);

  const currentSessionTitle = React.useMemo(() => {
    if (!currentSessionId) {
      return activeProjectLabel ?? 'DevRyan';
    }
    return resolveDisplaySessionTitle({
      title: currentSession?.title,
      fallback: 'Untitled Session',
    });
  }, [activeProjectLabel, currentSession?.title, currentSessionId]);

  const actionDirectory = React.useMemo(() => {
    return normalize(openDirectory || activeProject?.path || '');
  }, [activeProject?.path, openDirectory]);

  const activeProjectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return { id: activeProject.id, path: activeProject.path };
  }, [activeProject]);

  const lastProjectActionsContextRef = React.useRef<{
    projectRef: { id: string; path: string };
    directory: string;
  } | null>(null);

  React.useEffect(() => {
    if (!activeProjectRef || !actionDirectory) {
      return;
    }
    lastProjectActionsContextRef.current = {
      projectRef: activeProjectRef,
      directory: actionDirectory,
    };
  }, [actionDirectory, activeProjectRef]);

  const projectActionsContext = React.useMemo(() => {
    if (activeProjectRef && actionDirectory) {
      return { projectRef: activeProjectRef, directory: actionDirectory };
    }
    return lastProjectActionsContextRef.current;
  }, [actionDirectory, activeProjectRef]);


  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);
  const planTabAvailable = planModeEnabled && currentSessionId ? isSessionPlanAvailable(currentSessionId) : false;
  const showPlanTab = planTabAvailable;
  const lastPlanSessionKeyRef = React.useRef<string>('');

  // Reset plan tab availability when session changes
  React.useEffect(() => {
    if (!planModeEnabled) {
      if (useUIStore.getState().activeMainTab === 'plan') {
        useUIStore.getState().setActiveMainTab('chat');
      }
      return;
    }

    if (!currentSessionId) return;

    const sessionKey = `${currentSessionId || 'none'}:${sessionDirectory || 'none'}:${currentSession?.time?.created || 0}:${currentSession?.slug || 'none'}`;
    if (lastPlanSessionKeyRef.current !== sessionKey) {
      lastPlanSessionKeyRef.current = sessionKey;
    }

    // If plan is not available but user is on plan tab, switch them back to chat
    if (!planTabAvailable && useUIStore.getState().activeMainTab === 'plan') {
      useUIStore.getState().setActiveMainTab('chat');
    }
  }, [
    planModeEnabled,
    planTabAvailable,
    currentSession?.slug,
    currentSession?.time?.created,
    currentSessionId,
    sessionDirectory,
  ]);

  const blurActiveElement = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    if (!active) {
      return;
    }

    const tagName = active.tagName;
    const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';

    if (isInput || active.isContentEditable) {
      active.blur();
    }
  }, []);

  const handleOpenSessionSwitcher = React.useCallback(() => {
    if (isMobile) {
      blurActiveElement();
      setSessionSwitcherOpen(!isSessionSwitcherOpen);
      return;
    }
    toggleSidebar();
  }, [blurActiveElement, isMobile, isSessionSwitcherOpen, setSessionSwitcherOpen, toggleSidebar]);

  const handleHeaderNewSession = React.useCallback(() => {
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
    openNewSessionDraft();
  }, [openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

  const mobileHeaderIconButtonClass = MOBILE_HEADER_ICON_BUTTON_CLASS;

  const desktopPaddingClass = React.useMemo(() => {
    if (isDesktopApp) {
      return '';
    }
    if (!isSidebarOpen && isTabletStandalonePwa) {
      return 'pl-[5.5rem]';
    }
    return 'pl-3';
  }, [isDesktopApp, isSidebarOpen, isTabletStandalonePwa]);

  const desktopHeaderRowInsetStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!isDesktopApp || isSidebarOpen) {
      return undefined;
    }

    return { paddingLeft: DESKTOP_LEFT_CHROME_CLUSTER_WIDTH };
  }, [isDesktopApp, isSidebarOpen]);

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-12';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const webWindowControlsOverlayStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (isDesktopApp || isVSCode) {
      return undefined;
    }

    return {
      paddingLeft: isTabletStandalonePwa && !isSidebarOpen
        ? 'max(calc(0.75rem + var(--oc-wco-left-inset, 0px)), 5.5rem)'
        : 'calc(0.75rem + var(--oc-wco-left-inset, 0px))',
      paddingRight: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
      minHeight: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
      height: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
    };
  }, [isDesktopApp, isSidebarOpen, isTabletStandalonePwa, isVSCode]);

  const updateHeaderHeight = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const height = headerRef.current?.getBoundingClientRect().height;
    if (height) {
      document.documentElement.style.setProperty('--oc-header-height', `${height}px`);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    updateHeaderHeight();

    const node = headerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return () => { };
    }

    let rafId = 0;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateHeaderHeight();
      });
    };

    const observer = new ResizeObserver(scheduleUpdate);

    observer.observe(node);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [updateHeaderHeight]);

  useEffect(() => {
    updateHeaderHeight();
  }, [updateHeaderHeight, isMobile, macosHeaderSizeClass]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  const tabs: TabConfig[] = React.useMemo(() => {
    if (isMobile) {
      const base: TabConfig[] = [
        { id: 'chat', label: t('layout.mainTab.chat'), icon: RiChat4Line },
      ];

      if (showPlanTab) {
        base.push({ id: 'plan', label: t('layout.mainTab.plan'), icon: PlanDocumentIcon });
      }

      base.push(
        { id: 'diff', label: t('layout.mainTab.diff'), icon: 'diff' },
        { id: 'terminal', label: t('layout.mainTab.terminal'), icon: TerminalPanelIcon },
      );

      return base;
    }

    // Desktop: no tabs in header
    return [];
  }, [isMobile, showPlanTab, t]);

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  useEffect(() => {
    if (!isMobile && (activeMainTab === 'git' || activeMainTab === 'terminal' || activeMainTab === 'diff' || activeMainTab === 'files')) {
      setActiveMainTab('chat');
    }
  }, [activeMainTab, isMobile, setActiveMainTab]);

  const mobileServicesTabItems = React.useMemo<SortableTabsStripItem[]>(() => {
    return [
      { id: 'usage', label: t('layout.services.usage'), icon: <RiBarChartLine className="h-3.5 w-3.5" /> },
      { id: 'mcp', label: 'MCP', icon: <RiCommandLine className="h-3.5 w-3.5" /> },
    ];
  }, [t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasModifier(e) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= tabs.length) {
          e.preventDefault();
          setActiveMainTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs, setActiveMainTab]);

  const SidebarLeftExpandIcon = (props: React.ComponentProps<typeof SidebarLeftIcon>) => (
    <SidebarLeftIcon {...props} chevronDirection="right" />
  );

  const renderTab = (tab: TabConfig) => {
    const isActive = activeMainTab === tab.id;
    const isDiffTab = tab.icon === 'diff';
    const Icon = isDiffTab ? null : (tab.icon as RemixiconComponentType);
    const isChatTab = tab.id === 'chat';

    const renderIcon = (iconSize: number) => {
      if (isDiffTab) {
        return <DiffIcon size={iconSize} />;
      }
      return Icon ? <Icon size={iconSize} /> : null;
    };

    const tabButton = (
      <button
        type="button"
        onClick={() => setActiveMainTab(tab.id)}
          className={cn(
            'relative flex h-8 items-center gap-2 px-3 rounded-lg typography-ui-label font-medium transition-colors',
            isActive
              ? 'app-region-no-drag bg-interactive-selection text-interactive-selection-foreground shadow-none'
              : 'app-region-no-drag text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isChatTab && !isMobile && 'min-w-[100px] justify-center'
          )}
        aria-label={tab.label}
        aria-selected={isActive}
        role="tab"
      >
        {isMobile ? (
          renderIcon(20)
        ) : (
          <>
            {renderIcon(16)}
            <span className="header-tab-label">{tab.label}</span>
          </>
        )}

        {tab.badge !== undefined && tab.badge > 0 && (
          <span className="header-tab-badge typography-micro text-status-info font-medium">
            {tab.badge}
          </span>
        )}
      </button>
    );

    return <React.Fragment key={tab.id}>{tabButton}</React.Fragment>;
  };

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 w-full select-none items-center',
        isDesktopApp ? 'pr-[calc(11rem+var(--oc-wco-right-inset,0px))]' : 'pr-3',
        desktopPaddingClass,
        macosHeaderSizeClass
      )}
      style={webWindowControlsOverlayStyle}
      role="tablist"
      aria-label={t('header.navigation.mainAria')}
    >
      {!isDesktopApp ? (
        <HeaderIconActionButton
          visible={!isSidebarOpen}
          title={t('header.actions.openSessionsWithShortcut', { shortcut: shortcutLabel('toggle_sidebar') })}
          ariaLabel={t('header.actions.openSessionsAria')}
          onClick={handleOpenSessionSwitcher}
          className={`${DESKTOP_HEADER_ICON_BUTTON_CLASS} shrink-0`}
          Icon={SidebarLeftExpandIcon}
        />
      ) : null}

      <div
        className={cn(
          'flex min-w-0 w-full flex-1 items-center gap-3',
          isDesktopApp && isSidebarOpen && 'pl-3',
          !isDesktopApp && !isSidebarOpen && 'pl-3',
        )}
        style={desktopHeaderRowInsetStyle}
      >
        <div className="flex min-w-0 flex-1 items-center justify-start gap-2 overflow-hidden">
          {!isLeftSidebarOpen ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t('header.actions.newSessionAria')}
                  onClick={handleHeaderNewSession}
                  className={cn(DESKTOP_HEADER_ICON_BUTTON_CLASS, 'shrink-0')}
                >
                  <RiChatNewLine className="h-[18px] w-[18px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('header.actions.newSessionWithShortcut', { shortcut: shortcutLabel('new_chat') })}</p>
              </TooltipContent>
            </Tooltip>
          ) : null}
          {!isNewSessionDraftOpen ? (
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 truncate text-left typography-ui-label text-[14px] font-normal leading-tight text-foreground">
                {currentSessionTitle}
              </div>
              {currentSessionId ? (
                <ActiveSessionChangesBadge
                  sessionId={currentSessionId}
                  directory={sessionDirectory || undefined}
                />
              ) : null}
            </div>
          ) : null}
          {tabs.length > 0 && (
            <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-muted)]/50 p-1">
              {tabs.map((tab) => renderTab(tab))}
            </div>
          )}
        </div>

        <div className="app-region-no-drag pointer-events-auto relative ml-auto flex shrink-0 items-center gap-1.5">
          {projectActionsContext && (
            <ProjectActionsButton
              projectRef={projectActionsContext.projectRef}
              directory={projectActionsContext.directory}
            />
          )}
          <OpenInAppButton directory={actionDirectory} />
        </div>
      </div>
    </div>
  );

  const renderMobile = () => (
    <div className="app-region-drag relative flex items-center gap-2 px-3 py-2 select-none">
      <div className="flex items-center gap-2 shrink-0">
        {/* Use drawer toggle when onToggleLeftDrawer is provided, otherwise use legacy session switcher */}
        {onToggleLeftDrawer ? (
          <button
            type="button"
            onClick={onToggleLeftDrawer}
            className={cn(
              mobileHeaderIconButtonClass,
              leftDrawerOpen && 'bg-interactive-selection text-interactive-selection-foreground'
            )}
            aria-label={leftDrawerOpen ? t('header.actions.closeSessionsAria') : t('header.actions.openSessionsAria')}
          >
            <SidebarLeftIcon className="h-5 w-5" chevronDirection={leftDrawerOpen ? 'left' : 'right'} />
          </button>
        ) : isSessionSwitcherOpen ? (
          <button
            type="button"
            onClick={() => setSessionSwitcherOpen(false)}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label={t('header.actions.backAria')}
          >
            <RiArrowLeftSLine className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleOpenSessionSwitcher}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label={t('header.actions.openSessionsAria')}
          >
            <RiPlayListAddLine className="h-5 w-5" />
          </button>
        )}

        {isSessionSwitcherOpen && (
          <span className="typography-ui-label font-semibold text-foreground">{t('header.sessions.title')}</span>
        )}
      </div>

      {/* Hide tabs and right-side buttons when sessions sidebar is open */}
      {!isSessionSwitcherOpen && (
        <>
          <div className="app-region-no-drag flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-hidden touch-pan-x overscroll-x-contain">
              <div className="flex w-max items-center gap-1 pr-1">
                <div
                  className="flex items-center gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 p-0.5"
                  role="tablist"
                  aria-label={t('header.navigation.mainAria')}
                >
                  {tabs.map((tab) => {
                    const isActive = activeMainTab === tab.id;
                    const isDiffTab = tab.icon === 'diff';
                    const Icon = isDiffTab ? null : (tab.icon as RemixiconComponentType);
                    return (
                      <Tooltip key={tab.id}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => {
                              if (isMobile) {
                                blurActiveElement();
                              }
                              setActiveMainTab(tab.id);
                            }}
                            aria-label={tab.label}
                            aria-selected={isActive}
                            role="tab"
                            className={cn(
                              mobileHeaderIconButtonClass,
                              'relative rounded-lg',
                              isActive && 'bg-interactive-selection text-interactive-selection-foreground'
                            )}
                          >
                            {isDiffTab ? (
                              <DiffIcon className="h-5 w-5" />
                            ) : Icon ? (
                              <Icon className="h-5 w-5" />
                            ) : null}
                            {tab.badge !== undefined && tab.badge > 0 && (
                              <span className="absolute -top-1 -right-1 text-[10px] font-semibold text-primary">
                                {tab.badge}
                              </span>
                            )}
                            {tab.showDot && (
                              <span
                                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary"
                                aria-label={t('header.changes.availableAria')}
                              />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{tab.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {projectActionsContext && (
              <ProjectActionsButton
                projectRef={projectActionsContext.projectRef}
                directory={projectActionsContext.directory}
                compact
                allowMobile
                className="h-9"
              />
            )}

            {/* Mobile Services Menu (Usage + MCP) */}
            <DropdownMenu
              open={isMobileRateLimitsOpen}
              onOpenChange={(open) => {
                setIsMobileRateLimitsOpen(open);
                if (open && quotaResults.length === 0) {
                  fetchAllQuotas();
                }
              }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('header.services.viewAria')}
                      className={mobileHeaderIconButtonClass}
                    >
                      <RiServerLine className="h-[18px] w-[18px]" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('header.services.title')}</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                sideOffset={0}
                className="h-dvh w-[100vw] max-h-none rounded-none border-0 p-0 overflow-hidden"
              >
                <div className="flex h-full flex-col bg-[var(--surface-elevated)]">
          <div className="sticky top-0 z-20 bg-[var(--surface-elevated)] px-2 py-px">
                    <div className="flex items-center justify-between gap-2 px-3 py-0">
                      <div className="h-8 min-w-0 flex-1">
                        <SortableTabsStrip
                          items={mobileServicesTabItems}
                          activeId={mobileServicesTab}
                          onSelect={(tabID) => {
                            const value = tabID as 'usage' | 'mcp';
                            setMobileServicesTab(value);
                            if (value === 'usage' && quotaResults.length === 0) {
                              fetchAllQuotas();
                            }
                          }}
                          layoutMode="fit"
                          variant="active-pill"
                          activePillInsetClassName="gap-0.5 px-px py-0"
                          activePillButtonClassName="h-7 text-xs"
                          activePillLowercase={false}
                          className="h-full"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsMobileRateLimitsOpen(false)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover"
                        aria-label={t('header.services.closeAria')}
                      >
                        <RiCloseLine className="h-5 w-5" />
                      </button>
                    </div>
                  </div>

                  {mobileServicesTab === 'mcp' && (
                    <McpDropdownContent active={isMobileRateLimitsOpen && mobileServicesTab === 'mcp'} />
                  )}

                  {mobileServicesTab === 'usage' && (
                    <div className="flex-1 overflow-y-auto overflow-x-hidden pb-[calc(4rem+env(safe-area-inset-bottom))]">
                      {hasRateLimits ? (
                        <UsageProviderTabs
                          groups={rateLimitGroups}
                          activeProviderId={resolvedActiveUsageProviderId}
                          onSelectProvider={setActiveUsageProviderId}
                          mobile
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
                        mobile
                      />
                    </div>
                  )}
                  <DevShutdownMenuItem />
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            {onToggleRightDrawer ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleRightDrawer}
                    className={cn(
                      mobileHeaderIconButtonClass,
                      'relative',
                      rightDrawerOpen && 'bg-interactive-selection text-interactive-selection-foreground'
                    )}
                    aria-label={rightDrawerOpen ? 'Close Git Sidebar' : 'Open Git Sidebar'}
                  >
                    <SidebarRightIcon className="h-5 w-5" chevronDirection={rightDrawerOpen ? 'right' : 'left'} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{rightDrawerOpen ? 'Close Git Sidebar' : 'Open Git Sidebar'}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </>
      )}
    </div>
  );

  const headerClassName = cn(
    'header-safe-area relative z-10 border-b border-border/40',
    'bg-background'
  );

  return (
    <header
      ref={headerRef}
      className={headerClassName}
      style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
    >
      {isMobile ? renderMobile() : renderDesktop()}
    </header>
  );
};
