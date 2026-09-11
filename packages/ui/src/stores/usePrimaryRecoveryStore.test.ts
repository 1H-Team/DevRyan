import { beforeEach, expect, test } from 'bun:test';
import { hostOwnsPrimaryRecovery, usePrimaryRecoveryStore } from './usePrimaryRecoveryStore';

const snapshot = (revision = 1, state = 'recovering') => ({ schemaVersion: 1, mode: 'enforce', supported: true,
  enforced: true, progressTimeoutMs: 300000, record: { sessionID: 'ses_test', anchorID: 'msg_user', failedID: 'msg_error',
    recoveryID: 'msg_recovery', state, revision, attemptCount: 1, maxAttempts: 1, readOnly: true,
    providerID: 'openai', modelID: 'model', agent: 'orchestrator', variant: 'xhigh', reason: null, updatedAt: revision } });
beforeEach(() => usePrimaryRecoveryStore.setState({ snapshots: {} }));

test('stale projections cannot resurrect a cancelled recovery', () => {
  const store = usePrimaryRecoveryStore.getState();
  store.accept('ses_test', snapshot(3, 'cancelled'));
  store.accept('ses_test', snapshot(2));
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test.record?.state).toBe('cancelled');
});
test('unchanged snapshots preserve leaf references', () => {
  const store = usePrimaryRecoveryStore.getState();
  store.accept('ses_test', snapshot());
  const previous = usePrimaryRecoveryStore.getState().snapshots.ses_test;
  store.accept('ses_test', snapshot());
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test).toBe(previous);
});
test('mismatched identities and unsupported contract versions are rejected', () => {
  const store = usePrimaryRecoveryStore.getState();
  store.accept('ses_other', snapshot()); store.accept('ses_test', { ...snapshot(), schemaVersion: 2 });
  expect(usePrimaryRecoveryStore.getState().snapshots).toEqual({});
});
test('rollback retains host ownership of an already accepted read-only recovery', () => {
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...snapshot(), mode: 'off', enforced: false });
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(true);
});

test('Claude host enforcement suppresses renderer recovery and survives capability loss', () => {
  const current = snapshot();
  current.record.providerID = 'anthropic';
  usePrimaryRecoveryStore.getState().accept('ses_test', current);
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(true);
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...current, enforced: false, supported: false,
    record: { ...current.record, revision: 2 } });
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(true);
});

test('unverified Claude keeps manual renderer recovery available', () => {
  const current = snapshot();
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...current, enforced: false, supported: false,
    record: { ...current.record, providerID: 'anthropic', recoveryID: null, readOnly: false, attemptCount: 0 } });
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(false);
});

test('an exact pre-execution rejection pause stays host-owned on Grok with transport recovery off', () => {
  const current = snapshot(4, 'needs_attention');
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...current, mode: 'off', enforced: false, supported: false,
    record: { ...current.record, providerID: 'xai', readOnly: false, recoveryID: null,
      reason: 'managed_repeated_preexecution_rejection', attemptCount: 0, failureKind: null } });
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(true);
  expect(hostOwnsPrimaryRecovery('ses_other')).toBe(false);
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...current, mode: 'off', enforced: false, supported: false,
    record: { ...current.record, revision: 5, providerID: 'xai', readOnly: false, recoveryID: null,
      state: 'observing', reason: null, attemptCount: 0 } });
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test.record?.revision).toBe(5);
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(false);
});
