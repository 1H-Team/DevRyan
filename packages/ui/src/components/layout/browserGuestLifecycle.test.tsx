import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withDom } from '@/test/mountedDom';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import { useTerminalStore, type DirectoryTerminalState, type TerminalTab } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';

type StoreModule = typeof import('@/stores/useBrowserAgentStore');
type OwnerModule = typeof import('./localPreviewInstances');

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const host = () => globalThis as unknown as { window: Record<string, unknown> };
const saved = new Map<string, PropertyDescriptor | undefined>();
const stash = (key: string) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); };

let moduleCounter = 0;
const freshStore = async () => {
  moduleCounter += 1;
  // The module keeps install-once state, so each case imports its own copy.
  return await import(`@/stores/useBrowserAgentStore?fresh=${moduleCounter}`) as StoreModule;
};

const leaseSnapshot = (revision: number, leaseIds: string[]) => ({
  revision,
  leases: leaseIds.map((leaseId) => ({
    leaseId,
    rootSessionId: 'root',
    opencodeSessionID: 'child',
    directory: '/repo/project',
    url: 'http://localhost:3000/',
  })),
});

const installRenderer = (options: { electron: boolean; localOrigin: boolean; invoke?: (command: string) => Promise<unknown> }) => {
  const target = new EventTarget();
  const listenerTypes: string[] = [];
  const invoked: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      addEventListener: (type: string, listener: EventListener) => { listenerTypes.push(type); target.addEventListener(type, listener); },
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      location: { href: 'https://remote.example/', origin: options.localOrigin ? 'http://127.0.0.1:3000' : 'https://remote.example', search: '' },
      ...(options.electron ? { __DEVRYAN_ELECTRON__: { runtime: 'electron' } } : {}),
      ...(options.localOrigin ? { __DEVRYAN_LOCAL_ORIGIN__: 'http://127.0.0.1:3000' } : {}),
      __TAURI__: {
        core: {
          invoke: async (command: string) => {
            invoked.push(command);
            return options.invoke ? options.invoke(command) : null;
          },
        },
      },
    },
  });
  return { target, listenerTypes, invoked };
};

beforeEach(() => {
  stash('window');
  useUIStore.setState({ browserLeaseTabsByDirectory: {}, activeBrowserLeaseIdByDirectory: {}, browserPanelByDirectory: {} });
});
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

describe('browser lease snapshots', () => {
  test('accepts lease snapshots only in a local Electron renderer and prunes tabs of removed leases', async () => {
    const renderer = installRenderer({ electron: true, localOrigin: true, invoke: async () => leaseSnapshot(1, ['lease-a']) });
    const store = await freshStore();
    useUIStore.getState().openBrowserLease('/repo/project', { leaseId: 'lease-a', rootSessionId: 'root', url: 'http://localhost:3000/', label: 'a' } as never);
    useUIStore.getState().openBrowserLease('/repo/project', { leaseId: 'lease-b', rootSessionId: 'root', url: 'http://localhost:3000/', label: 'b' } as never);

    store.ensureBrowserAgentListeners();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The first authoritative snapshot, fetched after listening, removes lease-b's tab.
    expect(renderer.invoked).toContain('desktop_browser_lease_snapshot');
    expect(store.useBrowserAgentStore.getState().leaseIds).toEqual(['lease-a']);
    expect(useUIStore.getState().browserLeaseTabsByDirectory['/repo/project']?.map((tab) => tab.leaseId)).toEqual(['lease-a']);

    // Later pushes from the shell replace the set and prune again.
    renderer.target.dispatchEvent(Object.assign(new Event('browser-agent-leases'), { detail: leaseSnapshot(2, []) }));
    expect(store.useBrowserAgentStore.getState().leaseIds).toEqual([]);
    expect(useUIStore.getState().browserLeaseTabsByDirectory['/repo/project'] ?? []).toHaveLength(0);
  });

  test('ignores stale revisions pushed by the shell', async () => {
    const renderer = installRenderer({ electron: true, localOrigin: true });
    const store = await freshStore();
    store.ensureBrowserAgentListeners();
    renderer.target.dispatchEvent(Object.assign(new Event('browser-agent-leases'), { detail: leaseSnapshot(5, ['lease-new']) }));
    renderer.target.dispatchEvent(Object.assign(new Event('browser-agent-leases'), { detail: leaseSnapshot(4, ['lease-old']) }));

    expect(store.useBrowserAgentStore.getState().leaseIds).toEqual(['lease-new']);
  });

  test('listens for lease snapshots only, never the retired agent status or wake events', async () => {
    const renderer = installRenderer({ electron: true, localOrigin: true });
    const store = await freshStore();
    store.ensureBrowserAgentListeners();

    expect(renderer.listenerTypes).toContain('browser-agent-leases');
    expect(renderer.listenerTypes).not.toContain('browser-agent-status');
    expect(renderer.listenerTypes).not.toContain('browser-agent-wake-request');
  });

  test('installs nothing outside a local Electron renderer', async () => {
    for (const options of [{ electron: false, localOrigin: false }, { electron: true, localOrigin: false }]) {
      const renderer = installRenderer(options);
      const store = await freshStore();
      store.ensureBrowserAgentListeners();
      renderer.target.dispatchEvent(Object.assign(new Event('browser-agent-leases'), { detail: leaseSnapshot(1, ['lease-a']) }));

      expect(renderer.listenerTypes).toEqual([]);
      expect(renderer.invoked).toEqual([]);
      expect(store.useBrowserAgentStore.getState().leaseIds).toEqual([]);
    }
  });

  test('installs its listeners once', async () => {
    const renderer = installRenderer({ electron: true, localOrigin: true });
    const store = await freshStore();
    store.ensureBrowserAgentListeners();
    store.ensureBrowserAgentListeners();

    expect(renderer.listenerTypes.filter((type) => type === 'browser-agent-leases')).toHaveLength(1);
    expect(renderer.invoked.filter((command) => command === 'desktop_browser_lease_snapshot')).toHaveLength(1);
  });
});

const terminalTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'tab-1',
  terminalSessionId: 'terminal-1',
  lifecycle: 'running',
  label: 'Action: web',
  iconKey: null,
  bufferChunks: [],
  bufferLength: 0,
  isConnecting: false,
  createdAt: 1,
  previewUrl: 'http://localhost:3001/',
  previewAutoOpened: false,
  previewUrlLocked: false,
  ...overrides,
});
const sessionsWith = (tabs: TerminalTab[]) => new Map<string, DirectoryTerminalState>([
  ['/repo/project', { tabs, activeTabId: tabs[0]?.id ?? null }],
]);

describe('project preview grant owner', () => {
  const originalSessions = useTerminalStore.getState().sessions;
  const originalPrincipal = getAuthPrincipal();
  afterEach(() => {
    useTerminalStore.setState({ sessions: originalSessions });
    setAuthPrincipal(originalPrincipal);
  });

  const mountOwner = async (run: (ctx: {
    registrations: Array<Record<string, unknown>>;
    windowTarget: EventTarget;
    intervals: Map<number, { callback: () => void; every: number }>;
    owner: OwnerModule;
  }) => Promise<void>) => withDom(async (container) => {
    stash('fetch');
    const registrations: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/preview/instances/register') registrations.push(JSON.parse(String(init?.body)));
      return Response.json({ instance: { id: 'grant' } });
    }) as typeof fetch;
    const windowTarget = new EventTarget();
    const intervals = new Map<number, { callback: () => void; every: number }>();
    let nextId = 1;
    const window = host().window;
    window.addEventListener = windowTarget.addEventListener.bind(windowTarget);
    window.removeEventListener = windowTarget.removeEventListener.bind(windowTarget);
    window.setInterval = (callback: () => void, every: number) => { intervals.set(nextId, { callback, every }); return nextId++; };
    window.clearInterval = (id: number) => { intervals.delete(id); };
    window.__DEVRYAN_ELECTRON__ = { runtime: 'electron' };
    const owner = await import('./localPreviewInstances');
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<owner.ProjectPreviewGrantOwner />); });
      await run({ registrations, windowTarget, intervals, owner });
    } finally {
      await act(async () => { root.unmount(); });
      expect(intervals.size).toBe(0);
    }
  });

  test('registers terminal-discovered project apps without any Browser presentation open', async () => {
    useTerminalStore.setState({ sessions: sessionsWith([terminalTab()]) });
    await mountOwner(async ({ registrations }) => {
      await act(async () => { await Promise.resolve(); });
      expect(useUIStore.getState().browserPanelByDirectory['/repo/project']?.isOpen ?? false).toBe(false);
      expect(registrations).toEqual([{
        directory: '/repo/project',
        terminalSessionId: 'terminal-1',
        url: 'http://127.0.0.1:3001/',
        label: 'web',
      }]);
    });
  });

  test('registers new previews as the terminal store changes and does not re-register an unchanged one early', async () => {
    useTerminalStore.setState({ sessions: sessionsWith([terminalTab()]) });
    await mountOwner(async ({ registrations }) => {
      await act(async () => { await Promise.resolve(); });
      expect(registrations).toHaveLength(1);

      await act(async () => {
        useTerminalStore.setState({ sessions: sessionsWith([terminalTab(), terminalTab({ id: 'tab-2', terminalSessionId: 'terminal-2', previewUrl: 'http://localhost:4000/' })]) });
        await Promise.resolve();
      });
      await act(async () => { await Promise.resolve(); });
      expect(registrations.map((entry) => entry.terminalSessionId)).toEqual(['terminal-1', 'terminal-2']);
    });
  });

  test('registers even when the signed-in user has no Browser capability', async () => {
    const base = getAuthPrincipal();
    setAuthPrincipal({ ...base, id: 'no-browser', scope: 'managed', role: 'developer', policy: { ...base.policy, browser: false } } as never);
    useTerminalStore.setState({ sessions: sessionsWith([terminalTab()]) });
    await mountOwner(async ({ registrations }) => {
      await act(async () => { await Promise.resolve(); });
      expect(registrations).toHaveLength(1);
    });
  });

  test('re-registers everything when the connection comes back, and refreshes on a three-second poll', async () => {
    useTerminalStore.setState({ sessions: sessionsWith([terminalTab()]) });
    await mountOwner(async ({ registrations, windowTarget, intervals }) => {
      await act(async () => { await Promise.resolve(); });
      expect(registrations).toHaveLength(1);
      expect([...intervals.values()].map((entry) => entry.every)).toEqual([3_000]);

      await act(async () => {
        windowTarget.dispatchEvent(new CustomEvent('devryan:connection-status', { detail: { status: 'disconnected' } }));
        await Promise.resolve();
      });
      expect(registrations).toHaveLength(1);

      await act(async () => {
        windowTarget.dispatchEvent(new CustomEvent('devryan:connection-status', { detail: { status: 'connected' } }));
        await Promise.resolve();
      });
      await act(async () => { await Promise.resolve(); });
      expect(registrations).toHaveLength(2);
    });
  });
});

// These live in components that cannot be rendered without the desktop bridge or their
// full store graph (DesktopBrowserPane, AppEffects, ProjectActionsButton), so they stay pins.
describe('browser guest wiring in desktop-bridge components', () => {
  const browserPane = read('./DesktopBrowserPane.tsx');
  const projectActions = read('./ProjectActionsButton.tsx');
  const appEffects = read('../../apps/AppEffects.tsx');

  test('keeps manual browser pages on the dedicated active-or-retained workspace policy', () => {
    expect(browserPane).toContain('const isMounted = isActive || retainedTabIds.has(tab.id);');
    expect(browserPane).toContain('sleepDelayMs: BROWSER_PAGE_SLEEP_DELAY_MS');
  });

  test('uses the main-owned lease surface and never starts the retired global bridge', () => {
    expect(browserPane).toContain("const surfaceId = leaseId ? (lease?.surfaceId ?? '') : manualSurfaceId;");
    expect(browserPane).toContain("invokeDesktop<unknown>('desktop_browser_surface_snapshot', { surfaceId })");
    expect(browserPane).not.toContain('<webview');
    expect(browserPane).not.toContain('webContentsId');
    expect(browserPane).not.toContain("invokeDesktop('desktop_browser_cdp_start')");
    expect(browserPane).not.toContain("window.addEventListener('browser-agent-status'");
  });

  test('scopes the top-right activity dot and dropdown to the selected root', () => {
    expect(projectActions).toContain('resolveRootSessionID(currentSessionId, sessions)');
    expect(projectActions).toContain('claimBrowserAgentWindowContext(selectedRootSessionId, normalizedDirectory)');
    expect(projectActions).toContain('browserAgentLeaseSelectors.leaseIdsForRoot(selectedRootSessionId)');
    expect(projectActions).toContain('data-browser-lease-active="true"');
    expect(projectActions).toContain('absolute -right-1 -top-1 h-2 w-2');
    expect(projectActions).not.toContain('{rootLeaseCount > 99');
    expect(projectActions).toContain('rootLeaseIds.map((leaseId) => (');
    expect(projectActions).toContain('isManagedBrowserRuntime ? (');
  });

  test('claims authoritative background roots and worktree session families', () => {
    expect(appEffects).toContain('childStores.subscribeSessionLists');
    expect(appEffects).toContain('Object.values(useManagedOrchestrationStore.getState().tasksById)');
    expect(appEffects).toContain('collectBrowserAgentWindowContexts');
    expect(appEffects).toContain('await claimBrowserAgentWindowContexts(claim.contexts)');
    expect(appEffects).toContain('const retryDelays = [250, 500, 1_000, 2_000]');
    expect(appEffects).toContain('if (claim.generation !== generation) continue');
    expect(appEffects).toContain('pending = { ...claim, retry: claim.retry + 1 }');
    expect(appEffects).toContain('committedClaimSignature = claim.signature');
    expect(appEffects).toContain("window.addEventListener('devryan:connection-status', handleConnectionStatus)");
    expect(appEffects).toContain('if (retryTimer) clearTimeout(retryTimer)');
    expect(appEffects).toContain('<ProjectPreviewGrantOwner />');
  });

  test('keeps Back non-destructive and the manual action after a separator', () => {
    const backIndex = projectActions.indexOf('data-browser-lease-back="true"');
    const separatorIndex = projectActions.indexOf('<DropdownMenuSeparator />', backIndex);
    const manualIndex = projectActions.indexOf("t('header.actions.browserLeases.manual')", separatorIndex);

    expect(backIndex).toBeGreaterThan(-1);
    expect(projectActions.slice(backIndex, separatorIndex)).not.toContain('stop');
    expect(separatorIndex).toBeGreaterThan(backIndex);
    expect(manualIndex).toBeGreaterThan(separatorIndex);
  });

  test('keeps Browser presentation out of the preview registration owner', () => {
    const localPreviewInstances = read('./localPreviewInstances.ts');

    expect(localPreviewInstances).not.toContain("hasAuthCapability(principal, 'browser')");
    expect(browserPane).not.toContain('registerProjectPreviewInstance({');
  });
});
