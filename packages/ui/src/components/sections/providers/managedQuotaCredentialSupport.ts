import { quotaRefreshCoordinator, useQuotaStore } from '@/stores/useQuotaStore';

export type ManagedQuotaProviderId = 'ollama-cloud' | 'cursor-acp' | 'opencode';

export type CredentialStatus = {
  configured: boolean;
  credentialKind?: 'dashboard' | 'oauth' | 'cookie';
  hasRefreshToken?: boolean;
  effectiveSource?: 'environment' | 'token-file' | 'managed' | 'legacy' | null;
  secretMasked?: string;
  workspaceId?: string;
  reconnectRequired?: boolean;
};

export const parseResponseError = (payload: unknown, fallback: string) => {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error;
    if (typeof error === 'string' && error.trim()) return error;
  }
  return fallback;
};

// Refresh failures must not turn a successful credential write into a failed save,
// so callers report the returned detail separately from the write result.
export const refreshQuotaAfterCredentialChange = async (
  providerId: ManagedQuotaProviderId,
  { expectResult, fallbackError }: { expectResult: boolean; fallbackError: string },
): Promise<string | null> => {
  await quotaRefreshCoordinator.refreshNow({ forceRefresh: true, rediscover: true });
  if (!expectResult) return null;
  const latest = useQuotaStore.getState();
  const error = latest.providerRefreshState[providerId]?.refreshError || latest.error;
  const result = latest.results.find((entry) => entry.providerId === providerId);
  return error || !result?.ok ? error || fallbackError : null;
};
