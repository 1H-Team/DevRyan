import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { normalizeBrowserUrl } from '@/components/layout/browserUrl';
import {
  sanitizeBrowserViewportMode,
  type BrowserViewportMode,
} from '@/components/layout/browserViewport';
import { sanitizeBrowserFaviconUrl } from '@/components/layout/browserFavicon';
import { getSafeStorage } from './utils/safeStorage';
import { devtools } from './utils/devtoolsGate';

export type ManualBrowserTab = {
  id: string;
  url: string;
  label: string;
  viewportMode: BrowserViewportMode;
  faviconUrl?: string;
};

export type ManualBrowserWorkspace = {
  workspaceId: string;
  tabs: ManualBrowserTab[];
  activeTabId: string;
  touchedAt: number;
};

type ManualBrowserTabsState = {
  byDirectory: Record<string, ManualBrowserWorkspace>;
  ensureWorkspace: (directory: string, legacyUrl?: string | null) => ManualBrowserWorkspace | null;
  openWorkspace: (directory: string, url?: string | null) => ManualBrowserWorkspace | null;
  addTab: (directory: string, url?: string | null) => string | null;
  activateTab: (directory: string, tabId: string) => void;
  updateTabUrl: (directory: string, tabId: string, url: string) => void;
  updateTabTitle: (directory: string, tabId: string, title: string | null) => void;
  updateTabFavicon: (directory: string, tabId: string, url: string | null) => void;
  updateTabViewportMode: (directory: string, tabId: string, mode: BrowserViewportMode) => void;
  reorderTabs: (directory: string, activeTabId: string, overTabId: string) => void;
  closeTab: (directory: string, tabId: string) => void;
  replaceWorkspace: (directory: string, workspace: unknown) => void;
  clearWorkspace: (directory: string) => void;
};

const normalizeDirectoryPath = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '').replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  if (!normalized) return raw.startsWith('/') ? '/' : '';
  return normalized;
};

const randomId = (prefix: string): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return `${prefix}:${cryptoApi.randomUUID()}`;
  }
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    const value = Array.from(bytes, (entry) => entry.toString(16).padStart(2, '0')).join('');
    return `${prefix}:${value}`;
  }
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
};

export const browserTabLabelForUrl = (value: string): string => {
  const url = normalizeBrowserUrl(value);
  if (url === 'about:blank') return 'New tab';
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.hostname || 'New tab';
  } catch {
    return 'New tab';
  }
};

const browserHostForUrl = (value: string): string => {
  try {
    return new URL(normalizeBrowserUrl(value)).host;
  } catch {
    return '';
  }
};

const createTab = (value?: string | null): ManualBrowserTab => {
  const url = normalizeBrowserUrl(value || '');
  return {
    id: randomId('browser-tab'),
    url,
    label: browserTabLabelForUrl(url),
    viewportMode: 'responsive',
  };
};

const createWorkspace = (value?: string | null): ManualBrowserWorkspace => {
  const tab = createTab(value);
  return {
    workspaceId: randomId('browser-workspace'),
    tabs: [tab],
    activeTabId: tab.id,
    touchedAt: Date.now(),
  };
};

const sanitizeTab = (value: unknown): ManualBrowserTab | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { id?: unknown; url?: unknown; label?: unknown; viewportMode?: unknown; faviconUrl?: unknown };
  const id = typeof candidate.id === 'string' ? candidate.id.trim().slice(0, 220) : '';
  if (!id) return null;
  const url = normalizeBrowserUrl(typeof candidate.url === 'string' ? candidate.url : '');
  const label = typeof candidate.label === 'string' && candidate.label.trim()
    ? candidate.label.trim().slice(0, 120)
    : browserTabLabelForUrl(url);
  const faviconUrl = sanitizeBrowserFaviconUrl(candidate.faviconUrl);
  return {
    id,
    url,
    label,
    viewportMode: sanitizeBrowserViewportMode(candidate.viewportMode),
    ...(faviconUrl ? { faviconUrl } : {}),
  };
};

export const sanitizeManualBrowserWorkspace = (value: unknown): ManualBrowserWorkspace | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    workspaceId?: unknown;
    tabs?: unknown;
    activeTabId?: unknown;
    touchedAt?: unknown;
  };
  const workspaceId = typeof candidate.workspaceId === 'string'
    ? candidate.workspaceId.trim().slice(0, 220)
    : '';
  if (!workspaceId) return null;
  const seen = new Set<string>();
  const tabs = Array.isArray(candidate.tabs)
    ? candidate.tabs.flatMap((entry) => {
      const tab = sanitizeTab(entry);
      if (!tab || seen.has(tab.id)) return [];
      seen.add(tab.id);
      return [tab];
    })
    : [];
  if (tabs.length === 0) return null;
  const requestedActiveId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : '';
  return {
    workspaceId,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === requestedActiveId)
      ? requestedActiveId
      : tabs[0]!.id,
    touchedAt: typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
      ? candidate.touchedAt
      : Date.now(),
  };
};

export const sanitizeManualBrowserWorkspaces = (value: unknown): Record<string, ManualBrowserWorkspace> => {
  if (!value || typeof value !== 'object') return {};
  const next: Record<string, ManualBrowserWorkspace> = {};
  for (const [rawDirectory, rawWorkspace] of Object.entries(value as Record<string, unknown>)) {
    const directory = normalizeDirectoryPath(rawDirectory);
    const workspace = sanitizeManualBrowserWorkspace(rawWorkspace);
    if (directory && workspace) next[directory] = workspace;
  }
  return next;
};

const workspaceForDirectory = (
  byDirectory: Record<string, ManualBrowserWorkspace>,
  directory: string,
  legacyUrl?: string | null,
): ManualBrowserWorkspace => byDirectory[directory] ?? createWorkspace(legacyUrl);

export const useManualBrowserTabsStore = create<ManualBrowserTabsState>()(
  devtools(
    persist(
      (set, get) => ({
        byDirectory: {},

        ensureWorkspace: (directory, legacyUrl) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) return null;
          const existing = get().byDirectory[normalizedDirectory];
          if (existing) return existing;
          const workspace = createWorkspace(legacyUrl);
          set((state) => ({
            byDirectory: { ...state.byDirectory, [normalizedDirectory]: workspace },
          }));
          return workspace;
        },

        openWorkspace: (directory, url) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) return null;
          const current = workspaceForDirectory(get().byDirectory, normalizedDirectory, url);
          const nextUrl = normalizeBrowserUrl(url || '');
          const shouldNavigate = Boolean(url && nextUrl !== 'about:blank');
          const tabs = shouldNavigate
            ? current.tabs.map((tab) => tab.id === current.activeTabId
              ? {
                ...tab,
                url: nextUrl,
                label: browserTabLabelForUrl(nextUrl),
                ...(browserHostForUrl(tab.url) !== browserHostForUrl(nextUrl) ? { faviconUrl: undefined } : {}),
              }
              : tab)
            : current.tabs;
          const next = { ...current, tabs, touchedAt: Date.now() };
          set((state) => ({
            byDirectory: { ...state.byDirectory, [normalizedDirectory]: next },
          }));
          return next;
        },

        addTab: (directory, url) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) return null;
          const current = workspaceForDirectory(get().byDirectory, normalizedDirectory);
          const tab = createTab(url);
          const next = {
            ...current,
            tabs: [...current.tabs, tab],
            activeTabId: tab.id,
            touchedAt: Date.now(),
          };
          set((state) => ({
            byDirectory: { ...state.byDirectory, [normalizedDirectory]: next },
          }));
          return tab.id;
        },

        activateTab: (directory, tabId) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabId = (tabId || '').trim();
          if (!normalizedDirectory || !normalizedTabId) return;
          set((state) => {
            const current = state.byDirectory[normalizedDirectory];
            if (!current || current.activeTabId === normalizedTabId || !current.tabs.some((tab) => tab.id === normalizedTabId)) {
              return state;
            }
            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDirectory]: { ...current, activeTabId: normalizedTabId, touchedAt: Date.now() },
              },
            };
          });
        },

        updateTabUrl: (directory, tabId, url) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabId = (tabId || '').trim();
          const nextUrl = normalizeBrowserUrl(url || '');
          if (!normalizedDirectory || !normalizedTabId) return;
          set((state) => {
            const current = state.byDirectory[normalizedDirectory];
            const existing = current?.tabs.find((tab) => tab.id === normalizedTabId);
            if (!current || !existing || existing.url === nextUrl) return state;
            const hostChanged = browserHostForUrl(existing.url) !== browserHostForUrl(nextUrl);
            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDirectory]: {
                  ...current,
                  tabs: current.tabs.map((tab) => tab.id === normalizedTabId
                    ? {
                      ...tab,
                      url: nextUrl,
                      label: browserTabLabelForUrl(nextUrl),
                      ...(hostChanged ? { faviconUrl: undefined } : {}),
                    }
                    : tab),
                  touchedAt: Date.now(),
                },
              },
            };
          });
        },

        updateTabTitle: (directory, tabId, title) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabId = (tabId || '').trim();
          if (!normalizedDirectory || !normalizedTabId) return;
          set((state) => {
            const current = state.byDirectory[normalizedDirectory];
            const existing = current?.tabs.find((tab) => tab.id === normalizedTabId);
            if (!current || !existing) return state;
            const label = typeof title === 'string' && title.trim()
              ? title.trim().slice(0, 120)
              : browserTabLabelForUrl(existing.url);
            if (existing.label === label) return state;
            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDirectory]: {
                  ...current,
                  tabs: current.tabs.map((tab) => tab.id === normalizedTabId
                    ? { ...tab, label }
                    : tab),
                  touchedAt: Date.now(),
                },
              },
            };
          });
        },

        updateTabFavicon: (directory, tabId, url) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabId = (tabId || '').trim();
          const faviconUrl = sanitizeBrowserFaviconUrl(url);
          if (!normalizedDirectory || !normalizedTabId) return;
          set((state) => {
            const current = state.byDirectory[normalizedDirectory];
            const existing = current?.tabs.find((tab) => tab.id === normalizedTabId);
            if (!current || !existing || existing.faviconUrl === faviconUrl) return state;
            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDirectory]: {
                  ...current,
                  tabs: current.tabs.map((tab) => tab.id === normalizedTabId
                    ? { ...tab, faviconUrl }
                    : tab),
                  touchedAt: Date.now(),
                },
              },
            };
          });
        },

        updateTabViewportMode: (directory, tabId, mode) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabId = (tabId || '').trim();
          const viewportMode = sanitizeBrowserViewportMode(mode);
          if (!normalizedDirectory || !normalizedTabId) return;
          set((state) => {
            const current = state.byDirectory[normalizedDirectory];
            const existing = current?.tabs.find((tab) => tab.id === normalizedTabId);
            if (!current || !existing || existing.viewportMode === viewportMode) return state;
            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDirectory]: {
                  ...current,
                  tabs: current.tabs.map((tab) => tab.id === normalizedTabId
                    ? { ...tab, viewportMode }
                    : tab),
                  touchedAt: Date.now(),
                },
              },
            };
          });
        },

        reorderTabs: (directory, activeTabId, overTabId) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory || activeTabId === overTabId) return;
          set((state) => {
            const current = state.byDirectory[normalizedDirectory];
            if (!current) return state;
            const from = current.tabs.findIndex((tab) => tab.id === activeTabId);
            const to = current.tabs.findIndex((tab) => tab.id === overTabId);
            if (from === -1 || to === -1) return state;
            const tabs = [...current.tabs];
            const [moved] = tabs.splice(from, 1);
            if (!moved) return state;
            tabs.splice(to, 0, moved);
            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDirectory]: { ...current, tabs, touchedAt: Date.now() },
              },
            };
          });
        },

        closeTab: (directory, tabId) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabId = (tabId || '').trim();
          if (!normalizedDirectory || !normalizedTabId) return;
          set((state) => {
            const current = state.byDirectory[normalizedDirectory];
            if (!current) return state;
            const removedIndex = current.tabs.findIndex((tab) => tab.id === normalizedTabId);
            if (removedIndex === -1) return state;
            if (current.tabs.length === 1) {
              const byDirectory = { ...state.byDirectory };
              delete byDirectory[normalizedDirectory];
              return { byDirectory };
            }
            const tabs = current.tabs.filter((tab) => tab.id !== normalizedTabId);
            const activeTabId = current.activeTabId === normalizedTabId
              ? (tabs[Math.min(removedIndex, tabs.length - 1)]?.id ?? tabs[0]!.id)
              : current.activeTabId;
            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDirectory]: { ...current, tabs, activeTabId, touchedAt: Date.now() },
              },
            };
          });
        },

        replaceWorkspace: (directory, value) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const workspace = sanitizeManualBrowserWorkspace(value);
          if (!normalizedDirectory || !workspace) return;
          set((state) => ({
            byDirectory: { ...state.byDirectory, [normalizedDirectory]: workspace },
          }));
        },

        clearWorkspace: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) return;
          set((state) => {
            if (!state.byDirectory[normalizedDirectory]) return state;
            const byDirectory = { ...state.byDirectory };
            delete byDirectory[normalizedDirectory];
            return { byDirectory };
          });
        },
      }),
      {
        name: 'manual-browser-tabs-store',
        version: 2,
        storage: createJSONStorage(() => getSafeStorage()),
        migrate: (persistedState) => ({
          byDirectory: sanitizeManualBrowserWorkspaces(
            persistedState && typeof persistedState === 'object'
              ? (persistedState as { byDirectory?: unknown }).byDirectory
              : null,
          ),
        }),
        merge: (persistedState, currentState) => ({
          ...currentState,
          byDirectory: sanitizeManualBrowserWorkspaces(
            persistedState && typeof persistedState === 'object'
              ? (persistedState as { byDirectory?: unknown }).byDirectory
              : null,
          ),
        }),
        partialize: (state) => ({ byDirectory: state.byDirectory }),
      },
    ),
    { name: 'manual-browser-tabs-store' },
  ),
);
