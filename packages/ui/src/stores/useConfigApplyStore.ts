import { create } from 'zustand';

import { finishConfigUpdate, startConfigUpdate } from '@/lib/configUpdate';
import { opencodeClient } from '@/lib/opencode/client';

export type ConfigApplyScope = 'agents' | 'providers' | 'commands' | 'skills' | 'mcp' | 'behavior' | 'runtime';
export type ConfigApplyState =
  | 'clean'
  | 'pending'
  | 'waiting_for_idle'
  | 'applying'
  | 'failed'
  | 'external_restart_required';

export interface ConfigApplyStatus {
  revision: number;
  appliedRevision: number;
  state: ConfigApplyState;
  pending: boolean;
  scopes: ConfigApplyScope[];
  reasonCodes: string[];
  changedAt?: string;
  activeSessionCount: number;
  runtimeMode: 'managed' | 'external';
  canApplyWhenIdle: boolean;
  canForceRestart: boolean;
  lastError?: { code: string; message: string };
}

export interface ConfigApplyMutationResponse {
  requiresApply: boolean;
  applyRevision: number;
  applyScopes: ConfigApplyScope[];
  applyStatus: ConfigApplyStatus;
  /** @deprecated Batched mutations never require a client reload. */
  requiresReload: false;
}

type ConfigApplyResult = {
  status: ConfigApplyStatus;
  appliedRevision: number;
  appliedScopes: ConfigApplyScope[];
  userConfirmed: boolean;
};

interface ConfigApplyStore {
  status: ConfigApplyStatus | null;
  hydrated: boolean;
  isRequesting: boolean;
  requestError: string | null;
  refresh: () => Promise<ConfigApplyStatus | null>;
  mergeMutationResponse: (value: unknown) => ConfigApplyStatus | null;
  applyWhenIdle: () => Promise<ConfigApplyResult | null>;
  forceRestart: () => Promise<ConfigApplyResult | null>;
  acknowledgeExternalRestart: () => Promise<ConfigApplyResult | null>;
  clearRequestError: () => void;
}

const APPLY_STATES = new Set<ConfigApplyState>([
  'clean',
  'pending',
  'waiting_for_idle',
  'applying',
  'failed',
  'external_restart_required',
]);
const APPLY_SCOPES = new Set<ConfigApplyScope>([
  'agents',
  'providers',
  'commands',
  'skills',
  'mcp',
  'behavior',
  'runtime',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const parseConfigApplyStatus = (value: unknown): ConfigApplyStatus | null => {
  if (!isRecord(value)) return null;
  if (!Number.isInteger(value.revision) || !Number.isInteger(value.appliedRevision)) return null;
  if (typeof value.state !== 'string' || !APPLY_STATES.has(value.state as ConfigApplyState)) return null;
  if (typeof value.pending !== 'boolean' || !Array.isArray(value.scopes) || !Array.isArray(value.reasonCodes)) return null;
  if (!value.scopes.every((scope) => typeof scope === 'string' && APPLY_SCOPES.has(scope as ConfigApplyScope))) return null;
  if (!value.reasonCodes.every((reason) => typeof reason === 'string')) return null;
  if (typeof value.activeSessionCount !== 'number' || !Number.isFinite(value.activeSessionCount)) return null;
  if (value.runtimeMode !== 'managed' && value.runtimeMode !== 'external') return null;
  if (typeof value.canApplyWhenIdle !== 'boolean' || typeof value.canForceRestart !== 'boolean') return null;

  const lastError = isRecord(value.lastError)
    && typeof value.lastError.code === 'string'
    && typeof value.lastError.message === 'string'
    ? { code: value.lastError.code, message: value.lastError.message }
    : undefined;

  return {
    revision: value.revision as number,
    appliedRevision: value.appliedRevision as number,
    state: value.state as ConfigApplyState,
    pending: value.pending,
    scopes: [...value.scopes] as ConfigApplyScope[],
    reasonCodes: [...value.reasonCodes] as string[],
    ...(typeof value.changedAt === 'string' ? { changedAt: value.changedAt } : {}),
    activeSessionCount: Math.max(0, Math.trunc(value.activeSessionCount)),
    runtimeMode: value.runtimeMode,
    canApplyWhenIdle: value.canApplyWhenIdle,
    canForceRestart: value.canForceRestart,
    ...(lastError ? { lastError } : {}),
  };
};

const statusFromPayload = (value: unknown): ConfigApplyStatus | null => {
  const direct = parseConfigApplyStatus(value);
  if (direct) return direct;
  if (!isRecord(value)) return null;
  return parseConfigApplyStatus(value.applyStatus) ?? parseConfigApplyStatus(value.status);
};

let overlayActive = false;

const syncRestartOverlay = (status: ConfigApplyStatus | null) => {
  const shouldShow = status?.state === 'applying';
  if (shouldShow && !overlayActive) {
    overlayActive = true;
    startConfigUpdate('Restarting OpenCode and restoring configuration…');
    return;
  }
  if (!shouldShow && overlayActive) {
    overlayActive = false;
    finishConfigUpdate();
  }
};

const readErrorMessage = (payload: unknown, fallback: string): string => (
  isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : fallback
);

const refreshAppliedCatalogs = async (scopes: ConfigApplyScope[]): Promise<void> => {
  const scopeSet = new Set(scopes);
  const refreshAll = scopeSet.has('runtime');
  const directory = opencodeClient.getDirectory();
  const tasks: Array<Promise<unknown>> = [];

  if (refreshAll || scopeSet.has('providers') || scopeSet.has('agents')) {
    const { useConfigStore } = await import('@/stores/useConfigStore');
    const configStore = useConfigStore.getState();
    if (refreshAll || scopeSet.has('providers')) {
      configStore.invalidateModelMetadataCache();
      tasks.push(configStore.loadProviders({ directory }));
    }
    if (refreshAll || scopeSet.has('agents')) {
      tasks.push(configStore.loadAgents({ directory }));
    }
  }
  if (refreshAll || scopeSet.has('agents')) {
    const { useAgentsStore } = await import('@/stores/useAgentsStore');
    tasks.push(useAgentsStore.getState().loadAgents());
  }
  if (refreshAll || scopeSet.has('commands')) {
    const { useCommandsStore } = await import('@/stores/useCommandsStore');
    tasks.push(useCommandsStore.getState().loadCommands());
  }
  if (refreshAll || scopeSet.has('skills')) {
    const [{ useSkillsStore }, { useSkillsCatalogStore }] = await Promise.all([
      import('@/stores/useSkillsStore'),
      import('@/stores/useSkillsCatalogStore'),
    ]);
    tasks.push(useSkillsStore.getState().loadSkills({ refresh: true }));
    tasks.push(useSkillsCatalogStore.getState().loadCatalog({ refresh: true }));
  }
  if (refreshAll || scopeSet.has('mcp')) {
    const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
    tasks.push(useMcpConfigStore.getState().loadMcpConfigs({ force: true }));
  }

  await Promise.allSettled(tasks);
};

const requestJson = async (url: string, init?: RequestInit): Promise<{ response: Response; payload: unknown }> => {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.method && init.method !== 'GET' ? { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' } : {}),
      ...init?.headers,
    },
  });
  return { response, payload: await response.json().catch(() => null) };
};

export const useConfigApplyStore = create<ConfigApplyStore>((set, get) => {
  const mergeStatus = (next: ConfigApplyStatus, appliedScopes: ConfigApplyScope[] = []) => {
    const previous = get().status;
    set({ status: next, hydrated: true, requestError: null });
    syncRestartOverlay(next);

    const fallbackScopes = previous?.pending
      && !next.pending
      && next.appliedRevision >= previous.revision
      ? previous.scopes
      : [];
    const scopesToRefresh = appliedScopes.length > 0 ? appliedScopes : fallbackScopes;
    if (scopesToRefresh.length > 0) {
      void refreshAppliedCatalogs(scopesToRefresh);
    }
    return next;
  };

  const runApplyRequest = async (mode: 'when-idle' | 'force'): Promise<ConfigApplyResult | null> => {
    const current = get().status;
    if (!current?.pending) return null;

    set({ isRequesting: true, requestError: null });
    if (mode === 'when-idle' && current.activeSessionCount > 0) {
      mergeStatus({ ...current, state: 'waiting_for_idle' });
    }

    try {
      const { response, payload } = await requestJson('/api/config/apply', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: current.revision, mode }),
      });
      const responseStatus = statusFromPayload(payload);
      if (!response.ok) {
        if (responseStatus) mergeStatus(responseStatus);
        throw new Error(readErrorMessage(payload, 'Failed to apply configuration'));
      }
      if (!isRecord(payload) || !responseStatus) throw new Error('Invalid configuration apply response');
      const result: ConfigApplyResult = {
        status: responseStatus,
        appliedRevision: typeof payload.appliedRevision === 'number' ? payload.appliedRevision : responseStatus.appliedRevision,
        appliedScopes: Array.isArray(payload.appliedScopes)
          ? payload.appliedScopes.filter((scope): scope is ConfigApplyScope => typeof scope === 'string' && APPLY_SCOPES.has(scope as ConfigApplyScope))
          : [],
        userConfirmed: payload.userConfirmed === true,
      };
      mergeStatus(result.status, result.appliedScopes);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply configuration';
      set({ requestError: message });
      throw error;
    } finally {
      set({ isRequesting: false });
      syncRestartOverlay(get().status);
    }
  };

  return {
    status: null,
    hydrated: false,
    isRequesting: false,
    requestError: null,
    refresh: async () => {
      try {
        const { response, payload } = await requestJson('/api/config/apply-status');
        if (!response.ok) throw new Error(readErrorMessage(payload, 'Failed to load configuration apply status'));
        const status = parseConfigApplyStatus(payload);
        if (!status) throw new Error('Invalid configuration apply status');
        return mergeStatus(status);
      } catch (error) {
        set({ hydrated: true, requestError: error instanceof Error ? error.message : 'Failed to load configuration apply status' });
        return null;
      }
    },
    mergeMutationResponse: (value) => {
      const status = statusFromPayload(value);
      return status ? mergeStatus(status) : null;
    },
    applyWhenIdle: () => runApplyRequest('when-idle'),
    forceRestart: () => runApplyRequest('force'),
    acknowledgeExternalRestart: async () => {
      const current = get().status;
      if (!current?.pending || current.runtimeMode !== 'external') return null;
      set({ isRequesting: true, requestError: null });
      try {
        const { response, payload } = await requestJson('/api/config/apply/acknowledge-external', {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: current.revision }),
        });
        const responseStatus = statusFromPayload(payload);
        if (!response.ok) {
          if (responseStatus) mergeStatus(responseStatus);
          throw new Error(readErrorMessage(payload, 'Failed to acknowledge the external restart'));
        }
        if (!isRecord(payload) || !responseStatus) throw new Error('Invalid external restart acknowledgment response');
        const result: ConfigApplyResult = {
          status: responseStatus,
          appliedRevision: typeof payload.appliedRevision === 'number' ? payload.appliedRevision : responseStatus.appliedRevision,
          appliedScopes: Array.isArray(payload.appliedScopes)
            ? payload.appliedScopes.filter((scope): scope is ConfigApplyScope => typeof scope === 'string' && APPLY_SCOPES.has(scope as ConfigApplyScope))
            : [],
          userConfirmed: payload.userConfirmed === true,
        };
        mergeStatus(result.status, result.appliedScopes);
        return result;
      } catch (error) {
        set({ requestError: error instanceof Error ? error.message : 'Failed to acknowledge the external restart' });
        throw error;
      } finally {
        set({ isRequesting: false });
      }
    },
    clearRequestError: () => set({ requestError: null }),
  };
});

export const recordConfigMutationResponse = (value: unknown): ConfigApplyStatus | null => (
  useConfigApplyStore.getState().mergeMutationResponse(value)
);

export const shouldPollConfigApplyStatus = (status: ConfigApplyStatus | null): boolean => (
  status?.state === 'pending' || status?.state === 'waiting_for_idle' || status?.state === 'applying'
);
