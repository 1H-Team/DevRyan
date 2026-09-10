import { usePrimaryRecoveryStore, type PrimaryRecoverySnapshot } from '@/stores/usePrimaryRecoveryStore';
export let offline = false;
export const setOffline = (value: boolean) => { offline = value; window.dispatchEvent(new Event('online')); };
let providerID = 'openai';
export const setFixtureProvider = (value: 'openai' | 'anthropic') => { providerID = value; updateFixture('reconciling', value === 'anthropic' ? 'chunk_timeout' : undefined); };
export const updateFixture = (state: NonNullable<PrimaryRecoverySnapshot['record']>['state'], reason?: string) => {
  const uncertain = reason === 'recovery_tool_outcome_unknown';
  const previous = usePrimaryRecoveryStore.getState().snapshots.ses_fixture?.record?.revision ?? 0;
  usePrimaryRecoveryStore.getState().accept('ses_fixture', { schemaVersion: 1, mode: 'enforce', supported: true,
    enforced: true, progressTimeoutMs: 300000, record: { sessionID: 'ses_fixture', anchorID: 'msg_original',
      failedID: 'msg_failed', recoveryID: uncertain ? null : 'msg_recovery', state, revision: previous + 1, attemptCount: uncertain ? 0 : 1,
      maxAttempts: 1, readOnly: !uncertain, providerID, modelID: providerID === 'anthropic' ? 'claude-opus-5' : 'gpt-5.6-sol', agent: 'orchestrator', variant: 'xhigh',
      reason: reason ?? (state === 'needs_attention' ? 'recovery_requires_user_action' : null), updatedAt: Date.now() } });
};
updateFixture('reconciling');
export async function requestPrimaryRecovery(_id: string, action?: string) {
  if (offline) throw new Error('Recovery status is unavailable. Stop has not been confirmed.');
  if (action) updateFixture(action === 'cancel' ? 'cancelled' : 'recovering');
  return usePrimaryRecoveryStore.getState().snapshots.ses_fixture;
}
