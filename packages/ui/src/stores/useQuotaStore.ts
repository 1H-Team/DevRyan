import { create } from 'zustand';
import { devtools } from './utils/devtoolsGate';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { QUOTA_PROVIDERS, recordProviderUsageTrends, type UsageTrendHistory } from '@/lib/quota';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getDefaultModels } from '@/lib/quota/model-families';
import { updateDesktopSettings } from '@/lib/persistence';
import { opencodeClient } from '@/lib/opencode/client';
import { getAuthPrincipal } from '@/lib/authSession';
import {
  BASELINE_QUOTA_REFRESH_MS,
  createQuotaRefreshCoordinator,
  type QuotaRefreshOptions,
} from './quota-refresh-coordinator';

export { BASELINE_QUOTA_REFRESH_MS } from './quota-refresh-coordinator';

const DEFAULT_REFRESH_INTERVAL_MS = 60000;

type FetchQuotaOptions = QuotaRefreshOptions;

export interface ProviderRefreshState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  refreshError: string | null;
}

export interface ProviderRefreshStatus extends ProviderRefreshState {
  isStale: boolean;
}

interface QuotaSettingsState {
  autoRefresh: boolean;
  refreshIntervalMs: number;
  displayMode: 'usage' | 'remaining';
  showPredictionValues: boolean;
  dropdownProviderIds: QuotaProviderId[];
  selectedModels: Record<string, string[]>;  // Map of providerId -> selected model names
  expandedFamilies: Record<string, string[]>;  // Map of providerId -> EXPANDED family IDs (header dropdown - inverted)
}

interface QuotaStore extends QuotaSettingsState {
  results: ProviderResult[];
  trendHistory: UsageTrendHistory;
  configuredProviderIds: QuotaProviderId[] | null;
  providerRefreshState: Partial<Record<QuotaProviderId, ProviderRefreshState>>;
  selectedProviderId: QuotaProviderId | null;
  isLoading: boolean;
  isFetchingProvider: Record<string, boolean>;
  lastUpdated: number | null;
  error: string | null;

  loadSettings: () => Promise<void>;
  discoverConfiguredProviders: () => Promise<QuotaProviderId[]>;
  fetchAllQuotas: (options?: FetchQuotaOptions) => Promise<void>;
  fetchProviderQuota: (providerId: QuotaProviderId, options?: FetchQuotaOptions) => Promise<void>;
  setSelectedProvider: (providerId: QuotaProviderId | null) => void;
  setAutoRefresh: (enabled: boolean) => void;
  setRefreshInterval: (intervalMs: number) => void;
  setDisplayMode: (mode: 'usage' | 'remaining') => void;
  setShowPredictionValues: (enabled: boolean) => void;
  setDropdownProviderIds: (providerIds: QuotaProviderId[]) => void;
  setSelectedModels: (providerId: string, modelNames: string[]) => void;
  toggleModelSelected: (providerId: string, modelName: string) => void;
  setExpandedFamilies: (providerId: string, familyIds: string[]) => void;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  applyDefaultSelections: (providerId: string, availableModels: string[]) => void;
}

const knownProviderIds = new Set<QuotaProviderId>(QUOTA_PROVIDERS.map((provider) => provider.id));
const inFlightProviderRefreshes = new Map<QuotaProviderId, Promise<void>>();
let inFlightDiscovery: Promise<QuotaProviderId[]> | null = null;
let activeAllRefreshes = 0;
let notifyQuotaSettingsChanged = () => {};

const resolveQuotaRequestDirectory = (): string | null => {
  const currentDirectory = opencodeClient.getDirectory();
  const principal = getAuthPrincipal();

  if (principal.scope !== 'managed' || principal.role === 'admin') {
    return currentDirectory || null;
  }

  const assignment = principal.assignments.find(
    (candidate) => candidate.publicDirectory === currentDirectory,
  )
    ?? principal.assignments.find((candidate) => candidate.isDefault)
    ?? principal.assignments[0];

  return assignment?.publicDirectory ?? null;
};

const quotaRequestHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const directory = resolveQuotaRequestDirectory();
  if (directory) {
    headers['x-opencode-directory'] = directory;
  }
  return headers;
};

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error ? error.message : fallback
);

const payloadError = (payload: unknown, fallback: string): string => {
  if (
    payload
    && typeof payload === 'object'
    && 'error' in payload
    && typeof payload.error === 'string'
    && payload.error.trim()
  ) {
    return payload.error;
  }
  return fallback;
};

const isProviderResult = (payload: unknown, providerId: QuotaProviderId): payload is ProviderResult => {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<ProviderResult>;
  return candidate.providerId === providerId
    && typeof candidate.providerName === 'string'
    && typeof candidate.ok === 'boolean'
    && typeof candidate.configured === 'boolean'
    && typeof candidate.fetchedAt === 'number'
    && (
      candidate.usageUpdatedAt === undefined
      || (typeof candidate.usageUpdatedAt === 'number' && Number.isFinite(candidate.usageUpdatedAt))
    )
    && (
      candidate.warnings === undefined
      || (Array.isArray(candidate.warnings) && candidate.warnings.every((warning) => typeof warning === 'string'))
    )
    && ('usage' in candidate);
};

const sameProviderIds = (
  left: QuotaProviderId[] | null,
  right: QuotaProviderId[],
): boolean => Boolean(left && left.length === right.length && left.every((id, index) => id === right[index]));

const replaceProviderResult = (
  results: ProviderResult[],
  providerId: QuotaProviderId,
  result: ProviderResult,
): ProviderResult[] => {
  const index = results.findIndex((entry) => entry.providerId === providerId);
  if (index < 0) return [...results, result];
  if (results[index] === result) return results;
  const next = [...results];
  next[index] = result;
  return next;
};

export const getEffectiveQuotaRefreshIntervalMs = (
  settings: Pick<QuotaSettingsState, 'autoRefresh' | 'refreshIntervalMs'>,
): number => {
  if (!settings.autoRefresh) return BASELINE_QUOTA_REFRESH_MS;
  if (!Number.isFinite(settings.refreshIntervalMs) || settings.refreshIntervalMs <= 0) {
    return BASELINE_QUOTA_REFRESH_MS;
  }
  return Math.min(BASELINE_QUOTA_REFRESH_MS, Math.round(settings.refreshIntervalMs));
};

export const getQuotaProviderRefreshStatus = (
  refreshState: ProviderRefreshState | undefined,
  refreshIntervalMs: number,
  now = Date.now(),
): ProviderRefreshStatus => {
  const lastAttemptAt = refreshState?.lastAttemptAt ?? null;
  const lastSuccessAt = refreshState?.lastSuccessAt ?? null;
  const refreshError = refreshState?.refreshError ?? null;
  const staleAfterMs = Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0
    ? Math.min(BASELINE_QUOTA_REFRESH_MS, Math.round(refreshIntervalMs))
    : BASELINE_QUOTA_REFRESH_MS;
  return {
    lastAttemptAt,
    lastSuccessAt,
    refreshError,
    isStale: lastSuccessAt !== null && now - lastSuccessAt >= staleAfterMs,
  };
};

const parseSettings = (data: Record<string, unknown> | null): QuotaSettingsState => {
  const allProviderIds = QUOTA_PROVIDERS.map((provider) => provider.id);
  const autoRefresh = typeof data?.usageAutoRefresh === 'boolean'
    ? data.usageAutoRefresh
    : false;
  const refreshIntervalMs =
    typeof data?.usageRefreshIntervalMs === 'number' && Number.isFinite(data.usageRefreshIntervalMs)
      ? Math.max(30000, Math.min(300000, Math.round(data.usageRefreshIntervalMs)))
      : DEFAULT_REFRESH_INTERVAL_MS;

  const displayMode = data?.usageDisplayMode === 'remaining' ? 'remaining' : 'usage';
  const showPredictionValues = typeof data?.usageShowPredValues === 'boolean'
    ? data.usageShowPredValues
    : true;
  const rawDropdownProviders = Array.isArray(data?.usageDropdownProviders)
    ? data?.usageDropdownProviders
    : null;
  let dropdownProviderIds = rawDropdownProviders
    ? rawDropdownProviders.filter((entry): entry is QuotaProviderId =>
        typeof entry === 'string' && allProviderIds.includes(entry as QuotaProviderId)
      )
    : allProviderIds;
  if (
    dropdownProviderIds.includes('google')
    && !dropdownProviderIds.includes('antigravity')
    && allProviderIds.includes('antigravity')
  ) {
    const googleIndex = dropdownProviderIds.indexOf('google');
    dropdownProviderIds = [
      ...dropdownProviderIds.slice(0, googleIndex + 1),
      'antigravity',
      ...dropdownProviderIds.slice(googleIndex + 1),
    ];
  }

  // Parse selected models (providerId -> array of model names)
  const selectedModels: Record<string, string[]> = {};
  const rawSelectedModels = data?.usageSelectedModels;
  if (rawSelectedModels && typeof rawSelectedModels === 'object') {
    for (const [providerId, models] of Object.entries(rawSelectedModels)) {
      if (Array.isArray(models)) {
        selectedModels[providerId] = models.filter((m): m is string => typeof m === 'string');
      }
    }
  }
  const googleSelectedModels = selectedModels.google ?? [];
  const googleAntigravityModels = googleSelectedModels.filter((modelName) => modelName.startsWith('antigravity/'));
  if (googleAntigravityModels.length > 0) {
    selectedModels.google = googleSelectedModels.filter((modelName) => !modelName.startsWith('antigravity/'));
    selectedModels.antigravity = selectedModels.antigravity?.length
      ? selectedModels.antigravity
      : googleAntigravityModels;
  }

  // Parse expanded families (inverted collapsed logic for header dropdown)
  const expandedFamilies: Record<string, string[]> = {};
  const rawExpandedFamilies = data?.usageExpandedFamilies;
  if (rawExpandedFamilies && typeof rawExpandedFamilies === 'object') {
    for (const [providerId, families] of Object.entries(rawExpandedFamilies)) {
      if (Array.isArray(families)) {
        expandedFamilies[providerId] = families.filter((f): f is string => typeof f === 'string');
      }
    }
  }

  return {
    autoRefresh,
    refreshIntervalMs,
    displayMode,
    showPredictionValues,
    dropdownProviderIds,
    selectedModels,
    expandedFamilies,
  };
};

const loadSettingsFromRuntime = async (): Promise<QuotaSettingsState> => {
  const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
  if (runtimeSettings) {
    try {
      const result = await runtimeSettings.load();
      const settings = result?.settings as Record<string, unknown> | undefined;
      return parseSettings(settings ?? null);
    } catch {
      // fall through
    }
  }

  if (!isVSCodeRuntime()) {
    const response = await fetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      return parseSettings(data as Record<string, unknown> | null);
    }
  }

  return {
    autoRefresh: false,
    refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    displayMode: 'usage',
    showPredictionValues: true,
    dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
    selectedModels: {},
    expandedFamilies: {},
  };
};

export const useQuotaStore = create<QuotaStore>()(
  devtools(
    (set, get) => ({
      results: [],
      trendHistory: {},
      configuredProviderIds: null,
      providerRefreshState: {},
      selectedProviderId: null,
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
      autoRefresh: false,
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      displayMode: 'usage',
      showPredictionValues: true,
      dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
      selectedModels: {},
      expandedFamilies: {},

      loadSettings: async () => {
        try {
          const settings = await loadSettingsFromRuntime();
          set(settings);
        } catch (error) {
          console.warn('Failed to load usage settings:', error);
        }
      },

      discoverConfiguredProviders: () => {
        if (inFlightDiscovery) return inFlightDiscovery;

        const request = (async () => {
          const response = await fetch('/api/quota/providers', { headers: quotaRequestHeaders() });
          const payload = await response.json().catch(() => null) as unknown;
          if (!response.ok) {
            throw new Error(payloadError(payload, 'Failed to discover quota providers'));
          }
          if (
            !payload
            || typeof payload !== 'object'
            || !('providers' in payload)
            || !Array.isArray(payload.providers)
          ) {
            throw new Error('Malformed quota provider discovery response');
          }

          const configuredSet = new Set(
            payload.providers.filter((id): id is QuotaProviderId => (
              typeof id === 'string' && knownProviderIds.has(id as QuotaProviderId)
            )),
          );
          const providerIds = QUOTA_PROVIDERS
            .map((provider) => provider.id)
            .filter((id) => configuredSet.has(id));

          set((state) => {
            const nextResults = state.results.filter((result) => configuredSet.has(result.providerId));
            let nextProviderRefreshState = state.providerRefreshState;
            for (const providerId of Object.keys(state.providerRefreshState) as QuotaProviderId[]) {
              if (configuredSet.has(providerId)) continue;
              if (nextProviderRefreshState === state.providerRefreshState) {
                nextProviderRefreshState = { ...state.providerRefreshState };
              }
              delete nextProviderRefreshState[providerId];
            }
            return {
              configuredProviderIds: sameProviderIds(state.configuredProviderIds, providerIds)
                ? state.configuredProviderIds
                : providerIds,
              results: nextResults.length === state.results.length ? state.results : nextResults,
              providerRefreshState: nextProviderRefreshState,
              error: null,
            };
          });
          return providerIds;
        })();

        const tracked = request
          .catch((error) => {
            set({ error: errorMessage(error, 'Failed to discover quota providers') });
            throw error;
          })
          .finally(() => {
            if (inFlightDiscovery === tracked) {
              inFlightDiscovery = null;
            }
          });
        inFlightDiscovery = tracked;
        return tracked;
      },

      fetchAllQuotas: (options = {}) => {
        activeAllRefreshes += 1;
        set({ isLoading: true, error: null });

        return (async () => {
          try {
            if (options.rediscover || get().configuredProviderIds === null) {
              await get().discoverConfiguredProviders();
            }
            const providerIds = get().configuredProviderIds ?? [];
            await Promise.all(
              providerIds.map((providerId) => get().fetchProviderQuota(providerId, options)),
            );
            const latestSuccessAt = providerIds.reduce((latest, providerId) => (
              Math.max(latest, get().providerRefreshState[providerId]?.lastSuccessAt ?? 0)
            ), 0);
            if (latestSuccessAt > 0) {
              set({ lastUpdated: latestSuccessAt });
            }
          } catch (error) {
            set({ error: errorMessage(error, 'Failed to fetch quotas') });
          } finally {
            activeAllRefreshes = Math.max(0, activeAllRefreshes - 1);
            if (activeAllRefreshes === 0) {
              set({ isLoading: false });
            }
          }
        })();
      },

      fetchProviderQuota: (providerId, options = {}) => {
        const existingRequest = inFlightProviderRefreshes.get(providerId);
        if (existingRequest) return existingRequest;

        const attemptAt = Date.now();
        set((state) => ({
          isFetchingProvider: { ...state.isFetchingProvider, [providerId]: true },
          providerRefreshState: {
            ...state.providerRefreshState,
            [providerId]: {
              lastAttemptAt: attemptAt,
              lastSuccessAt: state.providerRefreshState[providerId]?.lastSuccessAt ?? null,
              refreshError: state.providerRefreshState[providerId]?.refreshError ?? null,
            },
          },
        }));

        const request = (async () => {
          try {
            const search = options.forceRefresh ? '?refresh=true' : '';
            const response = await fetch(
              `/api/quota/${encodeURIComponent(providerId)}${search}`,
              { headers: quotaRequestHeaders() },
            );
            const payload = await response.json().catch(() => null) as unknown;
            if (!response.ok) {
              throw new Error(payloadError(payload, 'Failed to fetch quota'));
            }
            if (!isProviderResult(payload, providerId)) {
              throw new Error('Malformed quota response');
            }

            const result = payload;
            const completedAt = Date.now();
            set((state) => {
              const previousRefresh = state.providerRefreshState[providerId];
              const previousResult = state.results.find((entry) => entry.providerId === providerId);

              if (!result.configured) {
                return {
                  results: replaceProviderResult(state.results, providerId, result),
                  configuredProviderIds: state.configuredProviderIds?.filter((id) => id !== providerId) ?? null,
                  providerRefreshState: {
                    ...state.providerRefreshState,
                    [providerId]: {
                      lastAttemptAt: attemptAt,
                      lastSuccessAt: previousRefresh?.lastSuccessAt ?? null,
                      refreshError: result.error ?? null,
                    },
                  },
                };
              }

              if (!result.ok) {
                return {
                  results: previousResult?.ok
                    ? state.results
                    : replaceProviderResult(state.results, providerId, result),
                  providerRefreshState: {
                    ...state.providerRefreshState,
                    [providerId]: {
                      lastAttemptAt: attemptAt,
                      lastSuccessAt: previousRefresh?.lastSuccessAt ?? null,
                      refreshError: result.error ?? 'Provider usage unavailable',
                    },
                  },
                };
              }

              return {
                results: replaceProviderResult(state.results, providerId, result),
                trendHistory: recordProviderUsageTrends(state.trendHistory, result),
                providerRefreshState: {
                  ...state.providerRefreshState,
                  [providerId]: {
                    lastAttemptAt: attemptAt,
                    lastSuccessAt: completedAt,
                    refreshError: null,
                  },
                },
              };
            });
          } catch (error) {
            const message = errorMessage(error, 'Failed to fetch quota');
            const fallback: ProviderResult = {
              providerId,
              providerName: QUOTA_PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId,
              ok: false,
              configured: get().configuredProviderIds?.includes(providerId) ?? false,
              error: message,
              usage: null,
              fetchedAt: Date.now(),
            };
            set((state) => {
              const previousResult = state.results.find((entry) => entry.providerId === providerId);
              return {
                results: previousResult
                  ? state.results
                  : replaceProviderResult(state.results, providerId, fallback),
                providerRefreshState: {
                  ...state.providerRefreshState,
                  [providerId]: {
                    lastAttemptAt: attemptAt,
                    lastSuccessAt: state.providerRefreshState[providerId]?.lastSuccessAt ?? null,
                    refreshError: message,
                  },
                },
              };
            });
          } finally {
            set((state) => ({
              isFetchingProvider: { ...state.isFetchingProvider, [providerId]: false },
            }));
          }
        })();

        const tracked = request.finally(() => {
          if (inFlightProviderRefreshes.get(providerId) === tracked) {
            inFlightProviderRefreshes.delete(providerId);
          }
        });
        inFlightProviderRefreshes.set(providerId, tracked);
        return tracked;
      },

      setSelectedProvider: (providerId) => set({ selectedProviderId: providerId }),
      setAutoRefresh: (enabled) => {
        set({ autoRefresh: enabled });
        notifyQuotaSettingsChanged();
      },
      setRefreshInterval: (intervalMs) => {
        const clamped = Math.max(30000, Math.min(300000, Math.round(intervalMs)));
        set({ refreshIntervalMs: clamped });
        notifyQuotaSettingsChanged();
      },
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setShowPredictionValues: (enabled) => set({ showPredictionValues: enabled }),
      setDropdownProviderIds: (providerIds) => set({ dropdownProviderIds: providerIds }),

      setSelectedModels: (providerId, modelNames) => {
        set((state) => ({
          selectedModels: { ...state.selectedModels, [providerId]: modelNames }
        }));
      },

      toggleModelSelected: (providerId, modelName) => {
        set((state) => {
          const currentSelected = state.selectedModels[providerId] ?? [];
          const isSelected = currentSelected.includes(modelName);
          const nextSelected = isSelected
            ? currentSelected.filter((m) => m !== modelName)
            : [...currentSelected, modelName];
          return {
            selectedModels: { ...state.selectedModels, [providerId]: nextSelected }
          };
        });
      },

      setExpandedFamilies: (providerId, familyIds) => {
        set((state) => ({
          expandedFamilies: { ...state.expandedFamilies, [providerId]: familyIds }
        }));
        // Persist
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      toggleFamilyExpanded: (providerId, familyId) => {
        set((state) => {
          const currentExpanded = state.expandedFamilies[providerId] ?? [];
          const isExpanded = currentExpanded.includes(familyId);
          const nextExpanded = isExpanded
            ? currentExpanded.filter((id) => id !== familyId)
            : [...currentExpanded, familyId];
          return {
            expandedFamilies: { ...state.expandedFamilies, [providerId]: nextExpanded }
          };
        });
        // Persist
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      applyDefaultSelections: (providerId, availableModels) => {
        const state = get();
        // Only apply if no prior selections exist
        if ((state.selectedModels[providerId]?.length ?? 0) > 0) return;

        const defaults = getDefaultModels(providerId as QuotaProviderId, availableModels);
        if (defaults.length === 0) return;

        set((s) => ({
          selectedModels: { ...s.selectedModels, [providerId]: defaults },
        }));
        // Persist
        void updateDesktopSettings({ usageSelectedModels: get().selectedModels });
      },
    }),
    { name: 'quota-store' }
  )
);

export const quotaRefreshCoordinator = createQuotaRefreshCoordinator({
  loadSettings: () => useQuotaStore.getState().loadSettings(),
  refresh: (options) => useQuotaStore.getState().fetchAllQuotas(options),
  getRefreshIntervalMs: () => getEffectiveQuotaRefreshIntervalMs(useQuotaStore.getState()),
});

notifyQuotaSettingsChanged = () => quotaRefreshCoordinator.settingsChanged();
