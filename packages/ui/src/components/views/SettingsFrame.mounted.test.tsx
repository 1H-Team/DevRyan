import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { getAuthPrincipal, setAuthPrincipal, type AuthPrincipal } from '@/lib/authSession';
import type { SettingsPageSlug } from '@/lib/settings/metadata';
import { createPreparedSettingsComponent } from './preparedSettingsComponent';

const admin = getAuthPrincipal();
let mobile = false;
const ui = create<{ settingsPage: string; setSettingsPage: (slug: string) => void }>((set) => ({
  settingsPage: 'home', setSettingsPage: (settingsPage) => set({ settingsPage }),
}));
const resources = new Map<string, ReturnType<typeof makeResource>>();
const preloads: string[] = [];
function makeResource(slug: string) {
  let resolve!: (module: { default: React.FC }) => void;
  const promise = new Promise<{ default: React.FC }>((done) => { resolve = done; });
  const resource = createPreparedSettingsComponent(() => promise);
  return { ...resource, finish: () => resolve({ default: () => <div data-section={slug}>{slug} ready</div> }) };
}
const resourceFor = (slug: string) => {
  let resource = resources.get(slug);
  if (!resource) { resource = makeResource(slug); resources.set(slug, resource); }
  return resource;
};
const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
mock.module('@/stores/useUIStore', () => ({ useUIStore: ui }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: mobile }) }));
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...desktop, isDesktopShell: () => false, isWebRuntime: () => true }));
mock.module('@/components/ui/tooltip', () => ({ Tooltip: passthrough, TooltipTrigger: passthrough, TooltipContent: () => null }));
mock.module('./config-apply/ConfigApplyControls', () => ({ ConfigApplyControls: () => null }));
mock.module('./SettingsSectionTabs', () => ({ SettingsSectionTabs: passthrough }));
mock.module('./settingsSectionLoaders', () => ({
  ...Object.fromEntries(['AboutSettings', 'AgentsPage', 'AgentsSidebar', 'BehaviorPage', 'BotsPage', 'BugReportsPage',
    'CommandsPage', 'CommandsSidebar', 'GitPage', 'MagicPromptsPage', 'MagicPromptsSidebar', 'McpPage', 'McpSidebar',
    'PluginsPage', 'PluginsSidebar', 'ProjectsPage', 'ProjectsSidebar', 'ProvidersPage', 'ProvidersSidebar',
    'RemoteInstancesPage', 'RemoteInstancesSidebar', 'SkillsPage', 'SkillsSidebar', 'UsagePage', 'UsageSidebar',
    'UserManagementPage'].map((name) => [`Prepared${name}`, () => <div>{name}</div>])),
  PreparedSettingsDataBoundary: passthrough,
  PreparedOpenChamberPage: ({ section }: { section: string }) => {
    const Component = resourceFor(section === 'visual' ? 'appearance' : section).Component;
    return <Component />;
  },
  isSettingsSectionReady: (slug: string) => slug === 'home' || resourceFor(slug).isReady(),
  preloadSettingsSection: (slug: string) => {
    preloads.push(slug);
    return slug === 'home' ? Promise.resolve() : resourceFor(slug).load().then(() => undefined);
  },
  preloadSettingsSectionsWhenIdle: () => () => {},
}));

const { SettingsFrame } = await import('./SettingsFrame');
const { ManagedSettingsFrame } = await import('./ManagedSettingsFrame');
const { usePreparedSettingsNavigation } = await import('./usePreparedSettingsNavigation');

beforeEach(() => {
  setAuthPrincipal(admin);
  ui.setState({ settingsPage: 'home' });
  resources.clear(); preloads.length = 0; mobile = false;
});
const developer = (pages: string[]): AuthPrincipal => ({
  ...admin, id: 'settings-test-developer', scope: 'managed', role: 'developer',
  policy: { ...admin.policy, settingsPermissions: undefined, settingsPages: pages },
});
const button = (container: HostElement, text: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent.includes(text));
const busy = (container: HostElement) => container.find((node) => node.getAttribute('data-settings-section-loading') === 'true');

async function mounted(managed: boolean, run: (container: HostElement) => Promise<void>) {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const Host = () => {
      const [open, setOpen] = React.useState(true);
      const Frame = managed ? ManagedSettingsFrame : SettingsFrame;
      return open ? <Frame onClose={() => setOpen(false)} /> : <div>Application</div>;
    };
    try {
      await act(async () => root.render(<Host />));
      await run(container);
    } finally { await act(async () => root.unmount()); }
  });
}

describe('immediately available Settings frames', () => {
  for (const managed of [false, true]) {
    test(`${managed ? 'managed' : 'full'} cold destination leaves Back and navigation usable`, async () => {
      if (managed) setAuthPrincipal(developer(['appearance', 'shortcuts']));
      ui.setState({ settingsPage: 'appearance' });
      await mounted(managed, async (container) => {
        expect(button(container, 'settings.page.shortcuts.title')).not.toBeNull();
        expect(busy(container)).not.toBeNull();
        const back = container.find((node) => node.tagName === 'BUTTON' &&
          (node.getAttribute('aria-label') === 'settings.view.actions.back' || node.textContent === 'settings.view.actions.back'));
        expect(back).not.toBeNull();
        await act(async () => back?.click());
        expect(container.textContent).toBe('Application');
        await act(async () => resourceFor('appearance').finish());
        expect(container.textContent).toBe('Application');
      });
    });
    test(`${managed ? 'managed' : 'full'} warm destination renders without a placeholder`, async () => {
      if (managed) setAuthPrincipal(developer(['appearance']));
      resourceFor('appearance').finish();
      await resourceFor('appearance').load();
      ui.setState({ settingsPage: 'appearance' });
      await mounted(managed, async (container) => {
        expect(container.textContent).toContain('appearance ready');
        expect(busy(container)).toBeNull();
      });
    });
  }

  test('mobile direct entry has a working Back while the section is still pending', async () => {
    mobile = true;
    ui.setState({ settingsPage: 'appearance' });
    await mounted(false, async (container) => {
      expect(busy(container)).not.toBeNull();
      const back = container.find((node) => node.getAttribute('aria-label') === 'settings.view.actions.backToSettings');
      expect(back).not.toBeNull();
      await act(async () => back?.click());
      expect(busy(container)).toBeNull();
      expect(button(container, 'settings.page.shortcuts.title')).not.toBeNull();
    });
  });

  test('retains the current section until the latest requested destination is ready', async () => {
    resourceFor('appearance').finish(); await resourceFor('appearance').load();
    ui.setState({ settingsPage: 'appearance' });
    await mounted(false, async (container) => {
      await act(async () => button(container, 'settings.page.shortcuts.title')?.click());
      expect(container.textContent).toContain('appearance ready');
      expect(busy(container)).toBeNull();
      await act(async () => button(container, 'settings.page.notifications.title')?.click());
      await act(async () => resourceFor('shortcuts').finish());
      expect(ui.getState().settingsPage).toBe('appearance');
      await act(async () => resourceFor('notifications').finish());
      expect(ui.getState().settingsPage).toBe('notifications');
      expect(container.textContent).toContain('notifications ready');
    });
  });

  test('removes revoked content immediately and never commits its pending navigation', async () => {
    setAuthPrincipal(developer(['appearance', 'shortcuts']));
    resourceFor('appearance').finish(); await resourceFor('appearance').load();
    ui.setState({ settingsPage: 'appearance' });
    await mounted(true, async (container) => {
      await act(async () => button(container, 'settings.page.shortcuts.title')?.click());
      await act(async () => setAuthPrincipal(developer([])));
      expect(container.textContent).not.toContain('appearance ready');
      expect(button(container, 'settings.page.shortcuts.title')).toBeNull();
      await act(async () => resourceFor('shortcuts').finish());
      expect(ui.getState().settingsPage).toBe('home');
    });
  });

  test('rejects a forbidden remembered destination before requesting its code', async () => {
    setAuthPrincipal(developer(['appearance']));
    ui.setState({ settingsPage: 'users' });
    await mounted(true, async (container) => {
      expect(preloads).not.toContain('users');
      expect(container.textContent).not.toContain('UserManagementPage');
      expect(ui.getState().settingsPage).toBe('home');
    });
  });

  test('external store navigation uses the same staged path and unmount cancels commit', async () => {
    let commitCount = 0;
    const Probe = () => {
      const requestedSlug = ui((state) => state.settingsPage) as SettingsPageSlug;
      const navigation = usePreparedSettingsNavigation({ requestedSlug, preloadSlugs: ['appearance', 'shortcuts'] });
      return <><span>{navigation.displayedSlug}</span><button onClick={() => navigation.prepareAndCommit('shortcuts', () => { commitCount += 1; })}>Open</button></>;
    };
    await withDom(async (container) => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      await act(async () => root.render(<Probe />));
      await act(async () => ui.setState({ settingsPage: 'appearance' }));
      expect(container.textContent).toContain('home');
      await act(async () => resourceFor('appearance').finish());
      expect(container.textContent).toContain('appearance');
      await act(async () => button(container, 'Open')?.click());
      await act(async () => root.unmount());
      await act(async () => resourceFor('shortcuts').finish());
      expect(commitCount).toBe(0);
    });
  });
});
