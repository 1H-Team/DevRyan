import { opencodeClient } from './opencode/client';
import { getSyncSessionDirectoryAnyDirectory } from '@/sync/sync-refs';
import { primaryRecoverySchema, usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';

export async function requestPrimaryRecovery(sessionID: string, action?: 'cancel' | 'continue' | 'intent', messageID?: string) {
  const directory = getSyncSessionDirectoryAnyDirectory(sessionID) ?? opencodeClient.getDirectory();
  const query = new URLSearchParams(directory ? { directory } : {});
  const current = usePrimaryRecoveryStore.getState().snapshots[sessionID];
  const response = await fetch(`/api/session/${encodeURIComponent(sessionID)}/recovery${action ? `/${action}` : ''}?${query}`, {
    method: action ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'X-DevRyan-CSRF': '1' },
    ...(action ? { body: JSON.stringify({ revision: current?.record?.revision, messageID }) } : {}),
    signal: AbortSignal.timeout(action ? 30_000 : 10_000),
  });
  if (!response.ok) throw new Error(action
    ? 'The host could not confirm this action. Refresh recovery status before trying again.'
    : 'Recovery status is unavailable. Stop has not been confirmed.');
  const snapshot = primaryRecoverySchema.parse(await response.json());
  usePrimaryRecoveryStore.getState().accept(sessionID, snapshot);
  return snapshot;
}

export async function admitQueuedRecoveryIntent(sessionID: string): Promise<void> {
  // A missing renderer snapshot is not proof that the host has no pending
  // recovery. Obtain acknowledgement before accepting/clearing queued input.
  const snapshot = await requestPrimaryRecovery(sessionID);
  if (!snapshot.record || (!snapshot.enforced && !snapshot.record.readOnly)) return;
  await requestPrimaryRecovery(sessionID, 'intent');
}
