import React from 'react';
import { RiArrowLeftSLine, RiLogoutBoxRLine } from '@remixicon/react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { canAccessSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { SettingsPagePermissionBoundary } from '@/lib/settings/permission-context';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { setStoragePrincipal } from '@/stores/utils/safeStorage';

const LazyOpenChamberPage = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/openchamber/OpenChamberPage').then((module) => ({ default: module.OpenChamberPage })),
);
const LazyAgentsSidebar = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/agents/AgentsSidebar').then((module) => ({ default: module.AgentsSidebar })),
);
const LazyAgentsPage = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/agents/AgentsPage').then((module) => ({ default: module.AgentsPage })),
);
const LazyProvidersSidebar = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/providers/ProvidersSidebar').then((module) => ({ default: module.ProvidersSidebar })),
);
const LazyProvidersPage = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/providers/ProvidersPage').then((module) => ({ default: module.ProvidersPage })),
);
const LazyUsageSidebar = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/usage/UsageSidebar').then((module) => ({ default: module.UsageSidebar })),
);
const LazyUsagePage = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/usage/UsagePage').then((module) => ({ default: module.UsagePage })),
);
const LazyMcpSidebar = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/mcp/McpSidebar').then((module) => ({ default: module.McpSidebar })),
);
const LazyMcpPage = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/mcp/McpPage').then((module) => ({ default: module.McpPage })),
);
const LazyBugReportsPage = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/bug-reports/BugReportsPage').then((module) => ({ default: module.BugReportsPage })),
);

type ManagedSettingsPage =
  | 'home'
  | 'appearance'
  | 'chat'
  | 'shortcuts'
  | 'sessions'
  | 'notifications'
  | 'agents'
  | 'providers'
  | 'usage'
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

const SectionBoundary: React.FC<React.PropsWithChildren> = ({ children }) => (
  <ErrorBoundary>
    <React.Suspense fallback={<div className="h-full min-h-0 bg-background" aria-busy="true" />}>
      {children}
    </React.Suspense>
  </ErrorBoundary>
);

export const ManagedSettingsView: React.FC<ManagedSettingsViewProps> = ({ onClose }) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const settingsPage = useUIStore((state) => state.settingsPage) as ManagedSettingsPage;
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
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
      { slug: 'agents', title: t('settings.page.agents.title'), description: 'Review the agents available to your account.', group: 'Workspace' },
      { slug: 'providers', title: t('settings.page.providers.title'), description: 'Review provider access and models.', group: 'Workspace' },
      { slug: 'usage', title: t('settings.page.usage.title'), description: 'Inspect provider usage and limits.', group: 'Workspace' },
      { slug: 'mcp', title: t('settings.page.mcp.title'), description: 'Review connected MCP services.', group: 'Workspace' },
      {
        slug: 'bug-reports',
        title: t('settings.page.bugReports.title'),
        description: t('settings.page.bugReports.description'),
        group: 'Development',
      },
    ];
    return definitions.filter((page) => canAccessSettingsPage(principal, page.slug) && (page.slug !== 'bug-reports' || !isVSCodeRuntime()));
  }, [principal, t]);

  const activePage = pages.find((page) => page.slug === settingsPage) ?? null;
  const activeSlug: ManagedSettingsPage = settingsPage === 'home' || activePage ? settingsPage : 'home';

  React.useEffect(() => {
    if (activeSlug !== settingsPage) {
      setSettingsPage('home');
    }
  }, [activeSlug, setSettingsPage, settingsPage]);

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
              {pages.map((page) => (
                <button
                  key={page.slug}
                  type="button"
                  onClick={() => setSettingsPage(page.slug)}
                  className="rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left transition-colors hover:bg-[var(--interactive-hover)]"
                >
                  <div className="typography-ui-label text-foreground">{page.title}</div>
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
          <SectionBoundary><LazyOpenChamberPage section={section} /></SectionBoundary>
        </SettingsPagePermissionBoundary>
      );
    }

    if (activeSlug === 'agents') {
      return renderSplitPage(activeSlug, <LazyAgentsSidebar />, <LazyAgentsPage />);
    }
    if (activeSlug === 'providers') {
      return renderSplitPage(activeSlug, <LazyProvidersSidebar />, <LazyProvidersPage />);
    }
    if (activeSlug === 'usage') {
      return renderSplitPage(activeSlug, <LazyUsageSidebar />, <LazyUsagePage />);
    }
    if (activeSlug === 'bug-reports') {
      return (
        <SettingsPagePermissionBoundary slug={activeSlug}>
          <SectionBoundary><LazyBugReportsPage /></SectionBoundary>
        </SettingsPagePermissionBoundary>
      );
    }
    return renderSplitPage('mcp', <LazyMcpSidebar />, <LazyMcpPage />);
  };

  return (
    <div
      className="flex h-full min-h-0 overflow-hidden bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.view.home.title')}
    >
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-sidebar sm:w-56">
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
            onClick={() => setSettingsPage('home')}
            aria-current={activeSlug === 'home' ? 'page' : undefined}
            className={cn(
              'mb-3 flex h-8 w-full items-center rounded-md px-2 text-left typography-ui-label',
              activeSlug === 'home' ? 'bg-interactive-hover text-foreground' : 'text-muted-foreground hover:bg-interactive-hover/70 hover:text-foreground',
            )}
          >
            {t('settings.view.home.title')}
          </button>
          {(['Preferences', 'Workspace', 'Development'] as const).map((group) => {
            const groupPages = pages.filter((page) => page.group === group);
            if (groupPages.length === 0) return null;
            return (
              <div key={group} className="mb-4 space-y-0.5">
                <div className="px-2 pb-1 typography-micro font-medium uppercase tracking-wide text-muted-foreground/70">{group}</div>
                {groupPages.map((page) => (
                  <button
                    key={page.slug}
                    type="button"
                    onClick={() => setSettingsPage(page.slug)}
                    aria-current={activeSlug === page.slug ? 'page' : undefined}
                    className={cn(
                      'flex h-8 w-full items-center rounded-md px-2 text-left typography-ui-label',
                      activeSlug === page.slug ? 'bg-interactive-hover text-foreground' : 'text-muted-foreground hover:bg-interactive-hover/70 hover:text-foreground',
                    )}
                  >
                    <span className="truncate">{page.title}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-border p-2">
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
      <main className="min-w-0 flex-1 overflow-hidden bg-background">
        {renderPage()}
      </main>
    </div>
  );
};
