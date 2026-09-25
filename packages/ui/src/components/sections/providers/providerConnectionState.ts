import { create } from 'zustand';

import { isRetiredProviderId } from './retiredProviders';

export interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

export interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
  anthropicOAuth?: ProviderSourceInfo;
}

export type ProviderRemainingSource =
  | { type: 'config'; path: string }
  | { type: 'auth'; path: string | null }
  | { type: 'env'; name: string };

export interface ProviderDisconnectResponse {
  success: boolean;
  removed: boolean;
  removedSources?: {
    auth?: boolean;
    user?: boolean;
    project?: boolean;
    custom?: boolean;
  };
  sources?: ProviderSources;
  stillProvidedBy?: ProviderRemainingSource[];
  requiresApply?: boolean;
  applyRevision?: number;
  applyStatus?: {
    revision?: number;
    appliedRevision?: number;
    pending?: boolean;
  };
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export type ProviderDisconnectOutcome =
  | { kind: 'disconnected' }
  | { kind: 'still_provided'; sources: string[] };

const describeRemainingSource = (source: ProviderRemainingSource): string => {
  if (source.type === 'env') return source.name;
  if (source.type === 'auth') return source.path ?? 'auth.json';
  return source.path;
};

const getRemainingSources = (response: ProviderDisconnectResponse): ProviderRemainingSource[] => (
  Array.isArray(response.stillProvidedBy) ? response.stillProvidedBy : []
);

// A disconnect only counts as done when nothing still supplies the provider.
export const getProviderDisconnectOutcome = (response: ProviderDisconnectResponse): ProviderDisconnectOutcome => {
  const remaining = getRemainingSources(response);
  if (remaining.length > 0) {
    return { kind: 'still_provided', sources: remaining.map(describeRemainingSource) };
  }
  return { kind: 'disconnected' };
};

export type ProviderConnectionState = 'loading' | 'connected' | 'disconnect_pending' | 'not_connected';

const AUTHORITATIVE_SOURCE_PROVIDER_IDS = new Set(['google', 'antigravity']);

export const hasActiveProviderSource = (sources: ProviderSources | undefined): boolean => Boolean(
  sources?.auth.exists
  || sources?.user.exists
  || sources?.project.exists
  || sources?.custom?.exists
  || sources?.anthropicOAuth?.exists
);

export const getProviderConnectionState = (
  providerId: string,
  sources: ProviderSources | undefined,
  disconnectPending: boolean,
): ProviderConnectionState => {
  if (disconnectPending) return 'disconnect_pending';
  if (!sources) return 'loading';
  if (hasActiveProviderSource(sources)) return 'connected';
  return AUTHORITATIVE_SOURCE_PROVIDER_IDS.has(providerId.trim().toLowerCase()) ? 'not_connected' : 'connected';
};

export const shouldShowConnectedProvider = (
  providerId: string,
  sources: ProviderSources | undefined,
  disconnectPending: boolean,
): boolean => {
  // A retired provider appears only once its sources prove something is left to remove.
  if (isRetiredProviderId(providerId) && !sources && !disconnectPending) return false;
  return getProviderConnectionState(providerId, sources, disconnectPending) !== 'not_connected';
};

export const disconnectProvider = async (
  providerId: string,
  directory: string | null,
): Promise<ProviderDisconnectResponse> => {
  const query = new URLSearchParams({ scope: 'all' });
  if (directory?.trim()) query.set('directory', directory.trim());
  const response = await fetch(`/api/provider/${encodeURIComponent(providerId)}/auth?${query.toString()}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
  });
  const payload = await response.json().catch(() => null) as ProviderDisconnectResponse | null;
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to disconnect provider');
  }
  if (!payload || payload.success !== true) {
    throw new Error('Invalid provider disconnect response');
  }
  return payload;
};

interface ProviderDisconnectStore {
  pendingRevisionByProvider: Record<string, number>;
  sourceRefreshRevision: number;
  markRequested: (providerId: string, response: ProviderDisconnectResponse) => void;
  reconcileAppliedRevision: (appliedRevision: number) => void;
}

export const useProviderDisconnectStore = create<ProviderDisconnectStore>((set) => ({
  pendingRevisionByProvider: {},
  sourceRefreshRevision: 0,
  markRequested: (providerId, response) => set((state) => {
    const revision = Number.isInteger(response.applyStatus?.revision)
      ? response.applyStatus?.revision as number
      : Number.isInteger(response.applyRevision)
        ? response.applyRevision as number
        : 0;
    const pending = typeof response.applyStatus?.pending === 'boolean'
      ? response.applyStatus.pending
      : response.requiresApply === true;
    const nextPending = { ...state.pendingRevisionByProvider };
    // A provider something else still supplies must stay visible as connected.
    if (pending && getRemainingSources(response).length === 0) nextPending[providerId] = revision;
    else delete nextPending[providerId];
    return {
      pendingRevisionByProvider: nextPending,
      sourceRefreshRevision: state.sourceRefreshRevision + 1,
    };
  }),
  reconcileAppliedRevision: (appliedRevision) => set((state) => {
    const nextPending = { ...state.pendingRevisionByProvider };
    let changed = false;
    for (const [providerId, revision] of Object.entries(nextPending)) {
      if (revision <= appliedRevision) {
        delete nextPending[providerId];
        changed = true;
      }
    }
    if (!changed) return state;
    return {
      pendingRevisionByProvider: nextPending,
      sourceRefreshRevision: state.sourceRefreshRevision + 1,
    };
  }),
}));
