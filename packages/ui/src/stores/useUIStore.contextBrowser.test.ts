import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setAuthPrincipal } from '@/lib/authSession';
import { useManualBrowserTabsStore } from './useManualBrowserTabsStore';
import { useUIStore } from './useUIStore';

const DIRECTORY = '/repo/Test';

describe('useUIStore dedicated browser panel', () => {
  beforeEach(() => {
    setAuthPrincipal(null);
    useUIStore.setState({
      contextPanelByDirectory: {},
      browserPanelByDirectory: {},
      browserLeaseTabsByDirectory: {},
      activeBrowserLeaseIdByDirectory: {},
    });
    useManualBrowserTabsStore.setState({ byDirectory: {} });
  });

  afterEach(() => setAuthPrincipal(null));

  test('opens independently beside an existing context panel', () => {
    useUIStore.getState().openContextOverview(DIRECTORY);
    useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.com/docs');

    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.isOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs.map((tab) => tab.mode))
      .toEqual(['context']);
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0]?.url)
      .toBe('https://example.com/docs');
  });

  test('toggles panel visibility without discarding manual tabs', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.com/docs');
    useUIStore.getState().toggleBrowserPanel(DIRECTORY);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(false);

    useUIStore.getState().toggleBrowserPanel(DIRECTORY);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(true);
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0]?.url)
      .toBe('https://example.com/docs');
  });

  test('normalizes safe start URLs and rejects unsupported schemes', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.com/docs?x=1');
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0]?.url)
      .toBe('https://example.com/docs?x=1');

    useManualBrowserTabsStore.getState().clearWorkspace(DIRECTORY);
    useUIStore.getState().openBrowserPanel(DIRECTORY, 'file:///etc/passwd');
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs[0]?.url).toBe('about:blank');
  });

  test('keeps manual pages and lease presentation tabs as separate identities', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://manual.example.com/');
    useUIStore.getState().openBrowserLease(DIRECTORY, {
      leaseId: 'lease-a',
      rootSessionId: 'root-a',
      url: 'http://localhost:3000/',
      title: 'Home',
    });
    useUIStore.getState().openBrowserLease(DIRECTORY, {
      leaseId: 'lease-b',
      rootSessionId: 'root-a',
      url: 'http://localhost:3001/',
      title: 'Docs',
    });

    const leases = useUIStore.getState().browserLeaseTabsByDirectory[DIRECTORY] ?? [];
    expect(leases.map((tab) => tab.id)).toEqual(['browser:lease:lease-a', 'browser:lease:lease-b']);
    expect(leases[0]?.rootSessionId).toBe('root-a');
    expect(useUIStore.getState().activeBrowserLeaseIdByDirectory[DIRECTORY]).toBe('lease-b');
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]?.tabs).toHaveLength(1);
  });

  test('closing a lease presentation does not close the panel or manual workspace', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY);
    useUIStore.getState().openBrowserLease(DIRECTORY, { leaseId: 'lease-a', rootSessionId: 'root-a' });
    useUIStore.getState().closeBrowserLease(DIRECTORY, 'lease-a');

    expect(useUIStore.getState().browserLeaseTabsByDirectory[DIRECTORY]).toEqual([]);
    expect(useUIStore.getState().activeBrowserLeaseIdByDirectory[DIRECTORY]).toBeNull();
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(true);
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]).toBeTruthy();
  });

  test('prunes ended leases without touching manual pages', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY);
    useUIStore.getState().openBrowserLease(DIRECTORY, { leaseId: 'lease-a', rootSessionId: 'root-a' });
    useUIStore.getState().openBrowserLease(DIRECTORY, { leaseId: 'lease-b', rootSessionId: 'root-a' });
    useUIStore.getState().pruneBrowserLeaseTabs(['lease-b']);

    expect(useUIStore.getState().browserLeaseTabsByDirectory[DIRECTORY]?.map((tab) => tab.leaseId))
      .toEqual(['lease-b']);
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]).toBeTruthy();
  });

  test('expanding either sibling panel collapses the other expanded state', () => {
    useUIStore.getState().openContextOverview(DIRECTORY);
    useUIStore.getState().openBrowserPanel(DIRECTORY);
    useUIStore.getState().toggleContextPanelExpanded(DIRECTORY);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.expanded).toBe(true);

    useUIStore.getState().toggleBrowserPanelExpanded(DIRECTORY);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.expanded).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.expanded).toBe(false);

    useUIStore.getState().toggleContextPanelExpanded(DIRECTORY);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.expanded).toBe(true);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.expanded).toBe(false);
  });

  test('blocks creation and clears every Browser presentation when access is disabled', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY);
    useUIStore.getState().openBrowserLease('/repo/Other', { leaseId: 'lease-a', rootSessionId: 'root-a' });
    setAuthPrincipal({
      id: 'developer-1',
      email: 'developer@example.test',
      displayName: 'Developer',
      role: 'developer',
      scope: 'managed',
      policy: {
        settingsPages: ['home'], files: false, terminal: false, browser: false,
        createWorktrees: false, createBranches: false, manageProjects: false,
        manageUsers: false, manageGlobalSettings: false, manageGit: true, push: true, github: true,
      },
      assignments: [],
    });

    useUIStore.getState().pruneAllBrowserTabs();
    useUIStore.getState().openBrowserPanel('/repo/Denied');
    useUIStore.getState().openBrowserLease('/repo/Denied', { leaseId: 'lease-denied', rootSessionId: 'root-denied' });

    expect(useUIStore.getState().browserPanelByDirectory['/repo/Denied']).toBe(undefined);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(false);
    expect(useUIStore.getState().browserLeaseTabsByDirectory).toEqual({});
    expect(useManualBrowserTabsStore.getState().byDirectory).toEqual({});
  });

  test('persists panel state but excludes runtime lease presentation state', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY);
    useUIStore.getState().openBrowserLease(DIRECTORY, { leaseId: 'lease-a', rootSessionId: 'root-a' });
    const persistApi = (useUIStore as unknown as {
      persist: { getOptions: () => { partialize?: (state: ReturnType<typeof useUIStore.getState>) => unknown } };
    }).persist;
    const persisted = persistApi.getOptions().partialize?.(useUIStore.getState()) as Record<string, unknown>;

    expect((persisted.browserPanelByDirectory as Record<string, { isOpen: boolean }>)[DIRECTORY]?.isOpen).toBe(true);
    expect(persisted.browserLeaseTabsByDirectory).toBe(undefined);
    expect(persisted.activeBrowserLeaseIdByDirectory).toBe(undefined);
  });

  test('v17 migration removes Browser context tabs and opens the dedicated panel when active', () => {
    const persistApi = (useUIStore as unknown as {
      persist: { getOptions: () => { migrate?: (state: unknown, version: number) => unknown } };
    }).persist;
    const migrated = persistApi.getOptions().migrate?.({
      contextPanelByDirectory: {
        [DIRECTORY]: {
          isOpen: true,
          expanded: false,
          width: 600,
          touchedAt: 12,
          activeTabId: 'browser',
          tabs: [
            { id: 'file:/repo/Test/a.ts', mode: 'file', targetPath: '/repo/Test/a.ts', touchedAt: 10 },
            { id: 'browser', mode: 'browser', targetPath: null, leaseId: null, touchedAt: 12 },
          ],
        },
      },
    }, 16) as {
      contextPanelByDirectory: Record<string, { isOpen: boolean; tabs: Array<{ mode: string }> }>;
      browserPanelByDirectory: Record<string, { isOpen: boolean }>;
    };

    expect(migrated.contextPanelByDirectory[DIRECTORY]?.tabs.map((tab) => tab.mode)).toEqual(['file']);
    expect(migrated.contextPanelByDirectory[DIRECTORY]?.isOpen).toBe(true);
    expect(migrated.browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(true);
  });

  test('v18 migration fixes retired Chat preferences to their product defaults', () => {
    const persistApi = (useUIStore as unknown as {
      persist: {
        getOptions: () => {
          migrate?: (state: unknown, version: number) => unknown;
          partialize?: (state: ReturnType<typeof useUIStore.getState>) => unknown;
        };
      };
    }).persist;
    const migrated = persistApi.getOptions().migrate?.({
      chatRenderMode: 'sorted',
      persistChatDraft: false,
      inputSpellcheckEnabled: true,
    }, 17) as Record<string, unknown>;
    const persisted = persistApi.getOptions().partialize?.(useUIStore.getState()) as Record<string, unknown>;

    expect(migrated.chatRenderMode).toBe('live');
    expect(migrated.persistChatDraft).toBe(true);
    expect(migrated.inputSpellcheckEnabled).toBe(false);
    expect(persisted.chatRenderMode).toBe(undefined);
    expect(persisted.persistChatDraft).toBe(undefined);
    expect(persisted.inputSpellcheckEnabled).toBe(undefined);
  });
});
