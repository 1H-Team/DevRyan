import { create } from 'zustand';

import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import {
  sanitizeBrowserViewportMode,
  type BrowserViewportMode,
} from '@/components/layout/browserViewport';
import { sanitizeBrowserFaviconUrl } from '@/components/layout/browserFavicon';

export { sanitizeBrowserFaviconUrl } from '@/components/layout/browserFavicon';

export type BrowserSurfaceSnapshot = {
  surfaceId: string;
  kind: 'manual' | 'lease';
  leaseId?: string;
  workspaceId?: string;
  tabId?: string;
  placement: 'inline' | 'popout' | 'parked';
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  devToolsOpen: boolean;
  viewportMode: BrowserViewportMode;
};

type BrowserSurfaceState = {
  byId: ReadonlyMap<string, BrowserSurfaceSnapshot>;
  surfaceIdByTabId: ReadonlyMap<string, string>;
  poppedManualTabIds: readonly string[];
  applySnapshot: (value: unknown, tabId?: string) => BrowserSurfaceSnapshot | null;
  removeSurface: (surfaceId: string) => void;
};

const MAX_ID_LENGTH = 220;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 1024;

const safeString = (value: unknown, maxLength: number): string => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

export const sanitizeBrowserSurfaceSnapshot = (value: unknown): BrowserSurfaceSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const surfaceId = safeString(candidate.surfaceId, MAX_ID_LENGTH);
  const kind = candidate.kind === 'manual' || candidate.kind === 'lease' ? candidate.kind : null;
  const placement = candidate.placement === 'inline'
    || candidate.placement === 'popout'
    || candidate.placement === 'parked'
    ? candidate.placement
    : null;
  if (!surfaceId || !kind || !placement) return null;
  const leaseId = safeString(candidate.leaseId, MAX_ID_LENGTH);
  const workspaceId = safeString(candidate.workspaceId, MAX_ID_LENGTH);
  const tabId = safeString(candidate.tabId, MAX_ID_LENGTH);
  const faviconUrl = sanitizeBrowserFaviconUrl(candidate.faviconUrl);
  return {
    surfaceId,
    kind,
    ...(leaseId ? { leaseId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(tabId ? { tabId } : {}),
    placement,
    url: safeString(candidate.url, MAX_URL_LENGTH) || 'about:blank',
    title: safeString(candidate.title, MAX_TITLE_LENGTH),
    ...(faviconUrl ? { faviconUrl } : {}),
    loading: candidate.loading === true,
    canGoBack: candidate.canGoBack === true,
    canGoForward: candidate.canGoForward === true,
    devToolsOpen: candidate.devToolsOpen === true,
    viewportMode: sanitizeBrowserViewportMode(candidate.viewportMode),
  };
};

const derivePoppedTabIds = (
  byId: ReadonlyMap<string, BrowserSurfaceSnapshot>,
  surfaceIdByTabId: ReadonlyMap<string, string>,
): readonly string[] => Array.from(surfaceIdByTabId)
  .filter(([, surfaceId]) => byId.get(surfaceId)?.placement === 'popout')
  .map(([tabId]) => tabId)
  .sort();

export const useBrowserSurfaceStore = create<BrowserSurfaceState>((set) => ({
  byId: new Map(),
  surfaceIdByTabId: new Map(),
  poppedManualTabIds: [],
  applySnapshot: (value, tabId) => {
    const snapshot = sanitizeBrowserSurfaceSnapshot(value);
    if (!snapshot) return null;
    set((state) => {
      const byId = new Map(state.byId);
      byId.set(snapshot.surfaceId, snapshot);
      const surfaceIdByTabId = tabId
        ? new Map(state.surfaceIdByTabId).set(tabId, snapshot.surfaceId)
        : state.surfaceIdByTabId;
      return {
        byId,
        surfaceIdByTabId,
        poppedManualTabIds: derivePoppedTabIds(byId, surfaceIdByTabId),
      };
    });
    return snapshot;
  },
  removeSurface: (surfaceId) => set((state) => {
    if (!state.byId.has(surfaceId)) return state;
    const byId = new Map(state.byId);
    byId.delete(surfaceId);
    const surfaceIdByTabId = new Map(state.surfaceIdByTabId);
    for (const [tabId, candidate] of surfaceIdByTabId) {
      if (candidate === surfaceId) surfaceIdByTabId.delete(tabId);
    }
    return {
      byId,
      surfaceIdByTabId,
      poppedManualTabIds: derivePoppedTabIds(byId, surfaceIdByTabId),
    };
  }),
}));

let listenersInstalled = false;

export const ensureBrowserSurfaceListeners = (): void => {
  if (
    listenersInstalled
    || typeof window === 'undefined'
    || !isElectronShell()
  ) return;
  listenersInstalled = true;
  window.addEventListener('browser-surface-updated', (event: Event) => {
    useBrowserSurfaceStore.getState().applySnapshot((event as CustomEvent<unknown>).detail);
  });
};

export const createDesktopBrowserSurface = async (
  tabId: string,
  initialUrl: string,
  workspaceId?: string,
  viewportMode: BrowserViewportMode = 'responsive',
): Promise<BrowserSurfaceSnapshot | null> => {
  const result = await invokeDesktop<unknown>('desktop_browser_surface_create', {
    tabId,
    initialUrl,
    workspaceId,
    viewportMode,
  });
  return useBrowserSurfaceStore.getState().applySnapshot(result, tabId);
};

export const browserSurfaceSelectors = {
  surface: (surfaceId: string) => (state: BrowserSurfaceState): BrowserSurfaceSnapshot | null => (
    state.byId.get(surfaceId) ?? null
  ),
};
