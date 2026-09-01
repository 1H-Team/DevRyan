import React from 'react';
import { RiArrowLeftSLine, RiLogoutBoxRLine } from '@remixicon/react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ConfigApplyControls } from '@/components/views/config-apply/ConfigApplyControls';
import { canAccessSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { SettingsPagePermissionBoundary } from '@/lib/settings/permission-context';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePluginsStore } from '@/stores/usePluginsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useUIStore } from '@/stores/useUIStore';
import { setStoragePrincipal } from '@/stores/utils/safeStorage';
import { CapabilitySettingsWorkspace } from './CapabilitySettingsWorkspace';
import { SettingsSectionTabs } from './SettingsSectionTabs';
import { canAccessSettingsDestination } from './SettingsView.access';
import { SettingsLoadFallback } from './SettingsLoadFallback';
import { usePreparedSettingsNavigation } from './usePreparedSettingsNavigation';
import {
  PreparedAgentsPage,
  PreparedAgentsSidebar,
  PreparedBotsPage,
  PreparedBugReportsPage,
  PreparedMcpPage,
  PreparedMcpSidebar,
  PreparedOpenChamberPage,
  PreparedPluginsPage,
  PreparedPluginsSidebar,
  PreparedProvidersPage,
  PreparedProvidersSidebar,
  PreparedSkillsPage,
  PreparedSkillsSidebar,
  PreparedUsagePage,
  PreparedUsageSidebar,
  preloadSettingsSection,
} from './settingsSectionLoaders';

type ManagedSettingsPage =
  | 'home'
  | 'appearance'
  | 'chat'
  | 'shortcuts'
  | 'sessions'
  | 'notifications'
  | 'bots'
  | 'agents'
  | 'providers'
  | 'usage'
  | 'skills.installed'
  | 'plugins'
  | 'mcp'
  | 'bug-reports';

interface ManagedSettingsViewProps {
  onClose?: () => void;
}

interface ManagedPageDefinition {
  slug: ManagedSettingsPage;
  title: string;
  description: string;
  group: 'Preferences' | 'Workspace' | 'Development';
}

interface ManagedNavigationDestination extends Omit<ManagedPageDefinition, 'slug'> {
  id: string;
  slugs: readonly ManagedSettingsPage[];
  targetSlug: ManagedSettingsPage;
}

const SectionBoundary: React.FC<React.PropsWithChildren> = ({ children }) => (
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

export const ManagedSettingsView: React.FC<ManagedSettingsViewProps> = ({ onClose }) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const settingsPage = useUIStore((state) => state.settingsPage) as ManagedSettingsPage;
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const backButtonRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      backButtonRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const pages = React.useMemo<ManagedPageDefinition[]>(() => {
    const definitions: ManagedPageDefinition[] = [
      { slug: 'appearance', title: t('settings.page.appearance.title'), description: 'Theme, typography, spacing, and interface preferences.', group: 'Preferences' },
      { slug: 'chat', title: t('settings.page.chat.title'), description: 'Message, tool, reasoning, and rendering preferences.', group: 'Preferences' },
      { slug: 'shortcuts', title: t('settings.page.shortcuts.title'), description: 'Review and customize keyboard shortcuts.', group: 'Preferences' },
      { slug: 'sessions', title: t('settings.page.sessions.title'), description: 'Defaults, retention, and session behavior.', group: 'Preferences' },
      { slug: 'notifications', title: t('settings.page.notifications.title'), description: 'Choose when and how DevRyan notifies you.', group: 'Preferences' },
      { slug: 'bots', title: t('settings.page.bots.title'), description: t('settings.page.bots.description'), group: 'Workspace' },
      { slug: 'agents', title: t('settings.page.agents.title'), description: 'Review the agents available to your account.', group: 'Workspace' },
      { slug: 'skills.installed', title: t('settings.page.skills.title'), description: 'Manage reusable Coding Agent skills.', group: 'Workspace' },
      { slug: 'plugins', title: t('settings.page.plugins.title'), description: 'Review installed OpenCode plugins.', group: 'Workspace' },
      { slug: 'providers', title: t('settings.page.providers.title'), description: 'Review provider access and models.', group: 'Workspace' },
      { slug: 'usage', title: t('settings.page.usage.title'), description: 'Inspect provider usage and limits.', group: 'Workspace' },
      { slug: 'mcp', title: t('settings.page.mcp.title'), description: 'Review Coding Agent servers.', group: 'Workspace' },
      {
        slug: 'bug-reports',
        title: t('settings.page.bugReports.title'),
        description: t('settings.page.bugReports.description'),
        group: 'Development',
      },
    ];
    return definitions.filter((page) => (
      canAccessSettingsDestination(principal, page.slug)
      && (page.slug !== 'bug-reports' || !isVSCodeRuntime())
    ));
  }, [principal, t]);

  const providerPages = React.useMemo(
    () => pages.filter((page) => page.slug === 'providers' || page.slug === 'usage'),
    [pages],
  );
  const requestedPage = pages.find((page) => page.slug === settingsPage) ?? null;
  const providerFallback = (settingsPage === 'providers' || settingsPage === 'usage')
    ? providerPages[0]?.slug
    : null;
  const requestedActiveSlug: ManagedSettingsPage = settingsPage === 'home'
    ? 'home'
    : requestedPage?.slug ?? providerFallback ?? 'home';
  const preloadSlugs = React.useMemo(
    () => pages.map((page) => page.slug),
    [pages],
  );
  const { displayedSlug: activeSlug, pendingSlug, prepareAndCommit } = usePreparedSettingsNavigation({
    requestedSlug: requestedActiveSlug,
    preloadSlugs,
  });
  const activePage = pages.find((page) => page.slug === activeSlug) ?? null;
  const navigationDestinations = React.useMemo<ManagedNavigationDestination[]>(() => {
    const destinations: ManagedNavigationDestination[] = [];
    let providersAdded = false;

    for (const page of pages) {
      if (page.slug === 'chat') continue;
      if (page.slug === 'providers' || page.slug === 'usage') {
        if (providersAdded) continue;
        providersAdded = true;
        if (providerPages.length === 0) continue;
        destinations.push({
          id: 'providers',
          slugs: providerPages.map((providerPage) => providerPage.slug),
          targetSlug: providerPages[0].slug,
          title: t('settings.page.providers.title'),
          description: t('settings.view.home.cards.providers.description'),
          group: 'Workspace',
        });
        continue;
      }
      destinations.push({
        id: page.slug,
        slugs: [page.slug],
        targetSlug: page.slug,
        title: page.title,
        description: page.description,
        group: page.group,
      });
    }

    return destinations;
  }, [pages, providerPages, t]);

  React.useEffect(() => {
    if (requestedActiveSlug !== settingsPage) {
      setSettingsPage(requestedActiveSlug);
    }
  }, [requestedActiveSlug, setSettingsPage, settingsPage]);

  React.useEffect(() => {
    if (activeSlug === 'skills.installed' && canAccessSettingsPage(principal, activeSlug)) {
      void useSkillsStore.getState().loadSkills();
      void useSkillsCatalogStore.getState().loadCatalog();
      return;
    }
    if (activeSlug === 'plugins' && canAccessSettingsPage(principal, activeSlug)) {
      void usePluginsStore.getState().loadPlugins();
      void usePluginsStore.getState().loadSlimStatus();
    }
  }, [activeProjectId, activeSlug, principal]);

  const openPage = React.useCallback((slug: ManagedSettingsPage) => {
    prepareAndCommit(slug, () => setSettingsPage(slug));
  }, [prepareAndCommit, setSettingsPage]);

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

  const renderSplitPage = (
    slug: ManagedSettingsPage,
    sidebar: React.ReactNode,
    content: React.ReactNode,
  ): React.ReactNode => (
    <SettingsPagePermissionBoundary slug={slug}>
      <div className="flex h-full min-h-0 overflow-hidden">
        <div className="hidden w-56 shrink-0 border-r border-border bg-sidebar md:block">
          <SectionBoundary>{sidebar}</SectionBoundary>
        </div>
        <div className="min-w-0 flex-1 overflow-hidden bg-background">
          <SectionBoundary>{content}</SectionBoundary>
        </div>
      </div>
    </SettingsPagePermissionBoundary>
  );

  const renderCapabilityPage = (slug: 'skills.installed' | 'mcp'): React.ReactNode => {
    const canReadCodingAgents = canAccessSettingsPage(principal, slug);
    const sidebar = canReadCodingAgents ? (
      slug === 'mcp' ? <PreparedMcpSidebar /> : <PreparedSkillsSidebar />
    ) : (
      <CodingAgentSettingsAccessRequired />
    );
    const content = canReadCodingAgents ? (
      slug === 'mcp' ? <PreparedMcpPage /> : <PreparedSkillsPage />
    ) : (
      <CodingAgentSettingsAccessRequired />
    );

    return (
      <CapabilitySettingsWorkspace
        slug={slug}
        audience="coding-agents"
        onAudienceChange={() => {}}
        idPrefix={`managed-${slug.replace('.', '-')}-audience`}
      >
        <div className="flex h-full min-h-0 overflow-hidden">
            <div className="hidden min-h-0 w-56 shrink-0 border-r border-border bg-sidebar md:block">
              <SectionBoundary>{sidebar}</SectionBoundary>
            </div>
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
              <div className="min-h-0 flex-1 overflow-hidden">
                <SectionBoundary>{content}</SectionBoundary>
              </div>
            </div>
        </div>
      </CapabilitySettingsWorkspace>
    );
  };

  const renderPage = (): React.ReactNode => {
    if (activeSlug === 'home') {
      return (
        <div className="h-full overflow-auto">
          <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-6">
            <div className="space-y-1">
              <h1 className="typography-ui-header font-semibold text-foreground">{t('settings.view.home.title')}</h1>
              <p className="typography-ui text-muted-foreground">{t('settings.view.home.description')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {navigationDestinations.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => openPage(page.targetSlug)}
                  onPointerEnter={() => void preloadSettingsSection(page.targetSlug).catch(() => undefined)}
                  onPointerDown={() => void preloadSettingsSection(page.targetSlug).catch(() => undefined)}
                  onFocus={() => void preloadSettingsSection(page.targetSlug).catch(() => undefined)}
                  aria-busy={pendingSlug === page.targetSlug || undefined}
                  className="rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left transition-colors hover:bg-[var(--interactive-hover)]"
                >
                  <div className="flex items-center gap-2 typography-ui-label text-foreground">
                    <span>{page.title}</span>
                    {pendingSlug === page.targetSlug ? (
                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />
                    ) : null}
                  </div>
                  <div className="typography-micro text-muted-foreground/70">{page.description}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    }

    if (activeSlug === 'appearance' || activeSlug === 'chat' || activeSlug === 'shortcuts'
      || activeSlug === 'sessions' || activeSlug === 'notifications') {
      const section = activeSlug === 'appearance' ? 'visual' : activeSlug;
      return (
        <SettingsPagePermissionBoundary slug={activeSlug}>
          <SectionBoundary><PreparedOpenChamberPage section={section} /></SectionBoundary>
        </SettingsPagePermissionBoundary>
      );
    }

    if (activeSlug === 'agents') {
      return renderSplitPage(activeSlug, <PreparedAgentsSidebar />, <PreparedAgentsPage />);
    }
    if (activeSlug === 'bots') {
      return (
        <SettingsPagePermissionBoundary slug={activeSlug}>
          <SectionBoundary><PreparedBotsPage /></SectionBoundary>
        </SettingsPagePermissionBoundary>
      );
    }
    if (activeSlug === 'providers' || activeSlug === 'usage') {
      const content = activeSlug === 'providers'
        ? renderSplitPage(activeSlug, <PreparedProvidersSidebar />, <PreparedProvidersPage />)
        : renderSplitPage(activeSlug, <PreparedUsageSidebar />, <PreparedUsagePage />);
      return (
        <SettingsSectionTabs
          activeSlug={activeSlug}
          ariaLabel={t('settings.providers.tabs.aria')}
          idPrefix="managed-providers-settings"
          onTabChange={(slug) => openPage(slug as ManagedSettingsPage)}
          pendingSlug={pendingSlug}
          tabs={providerPages.map((page) => ({ slug: page.slug, label: page.title }))}
        >
          {content}
        </SettingsSectionTabs>
      );
    }
    if (activeSlug === 'skills.installed' || activeSlug === 'mcp') {
      return renderCapabilityPage(activeSlug);
    }
    if (activeSlug === 'plugins') {
      return renderSplitPage(activeSlug, <PreparedPluginsSidebar />, <PreparedPluginsPage />);
    }
    if (activeSlug === 'bug-reports') {
      return (
        <SettingsPagePermissionBoundary slug={activeSlug}>
          <SectionBoundary><PreparedBugReportsPage /></SectionBoundary>
        </SettingsPagePermissionBoundary>
      );
    }
    return null;
  };

  const handleMobileBack = () => {
    if (activeSlug !== 'home') {
      openPage('home');
      return;
    }
    onClose?.();
  };

  return (
    <div
      className="flex h-full min-h-0 overflow-hidden bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.view.home.title')}
    >
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-sidebar sm:flex sm:w-56">
        <div className="border-b border-border p-2">
          <button
            ref={backButtonRef}
            type="button"
            onClick={onClose}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 typography-ui-label text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          >
            <RiArrowLeftSLine className="h-4 w-4 shrink-0" />
            <span>{t('settings.view.actions.back')}</span>
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-auto px-2 py-3" aria-label={t('settings.view.home.title')}>
          <button
            type="button"
            onClick={() => openPage('home')}
            aria-current={activeSlug === 'home' ? 'page' : undefined}
            className={cn(
              'mb-3 flex h-8 w-full items-center rounded-md px-2 text-left typography-ui-label',
              activeSlug === 'home' ? 'bg-interactive-hover text-foreground' : 'text-muted-foreground hover:bg-interactive-hover/70 hover:text-foreground',
            )}
          >
            {t('settings.view.home.title')}
          </button>
          {(['Preferences', 'Workspace', 'Development'] as const).map((group) => {
            const groupPages = navigationDestinations.filter((page) => page.group === group);
            if (groupPages.length === 0) return null;
            return (
              <div key={group} className="mb-4 space-y-0.5">
                <div className="px-2 pb-1 typography-micro font-medium uppercase tracking-wide text-muted-foreground/70">{group}</div>
                {groupPages.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => openPage(page.targetSlug)}
                    onPointerEnter={() => void preloadSettingsSection(page.targetSlug).catch(() => undefined)}
                    onPointerDown={() => void preloadSettingsSection(page.targetSlug).catch(() => undefined)}
                    onFocus={() => void preloadSettingsSection(page.targetSlug).catch(() => undefined)}
                    aria-busy={pendingSlug === page.targetSlug || undefined}
                    aria-current={page.slugs.includes(activeSlug) ? 'page' : undefined}
                    className={cn(
                      'flex h-8 w-full items-center rounded-md px-2 text-left typography-ui-label',
                      page.slugs.includes(activeSlug) ? 'bg-interactive-hover text-foreground' : 'text-muted-foreground hover:bg-interactive-hover/70 hover:text-foreground',
                    )}
                  >
                    <span className="truncate">{page.title}</span>
                    {pendingSlug === page.targetSlug ? (
                      <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />
                    ) : null}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="space-y-2 border-t border-border p-2">
          <ConfigApplyControls variant="sidebar" />
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 typography-ui-label text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          >
            <RiLogoutBoxRLine className="h-4 w-4 shrink-0" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:hidden">
          <button
            type="button"
            onClick={handleMobileBack}
            aria-label={activeSlug === 'home' ? 'Close Settings' : 'Back to Settings'}
            className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <RiArrowLeftSLine className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">
            {(activeSlug === 'providers' || activeSlug === 'usage')
                ? t('settings.page.providers.title')
                : activePage?.title || t('settings.view.home.title')}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{renderPage()}</div>
      </main>
    </div>
  );
};
