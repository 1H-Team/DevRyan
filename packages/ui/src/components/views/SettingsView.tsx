import React from 'react';
import { cn, isMacOS } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { usePluginsStore } from '@/stores/usePluginsStore';
import {
  RiArrowLeftSLine,
  RiListUnordered,
  RiLogoutBoxRLine,
} from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import type { OpenChamberSection } from '@/components/sections/openchamber/types';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { ConfigApplyControls } from '@/components/views/config-apply/ConfigApplyControls';
import {
  SETTINGS_PAGE_METADATA,
  getSettingsPageMeta,
  isBehaviorSettingsAlias,
  resolveSettingsSlug,
  type SettingsPageSlug,
  type SettingsRuntimeContext,
  type SettingsPageMeta,
} from '@/lib/settings/metadata';
import {
  SETTINGS_NAV_SECTIONS,
  getSettingsDestinationFallbackSlug,
  getSettingsNavDestination,
} from '@/lib/settings/navigation';
import { getSettingsNavIcon } from '@/lib/settings/navigation-icons';
import {
  getSettingsBackButtonHeaderClassName,
  getSettingsBackButtonHeaderContentClassName,
  getSettingsNavScrollClassName,
  getSettingsNavButtonClassName,
  getSettingsPageSidebarClassName,
} from './SettingsView.styles';
import {
  resolveMobileSettingsBackStage,
  type MobileStage,
} from './SettingsView.mobileNavigation';
import { canAccessSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import { SettingsPagePermissionBoundary } from '@/lib/settings/permission-context';
import { setStoragePrincipal } from '@/stores/utils/safeStorage';
import {
  CapabilityMutationBoundary,
  CapabilitySettingsWorkspace,
} from './CapabilitySettingsWorkspace';
import { SettingsSectionTabs } from './SettingsSectionTabs';
import {
  canAccessSettingsDestination,
  isBotCapabilitySettingsSlug,
} from './SettingsView.access';
import { SettingsLoadFallback } from './SettingsLoadFallback';
import { usePreparedSettingsNavigation } from './usePreparedSettingsNavigation';
import {
  PreparedAboutSettings,
  PreparedAgentsPage,
  PreparedAgentsSidebar,
  PreparedBehaviorPage,
  PreparedBotsPage,
  PreparedBugReportsPage,
  PreparedCommandsPage,
  PreparedCommandsSidebar,
  PreparedGitPage,
  PreparedMagicPromptsPage,
  PreparedMagicPromptsSidebar,
  PreparedMcpPage,
  PreparedMcpSidebar,
  PreparedOpenChamberPage,
  PreparedPluginsPage,
  PreparedPluginsSidebar,
  PreparedProjectsPage,
  PreparedProjectsSidebar,
  PreparedProvidersPage,
  PreparedProvidersSidebar,
  PreparedRemoteInstancesPage,
  PreparedRemoteInstancesSidebar,
  PreparedSkillsPage,
  PreparedSkillsSidebar,
  PreparedUsagePage,
  PreparedUsageSidebar,
  PreparedUserManagementPage,
  preloadSettingsSection,
} from './settingsSectionLoaders';
const SettingsSectionBoundary: React.FC<React.PropsWithChildren> = ({ children }) => (
  <ErrorBoundary>
    <React.Suspense fallback={<SettingsLoadFallback />}>
      {children}
    </React.Suspense>
  </ErrorBoundary>
);

const CodingAgentSettingsAccessRequired: React.FC = () => (
  <div className="flex h-full items-center justify-center p-6 text-center">
    <div className="max-w-sm">
      <div className="typography-ui-label font-semibold text-foreground">Coding Agents settings access required</div>
      <p className="mt-1 typography-ui text-muted-foreground">
        Your settings policy does not include this Coding Agents section.
      </p>
    </div>
  </div>
);

// Same constraints as main sidebar
const SETTINGS_NAV_MIN_WIDTH = 176;
const SETTINGS_NAV_MAX_WIDTH = 280;
const SETTINGS_NAV_RESIZE_STEP = 8;

function clampSettingsNavWidth(width: number): number {
  return Math.min(SETTINGS_NAV_MAX_WIDTH, Math.max(SETTINGS_NAV_MIN_WIDTH, width));
}

interface SettingsViewProps {
  onClose?: () => void;
  /** Force mobile layout regardless of device detection */
  forceMobile?: boolean;
}

function buildRuntimeContext(isDesktop: boolean, isManaged: boolean): SettingsRuntimeContext {

  const isWeb = !isDesktop && isWebRuntime();
  return {  isWeb, isDesktop, isManaged };
}

function isPageAvailable(page: SettingsPageMeta, ctx: SettingsRuntimeContext): boolean {
  if (!page.isAvailable) {
    return true;
  }
  return page.isAvailable(ctx);
}

const SettingsHome: React.FC<{
  onOpen: (slug: SettingsPageSlug) => void;
  pendingSlug?: SettingsPageSlug | null;
}> = ({ onOpen, pendingSlug = null }) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const providersDestinationSlug: SettingsPageSlug = canAccessSettingsDestination(principal, 'providers')
    ? 'providers'
    : 'usage';
  const skillsCard = canAccessSettingsPage(principal, 'skills.catalog')
    ? { slug: 'skills.catalog' as const, title: t('settings.view.home.cards.skillsCatalog.title'), description: t('settings.view.home.cards.skillsCatalog.description') }
    : { slug: 'skills.installed' as const, title: 'Skills', description: 'Review the skills assigned to your Bots.' };
  const cards = ([
    { slug: 'users', title: 'User Management', description: 'Manage roles, projects, GitHub accounts, branch grants, and activity.' },
    { slug: 'appearance', title: 'Appearance', description: 'Theme, typography, spacing, and interface preferences.' },
    { slug: 'sessions', title: 'Sessions', description: 'Defaults, retention, and session behavior.' },
    { slug: 'bots', title: t('settings.page.bots.title'), description: t('settings.page.bots.description') },
    { slug: 'notifications', title: 'Notifications', description: 'Choose when and how DevRyan notifies you.' },
    { slug: providersDestinationSlug, title: t('settings.view.home.cards.providers.title'), description: t('settings.view.home.cards.providers.description') },
    { slug: 'agents', title: t('settings.view.home.cards.agents.title'), description: t('settings.view.home.cards.agents.description') },
    skillsCard,
    { slug: 'mcp', title: t('settings.view.home.cards.mcp.title'), description: t('settings.view.home.cards.mcp.description') },
  ] satisfies Array<{ slug: SettingsPageSlug; title: string; description: string }>).filter(
    (card) => canAccessSettingsDestination(principal, card.slug),
  );
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6 space-y-6">
        <div className="space-y-1">
          <h1 className="typography-ui-header font-semibold text-foreground">{t('settings.view.home.title')}</h1>
          <p className="typography-ui text-muted-foreground">{t('settings.view.home.description')}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {cards.map((card) => (
            <button
              key={card.slug}
              type="button"
              onClick={() => onOpen(card.slug)}
              onPointerEnter={() => void preloadSettingsSection(card.slug).catch(() => undefined)}
              onPointerDown={() => void preloadSettingsSection(card.slug).catch(() => undefined)}
              onFocus={() => void preloadSettingsSection(card.slug).catch(() => undefined)}
              aria-busy={pendingSlug === card.slug || undefined}
              className={cn(
                'rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left',
                'hover:bg-[var(--interactive-hover)] transition-colors'
              )}
            >
              <div className="flex items-center gap-2 typography-ui-label text-foreground">
                <span>{card.title}</span>
                {pendingSlug === card.slug ? (
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />
                ) : null}
              </div>
              <div className="typography-micro text-muted-foreground/70">{card.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export const SettingsView: React.FC<SettingsViewProps> = ({ onClose, forceMobile }) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const deviceInfo = useDeviceInfo();
  const isMobile = forceMobile ?? deviceInfo.isMobile;

  const settingsPageRaw = useUIStore((state) => state.settingsPage);
  const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const isBehaviorAliasPage = isBehaviorSettingsAlias(settingsPageRaw);
  const requestedSettingsSlug = resolveSettingsSlug(settingsPageRaw);
  const [mobileStage, setMobileStage] = React.useState<MobileStage>('nav');
  const autoNavSlugRef = React.useRef<string | null>(null);

  const [navWidth, setNavWidth] = React.useState(216);
  const [hasManuallyResized, setHasManuallyResized] = React.useState(false);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(navWidth);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const isDesktopApp = React.useMemo(() => {
    return isDesktopShell();
  }, []);
  const isMacPlatform = React.useMemo(() => isMacOS(), []);
  const shouldAvoidMacTrafficLights = isDesktopApp && isMacPlatform;

  // keep platform check available for future window chrome tweaks

  const runtimeCtx = React.useMemo(
    () => buildRuntimeContext(isDesktopApp, principal.scope === 'managed'),
    [isDesktopApp, principal.scope],
  );

  const handleLogout = React.useCallback(async () => {
    const response = await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-DevRyan-CSRF': '1' },
    });
    const payload = await response.json().catch(() => ({})) as { localSessionCleared?: boolean };
    if (!response.ok && payload.localSessionCleared !== true) return;
    setStoragePrincipal('anonymous');
    window.location.reload();
  }, []);

  const visiblePages = React.useMemo(() => {
    return SETTINGS_PAGE_METADATA
      .filter((page) => page.slug !== 'home')
      .filter((page) => canAccessSettingsDestination(principal, page.slug))
      .filter((page) => isPageAvailable(page, runtimeCtx))
      ;
  }, [runtimeCtx, principal]);

  React.useEffect(() => {
    if (requestedSettingsSlug === 'home' || visiblePages.some((page) => page.slug === requestedSettingsSlug)) {
      return;
    }

    const fallbackSlug = getSettingsDestinationFallbackSlug(
      requestedSettingsSlug,
      new Set(visiblePages.map((page) => page.slug)),
    );
    setSettingsPage(fallbackSlug ?? 'home');
    if (!fallbackSlug) setMobileStage('nav');
  }, [requestedSettingsSlug, setSettingsPage, visiblePages]);

  const groupedVisiblePages = React.useMemo(() => {
    const visiblePageBySlug = new Map(visiblePages.map((page) => [page.slug, page]));

    return SETTINGS_NAV_SECTIONS
      .map((section) => ({
        ...section,
        destinations: section.destinations
          .map((destination) => ({
            ...destination,
            pages: destination.slugs
              .map((slug) => visiblePageBySlug.get(slug))
              .filter((page): page is SettingsPageMeta => Boolean(page)),
          }))
          .filter((destination) => destination.pages.length > 0),
      }))
      .filter((section) => section.destinations.length > 0);
  }, [visiblePages]);
  const preloadSlugs = React.useMemo(
    () => visiblePages.map((page) => page.slug),
    [visiblePages],
  );
  const { displayedSlug: settingsSlug, pendingSlug, prepareAndCommit } = usePreparedSettingsNavigation({
    requestedSlug: requestedSettingsSlug,
    preloadSlugs,
  });

  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => {
      if (!hasManuallyResized) {
        const proportionalWidth = clampSettingsNavWidth(Math.floor(window.innerWidth * 0.12));
        setNavWidth(proportionalWidth);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [hasManuallyResized]);

  React.useEffect(() => {
    if (!isResizing) return;
    const handlePointerMove = (event: PointerEvent) => {
      const delta = event.clientX - startXRef.current;
      const nextWidth = clampSettingsNavWidth(startWidthRef.current + delta);
      setNavWidth(nextWidth);
      setHasManuallyResized(true);
    };
    const handlePointerUp = () => setIsResizing(false);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isResizing]);

  const handlePointerDown = (event: React.PointerEvent) => {
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = navWidth;
    event.preventDefault();
  };

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? SETTINGS_NAV_RESIZE_STEP * 4 : SETTINGS_NAV_RESIZE_STEP;
    let nextWidth: number;

    switch (event.key) {
      case 'ArrowLeft':
        nextWidth = navWidth - step;
        break;
      case 'ArrowRight':
        nextWidth = navWidth + step;
        break;
      case 'Home':
        nextWidth = SETTINGS_NAV_MIN_WIDTH;
        break;
      case 'End':
        nextWidth = SETTINGS_NAV_MAX_WIDTH;
        break;
      default:
        return;
    }

    event.preventDefault();
    setNavWidth(clampSettingsNavWidth(nextWidth));
    setHasManuallyResized(true);
  };

  // Load stores when project changes or when a page becomes active.
  React.useEffect(() => {
    if (!isSettingsDialogOpen) {
      return;
    }

    if (settingsSlug === 'agents') {
      void useAgentsStore.getState().loadAgents();
      return;
    }
    if (settingsSlug === 'commands') {
      void useCommandsStore.getState().loadCommands();
      return;
    }
    if (settingsSlug === 'mcp') {
      if (!canAccessSettingsPage(principal, settingsSlug)) return;
      void useMcpConfigStore.getState().loadMcpConfigs();
      return;
    }
    if (settingsSlug === 'skills.installed' || settingsSlug === 'skills.catalog') {
      if (settingsSlug === 'skills.installed'
        && !canAccessSettingsPage(principal, settingsSlug)) return;
      void useSkillsStore.getState().loadSkills();
      void useSkillsCatalogStore.getState().loadCatalog();
      return;
    }
    if (settingsSlug === 'plugins') {
      void usePluginsStore.getState().loadPlugins();
      void usePluginsStore.getState().loadSlimStatus();
    }
  }, [activeProjectId, isSettingsDialogOpen, principal, settingsSlug]);

  React.useEffect(() => {
    if (!isBehaviorAliasPage) {
      return;
    }
    useAgentsStore.getState().setSelectedAgent(null);
    setSettingsPage('agents');
  }, [isBehaviorAliasPage, setSettingsPage]);

  const commitOpenPage = React.useCallback((slug: SettingsPageSlug) => {
    setSettingsPage(slug);
    autoNavSlugRef.current = slug;
    if (!isMobile) {
      return;
    }
    const def = getSettingsPageMeta(slug);
    if (!def || def.slug === 'home') {
      setMobileStage('nav');
      return;
    }
    setMobileStage(def.kind === 'split' ? 'page-sidebar' : 'page-content');
  }, [isMobile, setSettingsPage]);

  const openPage = React.useCallback((slug: SettingsPageSlug) => {
    prepareAndCommit(slug, () => commitOpenPage(slug));
  }, [commitOpenPage, prepareAndCommit]);

  const commitSettingsSectionTab = React.useCallback((slug: SettingsPageSlug) => {
    setSettingsPage(slug);
    autoNavSlugRef.current = slug;
    if (!isMobile) return;

    if (slug === 'remote-instances') {
      setMobileStage('page-sidebar');
      return;
    }

    const page = getSettingsPageMeta(slug);
    if (page?.kind === 'single') {
      setMobileStage('page-content');
      return;
    }

    setMobileStage((stage) => stage === 'page-content' ? 'page-content' : 'page-sidebar');
  }, [isMobile, setSettingsPage]);

  const selectSettingsSectionTab = React.useCallback((slug: SettingsPageSlug) => {
    prepareAndCommit(slug, () => commitSettingsSectionTab(slug));
  }, [commitSettingsSectionTab, prepareAndCommit]);

  const activePageMeta = React.useMemo(() => {
    return getSettingsPageMeta(settingsSlug);
  }, [settingsSlug]);

  const settingsAudience = 'coding-agents' as const;

  // Nav is always open (collapsed state removed)

  const openChamberSectionBySlug: Partial<Record<SettingsPageSlug, OpenChamberSection>> = React.useMemo(() => ({
    appearance: 'visual',
    chat: 'chat',
    shortcuts: 'shortcuts',
    sessions: 'sessions',
    notifications: 'notifications',
    voice: 'voice',
    tunnel: 'tunnel',
  }), []);

  const getPageTitle = React.useCallback((slug: SettingsPageSlug): string => {
    switch (slug) {
      case 'users':
        return 'User Management';
      case 'bug-reports':
        return t('settings.page.bugReports.title');
      case 'projects':
        return t('settings.page.projects.title');
      case 'remote-instances':
        return t('settings.page.remoteInstances.title');
      case 'providers':
        return t('settings.page.providers.title');
      case 'usage':
        return t('settings.page.usage.title');
      case 'bots':
        return t('settings.page.bots.title');
      case 'agents':
        return t('settings.page.agents.title');
      case 'behavior':
        return t('settings.page.behavior.title');
      case 'commands':
        return t('settings.page.commands.title');
      case 'mcp':
        return t('settings.page.mcp.title');
      case 'skills.installed':
        return t('settings.page.skills.title');
      case 'skills.catalog':
        return t('settings.page.skillsCatalog.title');
      case 'plugins':
        return t('settings.page.plugins.title');
      case 'git':
        return t('settings.page.git.title');
      case 'appearance':
        return t('settings.page.appearance.title');
      case 'chat':
        return t('settings.page.chat.title');
      case 'shortcuts':
        return t('settings.page.shortcuts.title');
      case 'sessions':
        return t('settings.page.sessions.title');
      case 'magic-prompts':
        return t('settings.page.magicPrompts.title');
      case 'notifications':
        return t('settings.page.notifications.title');
      case 'voice':
        return t('settings.page.voice.title');
      case 'tunnel':
        return t('settings.page.tunnel.title');
      case 'about':
        return t('settings.openchamber.about.title');
      case 'home':
      default:
        return t('settings.view.home.title');
    }
  }, [t]);

  const getDestinationTitle = React.useCallback((slug: SettingsPageSlug): string => {
    const destination = getSettingsNavDestination(slug);
    return destination?.labelKey ? t(destination.labelKey) : getPageTitle(slug);
  }, [getPageTitle, t]);

  const renderSettingsSectionTabs = React.useCallback((
    content: React.ReactNode,
    idPrefix: string,
  ): React.ReactNode => {
    const destination = getSettingsNavDestination(settingsSlug);
    if (!destination || destination.slugs.length <= 1) return content;

    const tabs = destination.slugs
      .filter((slug) => visiblePages.some((page) => page.slug === slug))
      .map((slug) => ({ slug, label: getPageTitle(slug) }));

    return (
      <SettingsSectionTabs
        activeSlug={settingsSlug}
        ariaLabel={t(destination.id === 'remote-connections'
          ? 'settings.remoteConnections.tabs.aria'
          : 'settings.providers.tabs.aria')}
        idPrefix={idPrefix}
        onTabChange={selectSettingsSectionTab}
        pendingSlug={pendingSlug}
        tabs={tabs}
      >
        {content}
      </SettingsSectionTabs>
    );
  }, [getPageTitle, pendingSlug, selectSettingsSectionTab, settingsSlug, t, visiblePages]);

  const renderUnavailable = React.useCallback(() => {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="typography-ui-header font-semibold text-foreground">{t('settings.view.unavailable.title')}</div>
          <p className="typography-ui text-muted-foreground mt-1">{t('settings.view.unavailable.description')}</p>
        </div>
      </div>
    );
  }, [t]);

  const renderPageSidebar = React.useCallback((slug: SettingsPageSlug, opts: { onItemSelect?: () => void }) => {
    if (isBotCapabilitySettingsSlug(slug) && !canAccessSettingsPage(principal, slug)) {
      return <CodingAgentSettingsAccessRequired />;
    }
    switch (slug) {
      case 'projects':
        return <PreparedProjectsSidebar onItemSelect={opts.onItemSelect} />;
      case 'remote-instances':
        return <PreparedRemoteInstancesSidebar onItemSelect={opts.onItemSelect} />;
      case 'agents':
        return <PreparedAgentsSidebar onItemSelect={opts.onItemSelect} />;
      case 'commands':
        return <PreparedCommandsSidebar onItemSelect={opts.onItemSelect} />;
      case 'mcp':
        return <PreparedMcpSidebar onItemSelect={opts.onItemSelect} />;
      case 'skills.installed':
        return <PreparedSkillsSidebar onItemSelect={opts.onItemSelect} />;
      case 'plugins':
        return <PreparedPluginsSidebar onItemSelect={opts.onItemSelect} />;
      case 'providers':
        return <PreparedProvidersSidebar onItemSelect={opts.onItemSelect} />;
      case 'usage':
        return <PreparedUsageSidebar onItemSelect={opts.onItemSelect} />;
      case 'magic-prompts':
        return <PreparedMagicPromptsSidebar onItemSelect={opts.onItemSelect} />;
      default:
        return null;
    }
  }, [principal]);

  const renderRawPageContent = React.useCallback((slug: SettingsPageSlug) => {
    const meta = getSettingsPageMeta(slug);
    if (meta && !isPageAvailable(meta, runtimeCtx)) {
      return renderUnavailable();
    }
    if (isBotCapabilitySettingsSlug(slug) && !canAccessSettingsPage(principal, slug)) {
      return <CodingAgentSettingsAccessRequired />;
    }

    switch (slug) {
      case 'home':
        return <SettingsHome onOpen={openPage} pendingSlug={pendingSlug} />;
      case 'users':
        return <PreparedUserManagementPage />;
      case 'bug-reports':
        return <PreparedBugReportsPage />;
      case 'projects':
        return <PreparedProjectsPage />;
      case 'remote-instances':
        return <PreparedRemoteInstancesPage />;
      case 'agents':
        return <PreparedAgentsPage />;
      case 'behavior':
        return <PreparedBehaviorPage />;
      case 'commands':
        return <PreparedCommandsPage />;
      case 'mcp':
        return <PreparedMcpPage />;
      case 'skills.installed':
        return <PreparedSkillsPage view="installed" />;
      case 'skills.catalog':
        return <PreparedSkillsPage view="catalog" />;
      case 'plugins':
        return <PreparedPluginsPage />;
      case 'providers':
        return <PreparedProvidersPage />;
      case 'usage':
        return <PreparedUsagePage />;
      case 'bots':
        return <PreparedBotsPage />;
      case 'magic-prompts':
        return <PreparedMagicPromptsPage />;
      case 'git':
        return <PreparedGitPage />;
      case 'about':
        return (
          <div className="h-full overflow-auto">
            <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
              <PreparedAboutSettings />
            </div>
          </div>
        );
      case 'appearance':
      case 'chat':
      case 'shortcuts':
      case 'sessions':
      case 'notifications':
      case 'voice':
      case 'tunnel': {
        const section = openChamberSectionBySlug[slug] ?? 'visual';
        return <PreparedOpenChamberPage section={section} />;
      }
      default:
        return <SettingsHome onOpen={openPage} pendingSlug={pendingSlug} />;
    }
  }, [openChamberSectionBySlug, openPage, pendingSlug, principal, renderUnavailable, runtimeCtx]);

  const renderPageContent = React.useCallback((slug: SettingsPageSlug) => {
    const content = renderRawPageContent(slug);
    if (slug === 'skills.installed' || slug === 'mcp') {
      return (
        <CapabilityMutationBoundary slug={slug} audience={settingsAudience}>
          {content}
        </CapabilityMutationBoundary>
      );
    }
    return <SettingsPagePermissionBoundary slug={slug}>{content}</SettingsPagePermissionBoundary>;
  }, [renderRawPageContent, settingsAudience]);

  // Mobile: if opened via deep-link / palette to a non-home page, jump into it once.
  React.useEffect(() => {
    if (!isMobile) {
      return;
    }
    if (mobileStage !== 'nav') {
      return;
    }
    if (settingsSlug === 'home') {
      return;
    }
    if (autoNavSlugRef.current === settingsSlug) {
      return;
    }
    const def = getSettingsPageMeta(settingsSlug);
    if (!def || def.slug === 'home') {
      return;
    }
    autoNavSlugRef.current = settingsSlug;
    setMobileStage(isBehaviorAliasPage ? 'page-content' : (def.kind === 'split' ? 'page-sidebar' : 'page-content'));
  }, [isBehaviorAliasPage, isMobile, mobileStage, settingsSlug]);

  const showBackButton = isMobile && mobileStage !== 'nav';
  const showFullPageBackButton = !isMobile && Boolean(onClose);
  const reserveSettingsNavTopChrome = !showFullPageBackButton && shouldAvoidMacTrafficLights;

  const handleBack = React.useCallback(() => {
    setMobileStage((stage) => resolveMobileSettingsBackStage(stage, activePageMeta));
  }, [activePageMeta]);

  const handleOpenPageSidebar = React.useCallback(() => {
    setMobileStage('page-sidebar');
  }, []);

  const renderSettingsNav = () => {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {showFullPageBackButton && (
          <div
            className={cn(
              getSettingsBackButtonHeaderClassName({ avoidMacTrafficLights: shouldAvoidMacTrafficLights }),
              'backdrop-blur-sm',
              'bg-sidebar/95'
            )}
          >
            <div className={getSettingsBackButtonHeaderContentClassName()}>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('settings.view.actions.back')}
                className={cn(
                  getSettingsNavButtonClassName(false),
                  'text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50'
                )}
              >
                <RiArrowLeftSLine className="h-4 w-4 shrink-0" />
                <span className="typography-ui-label font-normal truncate">{t('settings.view.actions.back')}</span>
              </button>
            </div>
          </div>
        )}
        {/* Scrollable nav items */}
        <div className={getSettingsNavScrollClassName({ reserveTopChrome: reserveSettingsNavTopChrome })}>
          <div className={cn(
            'flex flex-col gap-3 pb-2 px-2',
            reserveSettingsNavTopChrome ? 'pt-0' : showFullPageBackButton ? 'pt-2' : 'pt-4'
          )}>
            {groupedVisiblePages.map((section) => (
              <div key={section.labelKey} className="space-y-0.5">
                <div className="px-2 pb-1 typography-micro text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t(section.labelKey)}
                </div>
                {section.destinations.map((destination) => {
                  const selected = destination.slugs.includes(settingsSlug);
                  const selectedPage = destination.pages.find((page) => page.slug === settingsSlug);
                  const targetPage = selectedPage ?? destination.pages[0];
                  const Icon = getSettingsNavIcon(destination.iconSlug);
                  if (!Icon) return null;

                  return (
                    <Tooltip key={destination.id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => openPage(targetPage.slug)}
                          onPointerEnter={() => void preloadSettingsSection(targetPage.slug).catch(() => undefined)}
                          onPointerDown={() => void preloadSettingsSection(targetPage.slug).catch(() => undefined)}
                          onFocus={() => void preloadSettingsSection(targetPage.slug).catch(() => undefined)}
                          aria-busy={pendingSlug === targetPage.slug || undefined}
                          aria-current={selected ? 'page' : undefined}
                          className={getSettingsNavButtonClassName(selected)}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden transition-opacity duration-150 opacity-100">
                            <span className="typography-ui-label font-normal truncate">
                              {destination.labelKey ? t(destination.labelKey) : getPageTitle(targetPage.slug)}
                            </span>
                            {pendingSlug === targetPage.slug ? (
                              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />
                            ) : null}
                          </span>
                        </button>
                      </TooltipTrigger>
                    </Tooltip>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="overflow-hidden transition-opacity duration-150 opacity-100">
          <div className="border-t border-border bg-sidebar px-2 py-1 space-y-0.5">
            <ConfigApplyControls variant="sidebar" />

            {principal.scope === 'managed' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded-md px-2 overflow-hidden whitespace-nowrap',
                      'text-sm font-semibold text-sidebar-foreground/90',
                      'transition-[color,background-color,box-shadow]',
                      'hover:bg-destructive/10 hover:text-destructive hover:shadow-[0_0_12px_color-mix(in_srgb,var(--destructive)_35%,transparent)]',
                    )}
                    onClick={() => void handleLogout()}
                  >
                    <RiLogoutBoxRLine className="h-4 w-4 shrink-0" />
                    <span>Sign out</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>End this DevRyan session</TooltipContent>
              </Tooltip>
            ) : null}

          </div>
        </div>
      </div>
    );
  };

  const renderMobileStage = () => {
    if (mobileStage === 'nav') {
      return (
        <div className={cn('flex-1 min-h-0 overflow-hidden', 'bg-sidebar')}>
          <div className="flex h-full min-h-0 flex-col">
            <ErrorBoundary>{renderSettingsNav()}</ErrorBoundary>
          </div>
        </div>
      );
    }

    if (!activePageMeta) {
      return <div className="flex-1 bg-background" />;
    }

    if (mobileStage === 'page-sidebar') {
      if (activePageMeta.kind !== 'split') {
        // No sidebar available; fall back to direct content.
        const fallback = renderPageContent(settingsSlug);
        return (
          <div className="flex-1 min-h-0 overflow-hidden bg-background">
            <SettingsSectionBoundary>{fallback}</SettingsSectionBoundary>
          </div>
        );
      }
      return (
        <div className={cn('flex-1 min-h-0 overflow-hidden', 'bg-sidebar')}>
          {settingsSlug === 'skills.installed' || settingsSlug === 'mcp' ? (
            <CapabilityMutationBoundary slug={settingsSlug} audience={settingsAudience}>
              <SettingsSectionBoundary>
                {renderPageSidebar(settingsSlug, { onItemSelect: () => setMobileStage('page-content') })}
              </SettingsSectionBoundary>
            </CapabilityMutationBoundary>
          ) : (
            <SettingsPagePermissionBoundary slug={settingsSlug}>
              <SettingsSectionBoundary>
                {renderPageSidebar(settingsSlug, { onItemSelect: () => setMobileStage('page-content') })}
              </SettingsSectionBoundary>
            </SettingsPagePermissionBoundary>
          )}
        </div>
      );
    }

    // page-content
    const content = renderPageContent(settingsSlug);

    return (
      <div className="flex-1 min-h-0 overflow-hidden bg-background">
        <SettingsSectionBoundary>{content}</SettingsSectionBoundary>
      </div>
    );
  };

  const renderDesktopContent = () => {
    if (!activePageMeta || settingsSlug === 'home') {
      return <SettingsHome onOpen={openPage} pendingSlug={pendingSlug} />;
    }

    if (activePageMeta.kind === 'split') {
      const splitContent = (
        <div className="flex h-full min-h-0 overflow-hidden">
          <div className={cn(getSettingsPageSidebarClassName(settingsSlug), 'border-r', 'bg-sidebar')} style={{ borderColor: 'var(--interactive-border)' }}>
            <SettingsSectionBoundary>{renderPageSidebar(settingsSlug, {})}</SettingsSectionBoundary>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden bg-background">
            <SettingsSectionBoundary>{renderRawPageContent(settingsSlug)}</SettingsSectionBoundary>
          </div>
        </div>
      );
      if (settingsSlug === 'skills.installed' || settingsSlug === 'mcp') {
        return renderSettingsSectionTabs((
          <CapabilitySettingsWorkspace
            slug={settingsSlug}
            audience={settingsAudience}
            onAudienceChange={() => {}}
            idPrefix={`${settingsSlug.replace('.', '-')}-audience`}
          >
            {splitContent}
          </CapabilitySettingsWorkspace>
        ), 'desktop-settings-section');
      }
      return renderSettingsSectionTabs(
        <SettingsPagePermissionBoundary slug={settingsSlug}>{splitContent}</SettingsPagePermissionBoundary>,
        'desktop-settings-section',
      );
    }

    return renderSettingsSectionTabs((
      <div className="h-full min-h-0 overflow-hidden bg-background">
        <SettingsSectionBoundary>{renderPageContent(settingsSlug)}</SettingsSectionBoundary>
      </div>
    ), 'desktop-settings-section');
  };

  const renderMobileWorkspace = () => {
    const content = (
      <>
        <ConfigApplyControls variant="mobile" />
        <div
          className="flex flex-1 min-h-0 overflow-hidden"
        >
          {renderMobileStage()}
        </div>
      </>
    );

    return mobileStage === 'nav'
      ? content
      : renderSettingsSectionTabs(content, 'mobile-settings-section');
  };

  return (
    <div ref={containerRef} data-settings-view="true" className={cn('relative flex h-full min-h-0 flex-col overflow-hidden bg-background')}>
      {isMobile ? (
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2 border-b',
            'bg-background'
          )}
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          <button
            type="button"
            onClick={showBackButton ? handleBack : onClose}
            aria-label={showBackButton ? t('settings.view.actions.backToSettings') : t('settings.view.actions.closeSettings')}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <RiArrowLeftSLine className="h-5 w-5" />
          </button>

          <div className="min-w-0 flex-1 typography-ui-label font-medium text-foreground truncate">
            {mobileStage === 'nav'
              ? t('settings.view.home.title')
              : (isBehaviorAliasPage ? t('settings.page.behavior.title') : (activePageMeta ? getDestinationTitle(activePageMeta.slug) : t('settings.view.home.title')))}
          </div>

          {mobileStage === 'page-content' && activePageMeta?.kind === 'split' && (
            <button
              type="button"
              onClick={handleOpenPageSidebar}
              aria-label={t('settings.view.actions.openSectionList')}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RiListUnordered className="h-5 w-5" />
            </button>
          )}

        </div>
      ) : (
        null
      )}

      {isMobile ? renderMobileWorkspace() : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <>
            <div
              className={cn(
                'relative flex h-full min-h-0 flex-col overflow-hidden border-r',
                isDesktopApp
                  ? 'bg-sidebar'
                  : 'bg-sidebar',
                isResizing ? '' : 'transition-[width,min-width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]'
              )}
              style={{
                width: `${navWidth}px`,
                minWidth: `${navWidth}px`,
                borderColor: 'var(--interactive-border)',
              }}
            >
              <div
                className={cn(
                  'absolute right-0 top-0 z-20 h-full w-[6px] -mr-[3px] cursor-col-resize',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                  isResizing ? 'bg-primary/30' : 'bg-transparent hover:bg-primary/20'
                )}
                tabIndex={0}
                onPointerDown={handlePointerDown}
                onKeyDown={handleResizeKeyDown}
                role="separator"
                aria-orientation="vertical"
                aria-valuemin={SETTINGS_NAV_MIN_WIDTH}
                aria-valuemax={SETTINGS_NAV_MAX_WIDTH}
                aria-valuenow={navWidth}
                aria-label={t('settings.view.actions.resizeNavigation')}
              />
              <ErrorBoundary>
                {renderSettingsNav()}
              </ErrorBoundary>
            </div>

            <div className="flex-1 overflow-hidden bg-background">
              {renderDesktopContent()}
            </div>
          </>
        </div>
      )}
    </div>
  );
};
