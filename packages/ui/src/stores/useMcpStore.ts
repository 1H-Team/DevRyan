import { create } from 'zustand';
import { createJSONStorage, devtools, persist } from 'zustand/middleware';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';

export type McpStatusMap = Record<string, McpStatus>;
export type McpIssueKind = 'failed' | 'needs_auth' | 'needs_client_registration';
export type McpIssueKindMap = Record<string, McpIssueKind>;
export type McpRuntimeDiagnostic = {
  status: 'failed';
  error: string;
};
export type McpRuntimeDiagnosticMap = Record<string, McpRuntimeDiagnostic>;

const EMPTY_STATUS: McpStatusMap = {};
const EMPTY_DIAGNOSTICS: McpRuntimeDiagnosticMap = {};
const EMPTY_ISSUES: McpIssueKindMap = {};

type McpHealth = {
  connected: number;
  total: number;
  hasFailed: boolean;
  hasAuthRequired: boolean;
};

const normalizeDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const toKey = (directory: string | null | undefined): string => normalizeDirectory(directory) ?? '__global__';

const getMcpApiClient = (directory: string | null | undefined) => {
  const normalized = normalizeDirectory(directory);
  if (!normalized) {
    return opencodeClient.getApiClient();
  }
  return opencodeClient.getScopedApiClient(normalized);
};

export const computeMcpHealth = (status: McpStatusMap | null | undefined): McpHealth => {
  const entries = Object.entries(status ?? {});
  const connected = entries.filter(([, s]) => s?.status === 'connected').length;
  const total = entries.length;
  const hasFailed = entries.some(([, s]) => s?.status === 'failed');
  const hasAuthRequired = entries.some(([, s]) => s?.status === 'needs_auth' || s?.status === 'needs_client_registration');
  return { connected, total, hasFailed, hasAuthRequired };
};

export const getMcpIssueKind = (status: McpStatus | undefined): McpIssueKind | null => {
  switch (status?.status) {
    case 'failed':
    case 'needs_auth':
    case 'needs_client_registration':
      return status.status;
    default:
      return null;
  }
};

const removeNamedEntry = <T>(entries: Record<string, T>, name: string): Record<string, T> => {
  if (!(name in entries)) return entries;
  const next = { ...entries };
  delete next[name];
  return next;
};

export const reconcileMcpIssueKinds = (
  current: McpIssueKindMap,
  status: McpStatusMap,
): McpIssueKindMap => {
  let next = current;

  for (const [name, serverStatus] of Object.entries(status)) {
    const issueKind = getMcpIssueKind(serverStatus);
    if (issueKind) {
      if (next[name] !== issueKind) {
        next = next === current ? { ...current } : next;
        next[name] = issueKind;
      }
      continue;
    }

    if (serverStatus.status === 'connected' && name in next) {
      next = next === current ? { ...current } : next;
      delete next[name];
    }
  }

  return next;
};

const reconcileRuntimeDiagnostics = (
  current: McpRuntimeDiagnosticMap,
  status: McpStatusMap,
): McpRuntimeDiagnosticMap => {
  let next = current;

  for (const [name, serverStatus] of Object.entries(status)) {
    if (serverStatus.status === 'failed') {
      const currentDiagnostic = next[name];
      if (currentDiagnostic?.error !== serverStatus.error) {
        next = next === current ? { ...current } : next;
        next[name] = { status: 'failed', error: serverStatus.error };
      }
      continue;
    }

    if (serverStatus.status === 'connected' && name in next) {
      next = next === current ? { ...current } : next;
      delete next[name];
    }
  }

  return next;
};

type RefreshOptions = {
  directory?: string | null;
  silent?: boolean;
};

type TestConnectionResult = {
  status?: McpStatus;
  error?: string;
  warning?: string;
};

interface McpStore {
  byDirectory: Record<string, McpStatusMap>;
  diagnosticsByDirectory: Record<string, McpRuntimeDiagnosticMap>;
  issueKindsByDirectory: Record<string, McpIssueKindMap>;
  loadingKeys: Record<string, boolean>;
  lastErrorKeys: Record<string, string | null>;

  getStatusForDirectory: (directory?: string | null) => McpStatusMap;
  getDiagnosticForDirectory: (directory?: string | null) => McpRuntimeDiagnosticMap;
  getIssueKindsForDirectory: (directory?: string | null) => McpIssueKindMap;
  getErrorForDirectory: (directory?: string | null) => string | null;
  clearIssue: (name: string, directory?: string | null) => void;
  refresh: (options?: RefreshOptions) => Promise<void>;
  connect: (name: string, directory?: string | null) => Promise<void>;
  disconnect: (name: string, directory?: string | null) => Promise<void>;
  startAuth: (name: string, directory?: string | null) => Promise<string>;
  completeAuth: (name: string, code: string, directory?: string | null) => Promise<void>;
  clearAuth: (name: string, directory?: string | null) => Promise<void>;
  testConnection: (name: string, directory?: string | null) => Promise<TestConnectionResult>;
}

export const useMcpStore = create<McpStore>()(
  devtools(
    persist((set, get) => ({
      byDirectory: {},
      diagnosticsByDirectory: {},
      issueKindsByDirectory: {},
      loadingKeys: {},
      lastErrorKeys: {},

      getStatusForDirectory: (directory) => {
        const key = toKey(directory ?? useDirectoryStore.getState().currentDirectory);
        return get().byDirectory[key] ?? EMPTY_STATUS;
      },

      getDiagnosticForDirectory: (directory) => {
        const key = toKey(directory ?? useDirectoryStore.getState().currentDirectory);
        return get().diagnosticsByDirectory[key] ?? EMPTY_DIAGNOSTICS;
      },

      getIssueKindsForDirectory: (directory) => {
        const key = toKey(directory ?? useDirectoryStore.getState().currentDirectory);
        return get().issueKindsByDirectory[key] ?? EMPTY_ISSUES;
      },

      getErrorForDirectory: (directory) => {
        const key = toKey(directory ?? useDirectoryStore.getState().currentDirectory);
        return get().lastErrorKeys[key] ?? null;
      },

      clearIssue: (name, directory) => {
        const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
        const key = toKey(normalized);
        set((state) => {
          const currentIssues = state.issueKindsByDirectory[key] ?? EMPTY_ISSUES;
          const currentDiagnostics = state.diagnosticsByDirectory[key] ?? EMPTY_DIAGNOSTICS;
          const nextIssues = removeNamedEntry(currentIssues, name);
          const nextDiagnostics = removeNamedEntry(currentDiagnostics, name);

          if (nextIssues === currentIssues && nextDiagnostics === currentDiagnostics) {
            return state;
          }

          return {
            issueKindsByDirectory: nextIssues === currentIssues
              ? state.issueKindsByDirectory
              : { ...state.issueKindsByDirectory, [key]: nextIssues },
            diagnosticsByDirectory: nextDiagnostics === currentDiagnostics
              ? state.diagnosticsByDirectory
              : { ...state.diagnosticsByDirectory, [key]: nextDiagnostics },
          };
        });
      },

      refresh: async (options) => {
        const directory = normalizeDirectory(options?.directory ?? useDirectoryStore.getState().currentDirectory);
        const key = toKey(directory);

        if (!options?.silent) {
          set((state) => ({
            loadingKeys: { ...state.loadingKeys, [key]: true },
            lastErrorKeys: { ...state.lastErrorKeys, [key]: null },
          }));
        }

        try {
          const api = getMcpApiClient(directory);
          const result = await api.mcp.status();
          const data = (result.data ?? {}) as McpStatusMap;

          set((state) => {
            const currentDiagnostics = state.diagnosticsByDirectory[key] ?? EMPTY_DIAGNOSTICS;
            const currentIssues = state.issueKindsByDirectory[key] ?? EMPTY_ISSUES;
            const nextDiagnostics = reconcileRuntimeDiagnostics(currentDiagnostics, data);
            const nextIssues = reconcileMcpIssueKinds(currentIssues, data);

            return {
              byDirectory: { ...state.byDirectory, [key]: data },
              diagnosticsByDirectory: nextDiagnostics === currentDiagnostics
                ? state.diagnosticsByDirectory
                : { ...state.diagnosticsByDirectory, [key]: nextDiagnostics },
              issueKindsByDirectory: nextIssues === currentIssues
                ? state.issueKindsByDirectory
                : { ...state.issueKindsByDirectory, [key]: nextIssues },
              loadingKeys: { ...state.loadingKeys, [key]: false },
              lastErrorKeys: { ...state.lastErrorKeys, [key]: null },
            };
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load MCP status';
          set((state) => ({
            loadingKeys: { ...state.loadingKeys, [key]: false },
            lastErrorKeys: { ...state.lastErrorKeys, [key]: message },
          }));
        }
      },

      connect: async (name, directory) => {
        const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
        const key = toKey(normalized);
        const api = getMcpApiClient(normalized);
        try {
          await api.mcp.connect({ name }, { throwOnError: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Connection failed';
          set((state) => ({
            diagnosticsByDirectory: {
              ...state.diagnosticsByDirectory,
              [key]: {
                ...(state.diagnosticsByDirectory[key] ?? {}),
                [name]: { status: 'failed', error: message },
              },
            },
            issueKindsByDirectory: {
              ...state.issueKindsByDirectory,
              [key]: {
                ...(state.issueKindsByDirectory[key] ?? {}),
                [name]: 'failed',
              },
            },
          }));
          throw error;
        }
        await get().refresh({ directory: normalized, silent: true });
      },

      disconnect: async (name, directory) => {
        const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
        const api = getMcpApiClient(normalized);
        await api.mcp.disconnect({ name }, { throwOnError: true });
        await get().refresh({ directory: normalized, silent: true });
      },

      startAuth: async (name, directory) => {
        const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
        const api = getMcpApiClient(normalized);
        const result = await api.mcp.auth.start({ name }, { throwOnError: true });
        const authorizationUrl = result.data?.authorizationUrl;

        if (!authorizationUrl) {
          throw new Error('Authorization URL was not returned');
        }

        return authorizationUrl;
      },

      completeAuth: async (name, code, directory) => {
        const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
        const api = getMcpApiClient(normalized);
        await api.mcp.auth.callback({ name, code }, { throwOnError: true });
        await get().refresh({ directory: normalized, silent: true });
      },

      clearAuth: async (name, directory) => {
        const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
        const api = getMcpApiClient(normalized);
        await api.mcp.auth.remove({ name }, { throwOnError: true });
        await get().refresh({ directory: normalized, silent: true });
      },

      testConnection: async (name, directory) => {
        const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
        const key = toKey(normalized);
        const api = getMcpApiClient(normalized);
        const previousStatus = get().getStatusForDirectory(normalized)[name];
        const wasConnected = previousStatus?.status === 'connected';
        let errorMessage: string | undefined;
        let warningMessage: string | undefined;

        try {
          await api.mcp.connect({ name }, { throwOnError: true });
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : 'Connection failed';
          set((state) => ({
            diagnosticsByDirectory: {
              ...state.diagnosticsByDirectory,
              [key]: {
                ...(state.diagnosticsByDirectory[key] ?? {}),
                [name]: { status: 'failed', error: errorMessage ?? 'Connection failed' },
              },
            },
            issueKindsByDirectory: {
              ...state.issueKindsByDirectory,
              [key]: {
                ...(state.issueKindsByDirectory[key] ?? {}),
                [name]: 'failed',
              },
            },
          }));
        }

        await get().refresh({ directory: normalized, silent: true });
        const currentStatus = get().getStatusForDirectory(normalized)[name];
        const observedStatus = currentStatus;

        if (!wasConnected && currentStatus?.status === 'connected') {
          try {
            await api.mcp.disconnect({ name }, { throwOnError: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Disconnect failed';
            warningMessage = `Connection test succeeded, but cleanup disconnect failed: ${message}`;
          }
          await get().refresh({ directory: normalized, silent: true });
        }

        return {
          status: observedStatus ?? get().getStatusForDirectory(normalized)[name],
          error: errorMessage,
          warning: warningMessage,
        };
      },
    }), {
      name: 'mcp-runtime-issues',
      storage: createJSONStorage(() => getSafeStorage()),
      version: 1,
      partialize: (state) => ({ issueKindsByDirectory: state.issueKindsByDirectory }),
    }),
    { name: 'mcp-store' },
  ),
);
