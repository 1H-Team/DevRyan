import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setAuthPrincipal } from '@/lib/authSession';
import { useManualBrowserTabsStore } from './useManualBrowserTabsStore';
import { useUIStore } from './useUIStore';

const DIRECTORY = '/repo/Test';

describe('useUIStore context browser tabs', () => {
  beforeEach(() => {
    setAuthPrincipal(null);
    useUIStore.setState({ contextPanelByDirectory: {} });
    useManualBrowserTabsStore.setState({ byDirectory: {} });
  });

  afterEach(() => setAuthPrincipal(null));

  test('opens one singleton browser tab per directory', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY);
    useUIStore.getState().openContextBrowser(DIRECTORY, 'https://example.com/docs');

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.tabs).toHaveLength(1);
    expect(panel?.tabs[0]?.mode).toBe('browser');
    expect(panel?.activeTabId).toBe('browser');
  });

  test('toggles a browser-only panel open and closed', () => {
    useUIStore.getState().toggleContextBrowser(DIRECTORY);

    const opened = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(opened?.isOpen).toBe(true);
    expect(opened?.tabs).toHaveLength(1);
    expect(opened?.activeTabId).toBe('browser');

    useUIStore.getState().toggleContextBrowser(DIRECTORY);

    const closed = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(closed?.isOpen).toBe(false);
    expect(closed?.tabs).toHaveLength(0);
    expect(closed?.activeTabId).toBeNull();
  });

  test('reactivates an inactive browser tab without losing its URL', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY, 'https://example.com/docs');
    useUIStore.getState().openContextOverview(DIRECTORY);

    useUIStore.getState().toggleContextBrowser(DIRECTORY);

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.activeTabId).toBe('browser');
    expect(panel?.tabs.find((tab) => tab.mode === 'browser')?.targetPath).toBeNull();
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0]?.url)
      .toBe('https://example.com/docs');
  });

  test('closes only the active browser tab when other context tabs remain', () => {
    useUIStore.getState().openContextOverview(DIRECTORY);
    useUIStore.getState().openContextBrowser(DIRECTORY);

    useUIStore.getState().toggleContextBrowser(DIRECTORY);

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.tabs).toHaveLength(1);
    expect(panel?.tabs[0]?.mode).toBe('context');
    expect(panel?.activeTabId).toBe(panel?.tabs[0]?.id);
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]).toBe(undefined);
  });

  test('reopens a retained browser tab after the whole panel was hidden', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY, 'https://example.com/docs');
    useUIStore.getState().closeContextPanel(DIRECTORY);

    useUIStore.getState().toggleContextBrowser(DIRECTORY);

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.activeTabId).toBe('browser');
    expect(panel?.tabs[0]?.targetPath).toBeNull();
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0]?.url)
      .toBe('https://example.com/docs');
  });

  test('records a normalized start URL in the dedicated browser workspace', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY, 'https://example.com/docs?x=1');

    const tab = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs[0];
    expect(tab?.mode).toBe('browser');
    expect(tab?.targetPath).toBeNull();
    expect(tab?.label).toBe('Browser');
    const pageTab = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0];
    expect(pageTab?.url).toBe('https://example.com/docs?x=1');
    expect(pageTab?.label).toBe('example.com');
  });

  test('ignores non-http(s) start URLs and opens an empty tab', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY, 'file:///etc/passwd');

    const tab = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs[0];
    expect(tab?.mode).toBe('browser');
    expect(tab?.targetPath).toBeNull();
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0]?.url).toBe('about:blank');
  });

  test('persists the current safe URL in the dedicated browser store', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY);
    const tab = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs[0];
    expect(tab).toBeTruthy();

    const pageTab = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0];
    useManualBrowserTabsStore.getState().updateTabUrl(DIRECTORY, pageTab?.id ?? '', 'https://docs.example.com/guide');

    const updated = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0];
    expect(updated?.url).toBe('https://docs.example.com/guide');
    expect(updated?.label).toBe('docs.example.com');
    expect(tab?.targetPath).toBeNull();
  });

  test('returns the original browser-store references for duplicate target updates', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY, 'https://example.com/');
    const tab = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0];

    const beforeStore = useManualBrowserTabsStore.getState().byDirectory;
    useManualBrowserTabsStore.getState().updateTabUrl(DIRECTORY, tab?.id ?? '', 'https://example.com/');

    expect(useManualBrowserTabsStore.getState().byDirectory).toBe(beforeStore);
  });

  test('keeps manual and lease browser tabs as exact separate identities', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY, 'https://manual.example.com/');
    useUIStore.getState().openContextBrowserLease(DIRECTORY, {
      leaseId: 'lease-a',
      rootSessionId: 'root-a',
      url: 'http://localhost:3000/',
      title: 'Home',
      hostname: 'localhost',
    });
    useUIStore.getState().openContextBrowserLease(DIRECTORY, {
      leaseId: 'lease-b',
      rootSessionId: 'root-a',
      url: 'http://localhost:3001/',
      title: 'Docs',
      hostname: 'localhost',
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs ?? [];
    expect(tabs).toHaveLength(3);
    expect(tabs.find((tab) => !tab.leaseId)?.id).toBe('browser');
    expect(tabs.find((tab) => tab.leaseId === 'lease-a')?.id).toBe('browser:lease:lease-a');
    expect(tabs.find((tab) => tab.leaseId === 'lease-a')?.ownerSessionId).toBe('root-a');
    expect(tabs.find((tab) => tab.leaseId === 'lease-b')?.id).toBe('browser:lease:lease-b');
  });

  test('prunes removed lease tabs without touching the manual browser', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY);
    useUIStore.getState().openContextBrowserLease(DIRECTORY, {
      leaseId: 'lease-a',
      rootSessionId: 'root-a',
    });
    useUIStore.getState().openContextBrowserLease(DIRECTORY, {
      leaseId: 'lease-b',
      rootSessionId: 'root-a',
    });

    useUIStore.getState().pruneBrowserLeaseTabs(['lease-b']);

    const tabs = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs ?? [];
    expect(tabs.some((tab) => tab.id === 'browser')).toBe(true);
    expect(tabs.some((tab) => tab.leaseId === 'lease-a')).toBe(false);
    expect(tabs.some((tab) => tab.leaseId === 'lease-b')).toBe(true);
  });

  test('blocks creation and prunes every Browser tab when access is disabled', () => {
    useUIStore.getState().openContextOverview(DIRECTORY);
    useUIStore.getState().openContextBrowser(DIRECTORY);
    useUIStore.getState().openContextBrowserLease('/repo/Other', {
      leaseId: 'lease-a',
      rootSessionId: 'root-a',
    });

    setAuthPrincipal({
      id: 'developer-1',
      email: 'developer@example.test',
      displayName: 'Developer',
      role: 'developer',
      scope: 'managed',
      policy: {
        settingsPages: ['home'],
        files: false,
        terminal: false,
        browser: false,
        createWorktrees: false,
        createBranches: false,
        manageProjects: false,
        manageUsers: false,
        manageGlobalSettings: false,
        manageGit: true,
        push: true,
        github: true,
      },
      assignments: [],
    });
    useUIStore.getState().pruneAllBrowserTabs();
    useUIStore.getState().openContextBrowser('/repo/Denied');
    useUIStore.getState().openContextBrowserLease('/repo/Denied', {
      leaseId: 'lease-denied',
      rootSessionId: 'root-denied',
    });

    expect(useUIStore.getState().contextPanelByDirectory['/repo/Denied']).toBe(undefined);
    expect(useUIStore.getState().contextPanelByDirectory['/repo/Other']?.tabs).toEqual([]);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs.map((tab) => tab.mode))
      .toEqual(['context']);
  });

  test('excludes ephemeral lease tabs from persistence', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY);
    useUIStore.getState().openContextBrowserLease(DIRECTORY, {
      leaseId: 'lease-a',
      rootSessionId: 'root-a',
    });

    const persistApi = (useUIStore as unknown as {
      persist: { getOptions: () => { partialize?: (state: ReturnType<typeof useUIStore.getState>) => unknown } };
    }).persist;
    const persisted = persistApi.getOptions().partialize?.(useUIStore.getState()) as {
      contextPanelByDirectory?: Record<string, { tabs: Array<{ leaseId: string | null }> }>;
    };

    const tabs = persisted.contextPanelByDirectory?.[DIRECTORY]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.leaseId).toBeNull();
  });

  test('rehydration sanitizer keeps browser tabs and drops unknown modes', () => {
    const persistApi = (useUIStore as unknown as {
      persist: { getOptions: () => { migrate?: (state: unknown, version: number) => unknown } };
    }).persist;
    const migrate = persistApi.getOptions().migrate;
    expect(typeof migrate).toBe('function');

    const persisted = {
      contextPanelByDirectory: {
        [DIRECTORY]: {
          isOpen: true,
          expanded: false,
          width: 600,
          touchedAt: Date.now(),
          activeTabId: 'browser',
          tabs: [
            { mode: 'browser', targetPath: 'https://example.com/', label: 'example.com', touchedAt: Date.now() },
            { mode: 'sorcery', targetPath: null, label: null, touchedAt: Date.now() },
          ],
        },
      },
    };

    // The tab sanitizer runs unconditionally inside migrate: 'browser' tabs
    // survive a v10 payload, unknown modes are dropped.
    const migrated = migrate?.(persisted, 10) as {
      contextPanelByDirectory: Record<string, { tabs: Array<{ mode: string; targetPath: string | null }> }>;
    };
    const tabs = migrated?.contextPanelByDirectory?.[DIRECTORY]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.mode).toBe('browser');
    expect(tabs[0]?.targetPath).toBe('https://example.com/');
  });
});
