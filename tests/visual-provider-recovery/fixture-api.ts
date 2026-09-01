import { usePrimaryRecoveryStore, type PrimaryRecoverySnapshot } from '@/stores/usePrimaryRecoveryStore';
export let offline = false;
export const setOffline = (value: boolean) => { offline = value; window.dispatchEvent(new Event('online')); };
export const updateFixture = (state: NonNullable<PrimaryRecoverySnapshot['record']>['state'], reason?: string) => {
  const previous = usePrimaryRecoveryStore.getState().snapshots.ses_fixture?.record?.revision ?? 0;
  usePrimaryRecoveryStore.getState().accept('ses_fixture', { schemaVersion: 1, mode: 'enforce', supported: true,
    enforced: true, progressTimeoutMs: 300000, record: { sessionID: 'ses_fixture', anchorID: 'msg_original',
      failedID: 'msg_failed', recoveryID: 'msg_recovery', state, revision: previous + 1, attemptCount: 1,
      maxAttempts: 1, readOnly: true, providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'xhigh',
      reason: reason ?? (state === 'needs_attention' ? 'recovery_requires_user_action' : null), updatedAt: Date.now() } });
};
updateFixture('reconciling');
export async function requestPrimaryRecovery(_id: string, action?: string) {
  if (offline) throw new Error('Recovery status is unavailable. Stop has not been confirmed.');
  if (action) updateFixture(action === 'cancel' ? 'cancelled' : 'recovering');
  return usePrimaryRecoveryStore.getState().snapshots.ses_fixture;
}
