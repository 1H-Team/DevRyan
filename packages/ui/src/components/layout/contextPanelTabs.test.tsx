import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { VALID_TABS } from '@/lib/router/types';
import { parseRoute } from '@/lib/router/parseRoute';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import { useUIStore } from '@/stores/useUIStore';

mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ setThemeMode() {} }) }));
const { useMenuActions } = await import('@/hooks/useMenuActions');

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('context panel tabs', () => {
  test('keeps Browser out of the shared context-panel tab model', () => {
    const contextPanel = read('./ContextPanel.tsx');

    expect(contextPanel).not.toContain("mode === 'browser'");
    expect(contextPanel).not.toContain('<ManualBrowserWorkspacePane');
  });

  // ContextPanel needs its full chat/session store graph; its structure stays a pin.
  test('renders the soft-pill tab strip and a borderless header, and still owns the file editor mount', () => {
    const contextPanel = read('./ContextPanel.tsx');

    expect(contextPanel).toContain('variant="soft-pill"');
    expect(contextPanel).not.toContain('variant="default"');
    expect(contextPanel).toContain('<header className="flex h-8 items-stretch pl-1.5">');
    expect(contextPanel).toContain('<LazyFilesView visible={isOpen && isFileTabActive} />');
  });
});

describe('removed files main tab', () => {
  test('is gone from the URL router: ?tab=files resolves to no tab', () => {
    expect(VALID_TABS).toEqual(['chat', 'git', 'diff', 'terminal']);
    expect(parseRoute(new URLSearchParams('tab=files')).tab).toBeNull();
    expect(parseRoute(new URLSearchParams('tab=FILES')).tab).toBeNull();
    for (const tab of VALID_TABS) {
      expect(parseRoute(new URLSearchParams(`tab=${tab}`)).tab).toBe(tab);
    }
  });

  test('migrates a stale persisted value so it cannot render a blank view', () => {
    const persistApi = (useUIStore as unknown as {
      persist: { getOptions: () => { migrate?: (state: unknown, version: number) => unknown } };
    }).persist;
    const migrate = persistApi.getOptions().migrate;

    expect(((migrate as (state: unknown, version: number) => { activeMainTab: string })({ activeMainTab: 'files' }, 9)).activeMainTab).toBe('chat');
    // Other persisted tabs are left alone.
    expect(((migrate as (state: unknown, version: number) => { activeMainTab: string })({ activeMainTab: 'diff' }, 9)).activeMainTab).toBe('diff');
  });

  // The remaining former-tab references are type errors now ('files' is not a MainTab), so
  // `bun run typecheck` is the surviving guard for MainLayout, Header and useMenuActions.
});

describe('desktop Files menu item', () => {
  const originalPrincipal = getAuthPrincipal();
  const saved = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const key of ['window']) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    useUIStore.setState({ isRightSidebarOpen: false, rightSidebarTab: 'git' as never, activeMainTab: 'chat' });
  });
  afterEach(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    setAuthPrincipal(originalPrincipal);
  });

  const withMenu = async (run: (fire: (action: string) => Promise<void>) => Promise<void>) => withDom(async (container) => {
    const windowTarget = new EventTarget();
    const host = globalThis as unknown as { window: Record<string, unknown> };
    host.window.addEventListener = windowTarget.addEventListener.bind(windowTarget);
    host.window.removeEventListener = windowTarget.removeEventListener.bind(windowTarget);
    host.window.dispatchEvent = windowTarget.dispatchEvent.bind(windowTarget);
    const Probe: React.FC = () => { useMenuActions(); return null; };
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<Probe />); });
      await run(async (action) => {
        await act(async () => { windowTarget.dispatchEvent(new CustomEvent('devryan:menu-action', { detail: action })); });
      });
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  test('reveals the right-sidebar file tree instead of restoring a main tab', async () => {
    await withMenu(async (fire) => {
      await fire('open-files-tab');
      expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
      expect(useUIStore.getState().rightSidebarTab).toBe('files');
      expect(useUIStore.getState().activeMainTab).toBe('chat');
    });
  });

  test('does nothing without the files capability', async () => {
    const base = getAuthPrincipal();
    setAuthPrincipal({ ...base, id: 'no-files', scope: 'managed', role: 'developer', policy: { ...base.policy, files: false } } as never);
    await withMenu(async (fire) => {
      await fire('open-files-tab');
      expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
      expect(useUIStore.getState().rightSidebarTab).toBe('git');
    });
  });
});

// FilesView (a ~3k-line editor) cannot be rendered in isolation, so the removal of its tab strip stays a pin.
describe('FilesView single-mode editor', () => {
  test('leaves FilesView as a single-mode editor with no orphaned tab strip', () => {
    const filesView = read('../views/FilesView.tsx');
    const tabsStore = read('../../stores/useFilesViewTabsStore.ts');

    expect(filesView).not.toContain('FilesViewProps');
    expect(filesView).not.toContain("mode === 'editor-only'");
    expect(filesView).not.toContain('SortableTabsStrip');
    expect(filesView).not.toContain('fullscreenViewer');
    expect(filesView).not.toContain('isFullscreen');
    expect(tabsStore).not.toContain('reorderOpenPaths');
  });

  test('keeps the mobile tree and filename dropdown reachable', () => {
    const filesView = read('../views/FilesView.tsx');

    expect(filesView).toContain('const showEditorTabsRow = isMobile;');
    expect(filesView).toContain('treePanel');
    expect(filesView).toContain("aria-label={t('filesView.editor.openFilesAria')}");
  });
});
