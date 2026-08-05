import { create } from 'zustand';
import type { GitHubAuthStatus, RuntimeAPIs } from '@/lib/api/types';

type GitHubAuthStatusWithError = GitHubAuthStatus & { error?: string };

type GitHubAuthStore = {
  status: GitHubAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
  setStatus: (status: GitHubAuthStatusWithError | null) => void;
  refreshStatus: (
    runtimeGitHub?: RuntimeAPIs['github'],
    options?: { force?: boolean; retryDelays?: readonly number[] }
  ) => Promise<GitHubAuthStatusWithError | null>;
};

const fetchStatus = async (
  runtimeGitHub?: RuntimeAPIs['github']
): Promise<GitHubAuthStatusWithError> => {
  if (runtimeGitHub) {
    const payload = await runtimeGitHub.authStatus();
    return payload as GitHubAuthStatus;
  }

  const response = await fetch('/api/github/auth/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = (await response.json().catch(() => null)) as GitHubAuthStatusWithError | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || response.statusText || 'Failed to load GitHub status');
  }
  return payload;
};

const AUTH_STATUS_RETRY_DELAYS_MS = [250, 750] as const;

const wait = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

export const fetchGitHubAuthStatusWithRetry = async (
  runtimeGitHub?: RuntimeAPIs['github'],
  retryDelays: readonly number[] = AUTH_STATUS_RETRY_DELAYS_MS,
): Promise<GitHubAuthStatusWithError> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await fetchStatus(runtimeGitHub);
    } catch (error) {
      lastError = error;
      const retryDelay = retryDelays[attempt];
      if (retryDelay === undefined) break;
      await wait(retryDelay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

// In-flight dedup for refreshStatus
let _inFlightAuthRefresh: Promise<GitHubAuthStatusWithError | null> | null = null;

export const useGitHubAuthStore = create<GitHubAuthStore>((set, get) => ({
  status: null,
  isLoading: false,
  hasChecked: false,
  setStatus: (status) => set({ status, hasChecked: true }),
  refreshStatus: async (runtimeGitHub, options) => {
    const { hasChecked, status } = get();
    if (hasChecked && !options?.force) {
      return status;
    }

    if (_inFlightAuthRefresh) return _inFlightAuthRefresh;

    set({ isLoading: true });
    _inFlightAuthRefresh = (async () => {
      try {
        const payload = await fetchGitHubAuthStatusWithRetry(runtimeGitHub, options?.retryDelays);
        set({ status: payload, isLoading: false, hasChecked: true });
        return payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const previousStatus = get().status;
        const preservedStatus = previousStatus
          ? { ...previousStatus, error: message }
          : { connected: false, error: message };
        set({
          status: preservedStatus,
          isLoading: false,
          hasChecked: true,
        });
        return previousStatus ? preservedStatus : null;
      }
    })().finally(() => { _inFlightAuthRefresh = null; });

    return _inFlightAuthRefresh;
  },
}));
