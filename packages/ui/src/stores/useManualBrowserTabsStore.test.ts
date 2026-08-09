import { beforeEach, describe, expect, test } from 'bun:test';

import {
  sanitizeManualBrowserWorkspace,
  sanitizeManualBrowserWorkspaces,
  useManualBrowserTabsStore,
} from './useManualBrowserTabsStore';

const DIRECTORY = '/repo/Test';

describe('useManualBrowserTabsStore', () => {
  beforeEach(() => {
    useManualBrowserTabsStore.setState({ byDirectory: {} });
  });

  test('creates one directory-scoped workspace and imports a legacy URL', () => {
    const workspace = useManualBrowserTabsStore.getState().ensureWorkspace(DIRECTORY, 'https://example.com/docs');
    expect(workspace?.tabs).toHaveLength(1);
    expect(workspace?.tabs[0]?.url).toBe('https://example.com/docs');
    expect(workspace?.tabs[0]?.label).toBe('example.com');
    expect(useManualBrowserTabsStore.getState().ensureWorkspace(DIRECTORY, 'https://ignored.example/'))
      .toBe(workspace);
  });

  test('adds unique tabs and activates the new tab', () => {
    const first = useManualBrowserTabsStore.getState().ensureWorkspace(DIRECTORY);
    const secondId = useManualBrowserTabsStore.getState().addTab(DIRECTORY, 'https://docs.example.com/');
    const workspace = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY];
    expect(workspace?.tabs).toHaveLength(2);
    expect(secondId).not.toBe(first?.tabs[0]?.id);
    expect(workspace?.activeTabId).toBe(secondId);
  });

  test('updates, activates, and reorders only browser tabs in one directory', () => {
    const first = useManualBrowserTabsStore.getState().ensureWorkspace(DIRECTORY)!;
    const firstId = first.tabs[0]!.id;
    const secondId = useManualBrowserTabsStore.getState().addTab(DIRECTORY)!;
    useManualBrowserTabsStore.getState().updateTabUrl(DIRECTORY, secondId, 'localhost:3000/path');
    useManualBrowserTabsStore.getState().activateTab(DIRECTORY, firstId);
    useManualBrowserTabsStore.getState().reorderTabs(DIRECTORY, secondId, firstId);
    const workspace = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]!;
    expect(workspace.activeTabId).toBe(firstId);
    expect(workspace.tabs.map((tab) => tab.id)).toEqual([secondId, firstId]);
    expect(workspace.tabs[0]?.url).toBe('http://localhost:3000/path');
  });

  test('closing the active tab selects its adjacent tab', () => {
    const workspace = useManualBrowserTabsStore.getState().ensureWorkspace(DIRECTORY)!;
    const firstId = workspace.tabs[0]!.id;
    const secondId = useManualBrowserTabsStore.getState().addTab(DIRECTORY)!;
    const thirdId = useManualBrowserTabsStore.getState().addTab(DIRECTORY)!;
    useManualBrowserTabsStore.getState().activateTab(DIRECTORY, secondId);
    useManualBrowserTabsStore.getState().closeTab(DIRECTORY, secondId);
    const next = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]!;
    expect(next.tabs.map((tab) => tab.id)).toEqual([firstId, thirdId]);
    expect(next.activeTabId).toBe(thirdId);
  });

  test('closing the final tab replaces it with one blank tab', () => {
    const workspace = useManualBrowserTabsStore.getState().ensureWorkspace(DIRECTORY, 'https://example.com/')!;
    const firstId = workspace.tabs[0]!.id;
    useManualBrowserTabsStore.getState().closeTab(DIRECTORY, firstId);
    const next = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]!;
    expect(next.tabs).toHaveLength(1);
    expect(next.tabs[0]?.id).not.toBe(firstId);
    expect(next.tabs[0]?.url).toBe('about:blank');
    expect(next.tabs[0]?.label).toBe('New tab');
  });

  test('keeps workspaces isolated by directory and supports explicit clearing', () => {
    useManualBrowserTabsStore.getState().ensureWorkspace(DIRECTORY, 'https://one.example/');
    useManualBrowserTabsStore.getState().ensureWorkspace('/repo/Other', 'https://two.example/');
    useManualBrowserTabsStore.getState().clearWorkspace(DIRECTORY);
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]).toBe(undefined);
    expect(useManualBrowserTabsStore.getState().byDirectory['/repo/Other']?.tabs[0]?.label).toBe('two.example');
  });

  test('sanitizes persisted workspaces, URLs, active identity, and duplicate tabs', () => {
    const sanitized = sanitizeManualBrowserWorkspaces({
      [`${DIRECTORY}/`]: {
        workspaceId: 'workspace-a',
        activeTabId: 'missing',
        touchedAt: 12,
        tabs: [
          { id: 'tab-a', url: 'javascript:alert(1)', label: '' },
          { id: 'tab-a', url: 'https://duplicate.example/' },
          { id: 'tab-b', url: 'https://example.com/docs', label: 'Docs' },
        ],
      },
    });
    expect(sanitized[DIRECTORY]?.tabs).toEqual([
      { id: 'tab-a', url: 'about:blank', label: 'New tab' },
      { id: 'tab-b', url: 'https://example.com/docs', label: 'Docs' },
    ]);
    expect(sanitized[DIRECTORY]?.activeTabId).toBe('tab-a');
    expect(sanitizeManualBrowserWorkspace({ workspaceId: 'empty', tabs: [] })).toBeNull();
  });

  test('replaces a workspace from a validated detached-window snapshot', () => {
    useManualBrowserTabsStore.getState().ensureWorkspace(DIRECTORY);
    useManualBrowserTabsStore.getState().replaceWorkspace(DIRECTORY, {
      workspaceId: 'workspace-restored',
      activeTabId: 'tab-b',
      tabs: [
        { id: 'tab-a', url: 'https://one.example/' },
        { id: 'tab-b', url: 'https://two.example/' },
      ],
      touchedAt: 99,
    });
    const workspace = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]!;
    expect(workspace.workspaceId).toBe('workspace-restored');
    expect(workspace.activeTabId).toBe('tab-b');
    expect(workspace.tabs.map((tab) => tab.label)).toEqual(['one.example', 'two.example']);
  });
});
