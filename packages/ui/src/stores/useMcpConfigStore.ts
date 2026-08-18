import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { devtools } from './utils/devtoolsGate';
import { getSafeStorage } from './utils/safeStorage';
import { recordConfigMutationResponse } from '@/stores/useConfigApplyStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { useMcpStore } from '@/stores/useMcpStore';

export type McpScope = 'user' | 'project';

export type McpMutationResult = {
  ok: boolean;
  reloadFailed?: boolean;
  message?: string;
  warning?: string;
};

const normalizeDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const getConfigDirectory = (directory?: string | null): string | null => {
  const explicitDirectory = normalizeDirectory(directory);
  if (explicitDirectory) {
    return explicitDirectory;
  }

  try {
    const projectsStore = useProjectsStore.getState();
    const activeProject = projectsStore.getActiveProject?.();
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (err) {
    console.warn('[McpConfigStore] Error resolving config directory:', err);
  }
  return null;
};

// ============== TYPES ==============

export interface McpLocalConfig {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: boolean;
}

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

export interface McpRemoteConfig {
  type: 'remote';
  url: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  timeout?: number;
  enabled: boolean;
}

export type McpServerConfig = (McpLocalConfig | McpRemoteConfig) & { name: string };
export type McpServerWithScope = McpServerConfig & {
  scope?: McpScope | null;
  /** Server-computed for managed users: the enabled switch cannot be changed. */
  enabledLocked?: boolean;
  enabledSource?: 'policy' | 'user' | 'global';
};

export interface McpDraft {
  name: string;
  scope: McpScope;
  type: 'local' | 'remote';
  command: string[];
  url: string;
  environment: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
  oauthEnabled: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthRedirectUri: string;
  timeout: string;
  enabled: boolean;
}

// ============== HELPERS ==============

export const envRecordToArray = (env?: Record<string, string>): Array<{ key: string; value: string }> => {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({ key, value }));
};

export const envArrayToRecord = (arr: Array<{ key: string; value: string }>): Record<string, string> | undefined => {
  const filtered = arr.filter((e) => e.key.trim());
  if (filtered.length === 0) return undefined;
  return Object.fromEntries(filtered.map((e) => [e.key.trim(), e.value]));
};

const trimOptionalString = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const MCP_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_MCP_CACHE_KEY = '__default__';
const mcpLastLoadedAt = new Map<string, number>();
const mcpLoadInFlight = new Map<string, Promise<boolean>>();

const getMcpCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_MCP_CACHE_KEY;
};

const queryStringForDirectory = (directory: string | null): string => {
  return directory ? `?directory=${encodeURIComponent(directory)}` : '';
};

// ============== STORE ==============

interface McpConfigStore {
  mcpServers: McpServerWithScope[];
  selectedMcpName: string | null;
  isLoading: boolean;
  mcpDraft: McpDraft | null;

  setSelectedMcp: (name: string | null) => void;
  setMcpDraft: (draft: McpDraft | null) => void;
  loadMcpConfigs: (options?: { force?: boolean; directory?: string | null }) => Promise<boolean>;
  createMcp: (config: McpDraft) => Promise<McpMutationResult>;
  updateMcp: (name: string, config: Partial<McpDraft>, options?: { directory?: string | null }) => Promise<McpMutationResult>;
  deleteMcp: (name: string) => Promise<McpMutationResult>;
  getMcpByName: (name: string) => McpServerWithScope | undefined;
}

const invalidateMcpCache = (directory: string | null) => {
  mcpLastLoadedAt.delete(getMcpCacheKey(directory));
};

export const useMcpConfigStore = create<McpConfigStore>()(
  devtools(
    persist(
      (set, get) => ({
        mcpServers: [],
        selectedMcpName: null,
        isLoading: false,
        mcpDraft: null,

        setSelectedMcp: (name) => set({ selectedMcpName: name }),

        setMcpDraft: (draft) => set({ mcpDraft: draft }),

        loadMcpConfigs: async (options) => {
          const configDirectory = getConfigDirectory(options?.directory);
          const cacheKey = getMcpCacheKey(configDirectory);
          const now = Date.now();
          const loadedAt = mcpLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedConfigs = get().mcpServers.length > 0;

          if (!options?.force && hasCachedConfigs && now - loadedAt < MCP_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = mcpLoadInFlight.get(cacheKey);
          if (!options?.force && inFlight) {
            return inFlight;
          }

          const request = (async () => {
            set({ isLoading: true });
            try {
              const queryParams = queryStringForDirectory(configDirectory);
              const response = await fetch(`/api/config/mcp${queryParams}`, {
                headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
              });
              if (!response.ok) {
                throw new Error('Failed to load MCP configs');
              }
              const data: McpServerWithScope[] = await response.json();
              const selectedMcpName = get().selectedMcpName;
              set({
                mcpServers: data,
                selectedMcpName: selectedMcpName && !data.some((server) => server.name === selectedMcpName)
                  ? null
                  : selectedMcpName,
                isLoading: false,
              });
              mcpLastLoadedAt.set(cacheKey, Date.now());
              return true;
            } catch (error) {
              console.error('[McpConfigStore] Failed to load MCP configs:', error);
              set({ isLoading: false });
              return false;
            }
          })();

          mcpLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            mcpLoadInFlight.delete(cacheKey);
          }
        },

        createMcp: async (config: McpDraft) => {
          try {
            const body = buildMcpBody(config);
            const configDirectory = getConfigDirectory();
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await fetch(`/api/config/mcp/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify(body),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to create MCP server');
            }

            invalidateMcpCache(configDirectory);
            recordConfigMutationResponse(payload);

            await get().loadMcpConfigs({ force: true });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to create MCP:', error);
            return { ok: false };
          }
        },

        updateMcp: async (name: string, config: Partial<McpDraft>, options?: { directory?: string | null }) => {
          try {
            const body = buildMcpBody(config);
            const configDirectory = getConfigDirectory(options?.directory);
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await fetch(`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify(body),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to update MCP server');
            }

            invalidateMcpCache(configDirectory);
            recordConfigMutationResponse(payload);

            await get().loadMcpConfigs({ force: true, directory: configDirectory });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to update MCP:', error);
            throw error;
          }
        },

        deleteMcp: async (name: string) => {
          try {
            const configDirectory = getConfigDirectory();
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await fetch(`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to delete MCP server');
            }

            invalidateMcpCache(configDirectory);
            recordConfigMutationResponse(payload);

            if (get().selectedMcpName === name) {
              set({ selectedMcpName: null });
            }
            useMcpStore.getState().clearIssue(name, configDirectory);
            await get().loadMcpConfigs({ force: true });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to delete MCP:', error);
            return { ok: false };
          }
        },

        getMcpByName: (name: string) => {
          return get().mcpServers.find((s) => s.name === name);
        },
      }),
      {
        name: 'mcp-config-store',
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({ selectedMcpName: state.selectedMcpName }),
      },
    ),
    { name: 'mcp-config-store' },
  ),
);

// ============== HELPERS ==============

function buildMcpBody(config: Partial<McpDraft>): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (config.scope !== undefined) body.scope = config.scope;

  if (config.type !== undefined) body.type = config.type;

  if (config.type === 'local' || config.command !== undefined) {
    body.command = (config.command ?? []).filter((s) => s.trim());
  }

  if (config.type === 'remote' || config.url !== undefined) {
    body.url = config.url?.trim() ?? '';
  }

  if (config.environment !== undefined) {
    body.environment = envArrayToRecord(config.environment) ?? {};
  }

  if (config.headers !== undefined) {
    body.headers = envArrayToRecord(config.headers) ?? {};
  }

  if (
    config.oauthEnabled !== undefined ||
    config.oauthClientId !== undefined ||
    config.oauthClientSecret !== undefined ||
    config.oauthScope !== undefined ||
    config.oauthRedirectUri !== undefined
  ) {
    if (config.oauthEnabled === false) {
      body.oauth = false;
    } else {
      const oauth = {
        clientId: trimOptionalString(config.oauthClientId),
        clientSecret: trimOptionalString(config.oauthClientSecret),
        scope: trimOptionalString(config.oauthScope),
        redirectUri: trimOptionalString(config.oauthRedirectUri),
      };

      if (oauth.clientId || oauth.clientSecret || oauth.scope || oauth.redirectUri) {
        body.oauth = oauth;
      }
      // All fields blank with oauth not explicitly disabled: omit the key so the
      // server keeps the stored oauth object. Sending `{}`/`false` here reads as
      // an identity change and wipes the server's cached OAuth tokens.
    }
  }

  if (config.timeout !== undefined) {
    const timeout = Number(config.timeout);
    if (Number.isFinite(timeout) && timeout > 0) {
      body.timeout = timeout;
    } else {
      body.timeout = null;
    }
  }

  if (config.enabled !== undefined) {
    body.enabled = config.enabled;
  }

  return body;
}
