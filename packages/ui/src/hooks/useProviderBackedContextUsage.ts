import * as React from 'react';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { buildContextUsageFromProviderSnapshot } from '@/stores/utils/contextUsageUtils';
import {
  getProviderContextUsageStoreKey,
  refreshProviderContextUsage,
  useProviderContextUsageStore,
} from '@/stores/useProviderContextUsageStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

type UseProviderBackedContextUsageInput = {
  sessionID: string | null | undefined;
  directory?: string | null;
  fallback: SessionContextUsage | null;
};

export const useProviderBackedContextUsage = ({
  sessionID,
  directory,
  fallback,
}: UseProviderBackedContextUsageInput): SessionContextUsage | null => {
  const normalizedSessionID = sessionID?.trim() ?? '';
  const storeKey = getProviderContextUsageStoreKey(normalizedSessionID, directory);
  const entry = useProviderContextUsageStore((state) => state.entries.get(storeKey));
  const compactionRevision = useProviderContextUsageStore(
    (state) => state.compactionRevisions.get(storeKey) ?? 0,
  );
  const compactionRequestKey = `compaction:${compactionRevision}`;
  const isCompactionSnapshotPending = compactionRevision > 0
    && (!entry || entry.requestKey === compactionRequestKey);
  const requestKey = isCompactionSnapshotPending
    ? compactionRequestKey
    : fallback
    ? JSON.stringify([
        fallback.lastMessageId ?? '',
        fallback.activeInputTokens,
        fallback.updatedAt,
        compactionRevision,
      ])
    : compactionRequestKey;

  React.useEffect(() => {
    if (!normalizedSessionID || isCompactionSnapshotPending || fallback?.providerID !== 'anthropic') return;
    if (!getRegisteredRuntimeAPIs()?.contextUsage) return;
    void refreshProviderContextUsage({
      sessionID: normalizedSessionID,
      directory,
      requestKey,
    });
  }, [directory, fallback?.providerID, isCompactionSnapshotPending, normalizedSessionID, requestKey]);

  if (isCompactionSnapshotPending) {
    if (entry?.status === 'available' && entry.snapshot) {
      return buildContextUsageFromProviderSnapshot(entry.snapshot, fallback);
    }
    return null;
  }

  if (entry?.requestKey !== requestKey || entry.status !== 'available' || !entry.snapshot) {
    return fallback;
  }
  return buildContextUsageFromProviderSnapshot(entry.snapshot, fallback);
};
