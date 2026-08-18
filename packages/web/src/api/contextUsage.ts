import type {
  ContextUsageAPI,
  ProviderContextUsageSnapshot,
} from '@openchamber/ui/lib/api/types';

const unavailable = (sessionID: string): ProviderContextUsageSnapshot => ({
  sessionID,
  status: 'unavailable',
  source: 'message-fallback',
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  activeInputTokens: 0,
  lastOutputTokens: 0,
  fetchedAt: Date.now(),
});

const isNonNegativeNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const isProviderContextUsageSnapshot = (
  value: unknown,
  sessionID: string,
): value is ProviderContextUsageSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ProviderContextUsageSnapshot>;
  return snapshot.sessionID === sessionID
    && (snapshot.status === 'available' || snapshot.status === 'unavailable')
    && (snapshot.source === 'meridian' || snapshot.source === 'message-fallback')
    && isNonNegativeNumber(snapshot.inputTokens)
    && isNonNegativeNumber(snapshot.cacheReadTokens)
    && isNonNegativeNumber(snapshot.cacheWriteTokens)
    && isNonNegativeNumber(snapshot.activeInputTokens)
    && isNonNegativeNumber(snapshot.lastOutputTokens)
    && isNonNegativeNumber(snapshot.fetchedAt);
};

export const createWebContextUsageAPI = (): ContextUsageAPI => ({
  async getSessionUsage(sessionID, options = {}) {
    const query = new URLSearchParams();
    if (options.directory) query.set('directory', options.directory);
    if (options.refreshSession) query.set('refreshSession', 'true');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await fetch(`/api/session/${encodeURIComponent(sessionID)}/context-usage${suffix}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return unavailable(sessionID);
    const payload = await response.json().catch(() => null) as ProviderContextUsageSnapshot | null;
    return isProviderContextUsageSnapshot(payload, sessionID) ? payload : unavailable(sessionID);
  },
});
