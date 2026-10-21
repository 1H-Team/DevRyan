import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { HostElement, withDom } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { setAuthPrincipal } from '@/lib/authSession';
import * as syncRefs from '@/sync/sync-refs';
import type { Session } from '@opencode-ai/sdk/v2';

const DIRECTORY = '/repo/panel';

// The native panes need the desktop bridge. They are replaced by probes that record
// how BrowserPanel drives them; BrowserPanel itself runs for real.
mock.module('./DesktopBrowserPane', () => ({
  BrowserTabsBar: (props: {
    tabs: ReadonlyArray<{ id: string }>;
    leaseTabs?: ReadonlyArray<{ leaseId: string }>;
    trailingActions?: React.ReactNode;
    onAdd: () => void;
    onCloseLease?: (leaseId: string) => void;
    onSelectLease?: (leaseId: string) => void;
  }) => (
    <div data-tabs-bar="true" data-manual={props.tabs.map((tab) => tab.id).join(',')} data-leases={(props.leaseTabs ?? []).map((tab) => tab.leaseId).join(',')}>
      <button type="button" aria-label="probe-add" onClick={props.onAdd} />
      {(props.leaseTabs ?? []).map((tab) => (
        <button key={tab.leaseId} type="button" aria-label={`probe-select-${tab.leaseId}`} onClick={() => props.onSelectLease?.(tab.leaseId)} />
      ))}
      {(props.leaseTabs ?? []).map((tab) => (
        <button key={`close-${tab.leaseId}`} type="button" aria-label={`probe-close-${tab.leaseId}`} onClick={() => props.onCloseLease?.(tab.leaseId)} />
      ))}
      {props.trailingActions}
    </div>
  ),
  ManualBrowserWorkspacePane: (props: { directory: string; active: boolean; showTabStrip?: boolean }) => (
    <div data-manual-pane={props.directory} data-active={String(props.active)} data-tab-strip={String(props.showTabStrip)} />
  ),
  DesktopBrowserPane: (props: { leaseId?: string; active: boolean; tabID: string }) => (
    <div data-lease-surface={props.leaseId} data-active={String(props.active)} data-tab-id={props.tabID} />
  ),
}));

const syncContext = await import('@/sync/sync-context');
const sessionsById = new Map<string, Session>();
const actualSyncContext = { ...syncContext };
mock.module('@/sync/sync-context', () => ({
  ...actualSyncContext,
  useSession: (id?: string | null) => (id ? sessionsById.get(id) : undefined),
}));
const effectiveDirectory = { current: DIRECTORY as string | undefined };
const actualEffective = await import('@/hooks/useEffectiveDirectory');
mock.module('@/hooks/useEffectiveDirectory', () => ({
  ...actualEffective,
  useEffectiveDirectory: () => effectiveDirectory.current,
}));

const { BrowserPanel } = await import('./BrowserPanel');
const { useUIStore } = await import('@/stores/useUIStore');
const { useManualBrowserTabsStore } = await import('@/stores/useManualBrowserTabsStore');
const { useBrowserAgentStore } = await import('@/stores/useBrowserAgentStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');

const sessionsSpy: { current: ReturnType<typeof spyOn<typeof syncRefs, 'getAllSyncSessions'>> | null } = { current: null };
const session = (id: string, parentID?: string) => ({ id, parentID, directory: DIRECTORY }) as unknown as Session;

const lease = (leaseId: string, rootSessionId: string) => ({
  leaseId,
  rootSessionId,
  url: 'https://example.test/',
  directory: DIRECTORY,
  label: leaseId,
});

const publishLeases = (leaseIds: string[], revision: number, transport: 'native' | 'stream' = 'native') => {
  useBrowserAgentStore.getState().applySnapshot({
    revision,
    leases: leaseIds.map((leaseId) => ({
      leaseId,
      rootSessionId: 'root-b',
      // Native leases carry the OpenCode session and directory; tunneled ones do not.
      ...(transport === 'native' ? { opencodeSessionID: `${leaseId}-child`, directory: DIRECTORY } : {}),
      url: 'https://example.test/',
      title: leaseId,
      hostname: 'example.test',
      surfaceId: `surface-${leaseId}`,
      agent: 'builder',
    })),
  });
};

type Mounted = {
  container: HostElement;
  windowTarget: EventTarget;
  rerender: () => Promise<void>;
  find: (predicate: (node: HostElement) => boolean) => HostElement | null;
  findAll: (predicate: (node: HostElement) => boolean) => HostElement[];
  press: (label: string) => Promise<void>;
  pointer: (target: HostElement, type: 'pointerdown' | 'pointermove' | 'pointerup', init: { pointerId?: number; clientX?: number }) => Promise<void>;
};

const collect = (root: HostElement, predicate: (node: HostElement) => boolean): HostElement[] => {
  const matches: HostElement[] = [];
  const visit = (node: HostElement) => {
    if (predicate(node)) matches.push(node);
    for (const child of node.childNodes) if (child instanceof HostElement) visit(child);
  };
  visit(root);
  return matches;
};

const mountPanel = async (run: (mounted: Mounted) => Promise<void>) => withDom(async (container) => {
  const host = globalThis as unknown as { window: Record<string, unknown> };
  const windowTarget = new EventTarget();
  host.window.addEventListener = windowTarget.addEventListener.bind(windowTarget);
  host.window.removeEventListener = windowTarget.removeEventListener.bind(windowTarget);
  host.window.location = { search: '', pathname: '/', hash: '', href: 'https://remote.example/', origin: 'https://remote.example' };
  // A non-local origin keeps the native lease-observation bridge out of these tests.
  // The Browser panel only mounts native panes in a supported (Electron or standalone web) runtime.
  host.window.__DEVRYAN_ELECTRON__ = { runtime: 'electron' };
  Object.defineProperty(HostElement.prototype, 'children', {
    configurable: true,
    get(this: HostElement) { return this.childNodes.filter((child) => child instanceof HostElement); },
  });
  Object.defineProperty(HostElement.prototype, 'dataset', { configurable: true, get: () => ({}) });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const find = (predicate: (node: HostElement) => boolean) => container.find(predicate);
  const attr = (name: string, value: string) => (node: HostElement) => node.getAttribute(name) === value;
  try {
    await act(async () => { root.render(<I18nProvider><BrowserPanel /></I18nProvider>); });
    await run({
      container,
      windowTarget,
      rerender: async () => { await act(async () => { root.render(<I18nProvider><BrowserPanel /></I18nProvider>); }); },
      find,
      findAll: (predicate) => collect(container, predicate),
      press: async (label) => {
        const button = find(attr('aria-label', label));
        expect(button).not.toBeNull();
        await act(async () => { button?.click(); });
      },
      pointer: async (target, type, init) => {
        const event = { type, target, bubbles: true, button: 0, pointerId: 1, clientX: 0, ...init, preventDefault() {}, stopPropagation() {} };
        await act(async () => {
          // React registers its capture and bubble listeners on the root container.
          for (const listener of container.listeners.get(type) ?? []) listener(event);
          windowTarget.dispatchEvent(Object.assign(new Event(type), { pointerId: event.pointerId, clientX: event.clientX }));
        });
      },
    });
  } finally {
    await act(async () => { root.unmount(); });
    Reflect.deleteProperty(HostElement.prototype, 'children');
    Reflect.deleteProperty(HostElement.prototype, 'dataset');
  }
});

beforeEach(() => {
  setAuthPrincipal(null);
  effectiveDirectory.current = DIRECTORY;
  sessionsById.clear();
  useUIStore.setState({
    contextPanelByDirectory: {},
    browserPanelByDirectory: {},
    browserLeaseTabsByDirectory: {},
    activeBrowserLeaseIdByDirectory: {},
  });
  useManualBrowserTabsStore.setState({ byDirectory: {} });
  useBrowserAgentStore.setState({ revision: -1, leasesById: new Map(), leaseIds: [], leaseIdsByRoot: new Map(), activeLeaseCount: 0, observedLeaseId: null });
  useSessionUIStore.setState({ currentSessionId: null } as never);
});
afterEach(() => setAuthPrincipal(null));

const attrOf = (node: HostElement | null, name: string) => node?.getAttribute(name) ?? null;
const panelOf = (mounted: Mounted) => mounted.find((node) => node.getAttribute('data-browser-panel') === 'true');
const panes = (mounted: Mounted, attribute: string) => mounted.findAll((node) => node.hasAttribute(attribute));

describe('dedicated Browser panel', () => {
  test('stays mounted but inert and hidden while closed', async () => {
    await mountPanel(async (mounted) => {
      const panel = panelOf(mounted);
      expect(attrOf(panel, 'aria-hidden')).toBe('true');
      expect(attrOf(panel, 'class')).toContain('pointer-events-none fixed inset-0 -z-10 opacity-0');
      expect(mounted.find((node) => node.getAttribute('data-panel-resize-handle') === 'browser-panel')).toBeNull();
      expect(panes(mounted, 'data-manual-pane')).toHaveLength(0);
    });
  });

  test('opens as an in-flow sibling with its own resize handle, tab bar and manual workspace', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => { useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.test/'); });
      const panel = panelOf(mounted);
      expect(attrOf(panel, 'aria-hidden')).toBe('false');
      expect(attrOf(panel, 'class')).toContain('relative h-full flex-shrink-0 border-l');
      expect(mounted.find((node) => node.getAttribute('data-panel-resize-handle') === 'browser-panel')).not.toBeNull();
      expect(mounted.find((node) => node.getAttribute('data-tabs-bar') === 'true')).not.toBeNull();
      const manual = panes(mounted, 'data-manual-pane');
      expect(manual).toHaveLength(1);
      expect(attrOf(manual[0], 'data-manual-pane')).toBe(DIRECTORY);
      expect(attrOf(manual[0], 'data-active')).toBe('true');
      expect(attrOf(manual[0], 'data-tab-strip')).toBe('false');
    });
  });

  test('fullscreen toggles expand and collapse and drops the resize handle', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => { useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.test/'); });
      await mounted.press('Expand Panel');
      expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.expanded).toBe(true);
      expect(attrOf(panelOf(mounted), 'class')).toContain('absolute inset-0 z-20 min-w-0');
      expect(mounted.find((node) => node.getAttribute('data-panel-resize-handle') === 'browser-panel')).toBeNull();

      await mounted.press('Collapse Panel');
      expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.expanded).toBe(false);
      expect(mounted.find((node) => node.getAttribute('data-panel-resize-handle') === 'browser-panel')).not.toBeNull();
    });
  });

  test('the close button and Escape both close the panel', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => { useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.test/'); });
      await mounted.press('Close Panel');
      expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(false);

      await act(async () => { useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.test/'); });
      const panel = panelOf(mounted) as HostElement;
      let prevented = false;
      await act(async () => {
        for (const listener of mounted.container.listeners.get('keydown') ?? []) {
          listener({ type: 'keydown', key: 'Escape', target: panel, bubbles: true, preventDefault() { prevented = true; }, stopPropagation() {} });
        }
      });
      expect(prevented).toBe(true);
      expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(false);
    });
  });

  test('persists the dragged width, clamped, when the resize handle is released', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => { useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.test/'); });
      const startWidth = useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.width ?? 600;
      const handle = mounted.find((node) => node.getAttribute('data-panel-resize-handle') === 'browser-panel') as HostElement;
      await mounted.pointer(handle, 'pointerdown', { pointerId: 7, clientX: 500 });
      // Dragging left widens the right-hand panel.
      await mounted.pointer(handle, 'pointermove', { pointerId: 7, clientX: 400 });
      await mounted.pointer(handle, 'pointerup', { pointerId: 7, clientX: 400 });
      expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.width).toBe(startWidth + 100);
    });
  });

  test('only shows the tab bar when there is a manual workspace or a lease', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => {
        useUIStore.setState({ browserPanelByDirectory: { [DIRECTORY]: { isOpen: true, expanded: false, width: 600, touchedAt: 1 } as never } });
      });
      expect(mounted.find((node) => node.getAttribute('data-tabs-bar') === 'true')).toBeNull();
      await act(async () => { useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.test/'); });
      expect(mounted.find((node) => node.getAttribute('data-tabs-bar') === 'true')).not.toBeNull();
    });
  });

  test('keeps the manual workspace inactive while the context panel is expanded', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => { useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.test/'); });
      expect(attrOf(panes(mounted, 'data-manual-pane')[0], 'data-active')).toBe('true');
      await act(async () => {
        useUIStore.setState({ contextPanelByDirectory: { [DIRECTORY]: { isOpen: true, expanded: true, tabs: [], activeTabID: '' } as never } });
      });
      expect(attrOf(panes(mounted, 'data-manual-pane')[0], 'data-active')).toBe('false');
    });
  });
});

describe('session-scoped browser lease lifecycle', () => {
  const openLeases = (...ids: string[]) => {
    for (const id of ids) useUIStore.getState().openBrowserLease(DIRECTORY, lease(id, 'root-b'));
  };

  beforeEach(() => {
    sessionsById.set('root-b', session('root-b'));
    useSessionUIStore.setState({ currentSessionId: 'root-b' } as never);
    sessionsSpy.current = spyOn(syncRefs, 'getAllSyncSessions').mockImplementation(() => [session('root-b')] as never);
  });

  test('mounts one lease pane per live lease id, in order, and shows only the observed one', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => {
        publishLeases(['lease-a', 'lease-b'], 1);
        openLeases('lease-a', 'lease-b');
        useUIStore.getState().setActiveBrowserLease(DIRECTORY, 'lease-b');
      });
      const surfaces = panes(mounted, 'data-lease-surface');
      expect(surfaces.map((node) => node.getAttribute('data-lease-surface'))).toEqual(['lease-a', 'lease-b']);
      expect(surfaces.map((node) => node.getAttribute('data-active'))).toEqual(['false', 'true']);
      expect(surfaces.map((node) => node.getAttribute('data-tab-id'))).toEqual(['browser:lease:lease-a', 'browser:lease:lease-b']);

      // The inert wrappers stay mounted and paintable, but cannot take pointer input.
      const wrappers = panes(mounted, 'data-browser-lease-pane');
      expect(attrOf(wrappers[0], 'class')).toContain('z-0 pointer-events-none opacity-0');
      expect(attrOf(wrappers[1], 'class')).toContain('z-10 opacity-100');
      expect(attrOf(wrappers[0], 'class')).not.toContain('invisible');

      // A lease selection hands the manual workspace back its inactive state.
      expect(attrOf(panes(mounted, 'data-manual-pane')[0], 'data-active')).toBe('false');
    });
  });

  test('does not show a lease that is no longer live', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => {
        publishLeases(['lease-a'], 1);
        openLeases('lease-a', 'lease-gone');
        useUIStore.getState().setActiveBrowserLease(DIRECTORY, 'lease-gone');
      });
      const surfaces = panes(mounted, 'data-lease-surface');
      // lease-gone has no lease record, so BrowserLeasePane renders nothing for it.
      expect(surfaces.map((node) => node.getAttribute('data-lease-surface'))).toEqual(['lease-a']);
      expect(surfaces.every((node) => node.getAttribute('data-active') === 'false')).toBe(true);
    });
  });

  test('prunes every stale lease presentation on a root switch', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => {
        publishLeases(['lease-a', 'lease-b', 'lease-c'], 1);
        useUIStore.getState().openBrowserLease(DIRECTORY, lease('lease-a', 'root-a'));
        useUIStore.getState().openBrowserLease(DIRECTORY, lease('lease-b', 'root-b'));
        useUIStore.getState().openBrowserLease(DIRECTORY, lease('lease-c', 'root-c'));
      });
      expect(useUIStore.getState().browserLeaseTabsByDirectory[DIRECTORY]?.map((tab) => tab.leaseId)).toEqual(['lease-b']);
      expect(panes(mounted, 'data-lease-surface').map((node) => node.getAttribute('data-lease-surface'))).toEqual(['lease-b']);
    });
  });

  test('prunes a lease whose root no longer matches after the selected session changes', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => {
        publishLeases(['lease-b'], 1);
        openLeases('lease-b');
      });
      expect(useUIStore.getState().browserLeaseTabsByDirectory[DIRECTORY]).toHaveLength(1);

      sessionsById.set('root-z', session('root-z'));
      sessionsSpy.current?.mockImplementation(() => [session('root-z')] as never);
      await act(async () => { useSessionUIStore.setState({ currentSessionId: 'root-z' } as never); });
      await mounted.rerender();
      expect(useUIStore.getState().browserLeaseTabsByDirectory[DIRECTORY] ?? []).toHaveLength(0);
    });
  });

  test('keeps manual browser pages on the workspace pane and out of the lease fleet', async () => {
    await mountPanel(async (mounted) => {
      await act(async () => { useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.test/manual'); });
      expect(panes(mounted, 'data-manual-pane')).toHaveLength(1);
      expect(panes(mounted, 'data-lease-surface')).toHaveLength(0);
    });
  });
});

describe('tunneled lease presentation', () => {
  beforeEach(() => {
    sessionsById.set('root-b', session('root-b'));
    useSessionUIStore.setState({ currentSessionId: 'root-b' } as never);
    sessionsSpy.current = spyOn(syncRefs, 'getAllSyncSessions').mockImplementation(() => [session('root-b')] as never);
  });

  test('uses a view-only ephemeral stream, started only while active and stopped when hidden', async () => {
    const browserAgentApi = await import('@/lib/browserAgentApi');
    const started: string[] = [];
    const stopped: string[] = [];
    const start = spyOn(browserAgentApi, 'startBrowserAgentView').mockImplementation(async (leaseId: string) => {
      started.push(leaseId);
      return { id: `view-${leaseId}`, leaseId, streamUrl: `/api/browser/agent-leases/${leaseId}/views/view/stream`, startedAt: 'now' };
    });
    const stop = spyOn(browserAgentApi, 'stopBrowserAgentView').mockImplementation(async (view) => { stopped.push(view.leaseId); });
    try {
      await mountPanel(async (mounted) => {
        await act(async () => {
          publishLeases(['remote-a', 'remote-b'], 1, 'stream');
          useUIStore.getState().openBrowserLease(DIRECTORY, lease('remote-a', 'root-b'));
          useUIStore.getState().openBrowserLease(DIRECTORY, lease('remote-b', 'root-b'));
          useUIStore.getState().setActiveBrowserLease(DIRECTORY, 'remote-a');
        });
        // Tunneled leases never mount a native desktop surface.
        expect(panes(mounted, 'data-lease-surface')).toHaveLength(0);
        expect(started).toEqual(['remote-a']);
        const wrappers = panes(mounted, 'data-browser-lease-pane');
        expect(wrappers.map((node) => node.getAttribute('data-browser-lease-pane'))).toEqual(['remote-a', 'remote-b']);
        expect(mounted.container.textContent).toContain('View only');
        const image = mounted.find((node) => node.tagName === 'IMG');
        expect(attrOf(image, 'class')).toContain('pointer-events-none h-full w-full');

        await act(async () => { useUIStore.getState().setActiveBrowserLease(DIRECTORY, 'remote-b'); });
        expect(stopped).toEqual(['remote-a']);
        expect(started).toEqual(['remote-a', 'remote-b']);
      });
    } finally {
      start.mockRestore();
      stop.mockRestore();
    }
    expect(stopped).toEqual(['remote-a', 'remote-b']);
  });
});

describe('Browser panel ownership', () => {
  test('mounts after ContextPanel as its own in-flow sibling, and ContextPanel never mounts Browser panes', () => {
    const layout = readFileSync(new URL('./MainLayout.tsx', import.meta.url), 'utf8');
    const contextPanel = readFileSync(new URL('./ContextPanel.tsx', import.meta.url), 'utf8');

    expect(layout.indexOf('<ContextPanel />')).toBeLessThan(layout.indexOf('<BrowserPanel />'));
    expect(contextPanel).not.toContain('<ManualBrowserWorkspacePane');
    expect(contextPanel).not.toContain('BrowserLeasePane');
  });
});
