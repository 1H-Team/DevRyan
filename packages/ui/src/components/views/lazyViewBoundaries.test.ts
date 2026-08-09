import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const uiSourceRoot = resolve(testDir, '../..');

const readSource = (relativePath: string): string => {
  try {
    return readFileSync(resolve(uiSourceRoot, relativePath), 'utf8');
  } catch {
    return '';
  }
};

const lazyViewNames = [
  'GitView',
  'DiffView',
  'FilesView',
  'PlanView',
  'SettingsView',
  'TerminalView',
  'MultiRunWindow',
  'AgentManagerView',
] as const;

describe('shared lazy view boundaries', () => {
  test('does not initialize Multi Run until its authoritative open state activates the boundary', async () => {
    const loaded: unknown = await import('./lazyViews');
    const deferredLazyView = loaded && typeof loaded === 'object'
      ? Reflect.get(loaded, 'DeferredLazyView')
      : undefined;

    expect(typeof deferredLazyView).toBe('function');
    if (typeof deferredLazyView !== 'function') {
      return;
    }

    let loadCount = 0;
    const LazyProbe = React.lazy(async () => {
      loadCount += 1;
      return { default: () => React.createElement('span', null, 'loaded') };
    });
    const renderBoundary = (active: boolean) => renderToString(
      React.createElement(
        React.Suspense,
        { fallback: React.createElement('span', null, 'loading') },
        React.createElement(
          deferredLazyView,
          { active },
          React.createElement(LazyProbe),
        ),
      ),
    );

    expect(renderBoundary(false)).not.toContain('loading');
    expect(loadCount).toBe(0);

    expect(renderBoundary(true)).toContain('loading');
    expect(loadCount).toBe(1);
  });

  test('declares top-level heavy views once with chunk-load recovery', () => {
    const source = readSource('components/views/lazyViews.tsx');
    const planViewLoader = readSource('components/views/planViewLoader.ts');
    const statusRow = readSource('components/chat/StatusRow.tsx');

    expect(source).toContain("import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery'");
    expect(source).toContain("import { loadPlanView } from './planViewLoader';");
    expect(source).toContain('<ErrorBoundary>');
    expect(source).toContain('<React.Suspense fallback={null}>');
    expect(source).toContain('export const LazyPlanView = /* @__PURE__ */ lazyWithChunkRecovery(loadPlanView);');
    expect(planViewLoader).toContain("import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';");
    expect(planViewLoader).toContain('export const loadPlanView = () =>');
    expect(planViewLoader).toContain('export const preloadPlanView = () => importWithChunkRecovery(loadPlanView);');
    expect(statusRow).toContain("import { preloadPlanView } from '@/components/views/planViewLoader';");
    expect(statusRow).toContain('void preloadPlanView().catch(() => undefined);');

    for (const viewName of lazyViewNames) {
      const modulePath = viewName === 'AgentManagerView'
        ? '@/components/views/agent-manager/AgentManagerView'
        : `@/components/views/${viewName}`;

      expect(source).toContain(`export const Lazy${viewName} = /* @__PURE__ */ lazyWithChunkRecovery`);
      const moduleOwner = viewName === 'PlanView' ? planViewLoader : source;
      expect(moduleOwner).toContain(`import('${modulePath}')`);
    }
  });

  test('routes layout view implementations only through the shared lazy module', () => {
    const mainLayout = readSource('components/layout/MainLayout.tsx');
    const rightSidebarTabs = readSource('components/layout/RightSidebarTabs.tsx');
    const contextPanel = readSource('components/layout/ContextPanel.tsx');
    const vscodeLayout = readSource('components/layout/VSCodeLayout.tsx');

    for (const source of [mainLayout, rightSidebarTabs, contextPanel, vscodeLayout]) {
      expect(source).not.toContain("from '@/lib/chunkLoadRecovery'");
    }

    expect(mainLayout).toContain("from '@/components/views/lazyViews'");
    expect(mainLayout).toContain('<LazyPlanView />');
    expect(mainLayout).toContain('<LazyGitView />');
    expect(mainLayout).toContain('<LazyDiffView />');
    expect(mainLayout).toContain('<LazyTerminalView />');
    // FilesView is no longer a main tab; it is mounted by ContextPanel (asserted below).
    expect(mainLayout).not.toContain('LazyFilesView');
    expect(mainLayout).toContain('<LazySettingsView onClose=');
    expect(mainLayout).toContain('<LazyManagedSettingsView onClose=');
    expect(mainLayout).toContain("principal.scope === 'managed' && principal.role !== 'admin'");
    expect(mainLayout).toContain('<LazyMultiRunWindow');
    expect(mainLayout).toContain('<DeferredLazyView active={canLaunchMultiRun && isMultiRunLauncherOpen}>');

    expect(rightSidebarTabs).toContain("from '@/components/views/lazyViews'");
    expect(rightSidebarTabs).not.toContain("from '@/components/views/GitView'");
    expect(rightSidebarTabs).toContain('<LazyViewBoundary>');
    expect(rightSidebarTabs).toContain('<LazyGitView />');
    expect(rightSidebarTabs).toContain('if (!isRightSidebarOpen)');
    expect(rightSidebarTabs.indexOf('if (!isRightSidebarOpen)'))
      .toBeLessThan(rightSidebarTabs.indexOf('<LazyGitView />'));

    for (const viewName of ['DiffView', 'FilesView', 'PlanView']) {
      expect(contextPanel).not.toContain(`from '@/components/views/${viewName}'`);
      expect(contextPanel).toContain(`<Lazy${viewName}`);
    }
    expect(contextPanel).toContain("from '@/components/views/lazyViews'");
    expect((contextPanel.match(/<LazyViewBoundary>/g)?.length ?? 0) >= 2).toBe(true);

    expect(vscodeLayout).toContain("from '@/components/views/lazyViews'");
    expect(vscodeLayout).toContain('<LazyViewBoundary>');
    expect(vscodeLayout).toContain('<LazySettingsView');
  });

  test('keeps settings navigation metadata independent from the heavy settings view', () => {
    const settingsView = readSource('components/views/SettingsView.tsx');
    const commandPalette = readSource('components/ui/CommandPalette.tsx');

    expect(settingsView).toContain("from '@/lib/settings/navigation-icons'");
    expect(settingsView).not.toContain('export function getSettingsNavIcon');
    expect(commandPalette).toContain("from '@/lib/settings/navigation-icons'");
    expect(commandPalette).not.toContain("from '@/components/views/SettingsView'");
  });

  test('loads settings sections only after their page is selected', () => {
    const settingsView = readSource('components/views/SettingsView.tsx');

    expect(settingsView).toContain("import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery'");
    expect(settingsView).toContain('const LazyOpenChamberPage = /* @__PURE__ */ lazyWithChunkRecovery');
    expect(settingsView).toContain('const LazyUserManagementPage = /* @__PURE__ */ lazyWithChunkRecovery');
    expect(settingsView).toContain('<SettingsSectionBoundary>{renderPageContent(settingsSlug)}</SettingsSectionBoundary>');
    expect(settingsView).not.toContain("import { OpenChamberPage } from '@/components/sections/openchamber/OpenChamberPage'");
    expect(settingsView).not.toContain("import { UserManagementPage } from '@/components/sections/users/UserManagementPage'");
  });

  test('keeps managed users outside the administrator settings entry chunk', () => {
    const source = readSource('components/views/lazyViews.tsx');
    const managedSettingsView = readSource('components/views/ManagedSettingsView.tsx');

    expect(source).toContain('export const LazyManagedSettingsView = /* @__PURE__ */ lazyWithChunkRecovery');
    expect(source).toContain("import('@/components/views/ManagedSettingsView')");
    expect(managedSettingsView).not.toContain("from '@/components/views/SettingsView'");
    expect(managedSettingsView).toContain('canAccessSettingsPage(principal, page.slug)');
    expect(managedSettingsView).toContain('<SettingsPagePermissionBoundary slug={activeSlug}>');
    expect(managedSettingsView).toContain('backButtonRef.current?.focus({ preventScroll: true })');
    expect(managedSettingsView).toContain('aria-modal="true"');
    for (const page of ['appearance', 'chat', 'shortcuts', 'sessions', 'notifications', 'agents', 'providers', 'usage', 'mcp']) {
      expect(managedSettingsView).toContain(`slug: '${page}'`);
    }
  });

  test('loads Agent Manager only inside the VS Code agent-manager panel branch', () => {
    const vscodeApp = readSource('apps/VSCodeApp.tsx');
    const agentManagerBranch = vscodeApp.slice(
      vscodeApp.indexOf("if (panelType === 'agentManager')"),
      vscodeApp.indexOf('\n  return (', vscodeApp.indexOf("if (panelType === 'agentManager')")),
    );

    expect(vscodeApp).toContain("from '@/components/views/lazyViews'");
    expect(vscodeApp).not.toContain("from '@/components/views/agent-manager'");
    expect(/import\s+\{\s*AgentManagerView\s*\}/.test(vscodeApp)).toBe(false);
    expect(agentManagerBranch).toContain('<LazyViewBoundary>');
    expect(agentManagerBranch).toContain('<LazyAgentManagerView />');
    expect(vscodeApp.slice(0, vscodeApp.indexOf("if (panelType === 'agentManager')"))).not.toContain('<LazyAgentManagerView />');
  });
});
