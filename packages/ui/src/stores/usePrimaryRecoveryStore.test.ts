import { beforeEach, expect, test } from 'bun:test';
import { hostOwnsPrimaryRecovery, primaryRecoveryDefersToHost, usePrimaryRecoveryStore } from './usePrimaryRecoveryStore';

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

test('retained input stays host-owned without a primary record or watchdog support', () => {
  const retained = { ...snapshot(), supported: false, enforced: false, mode: 'off', record: null,
    recoveredInput: { revision: 'a'.repeat(64), state: 'paused', inputs: [{ messageID: 'msg_pending', payloadHash: 'b'.repeat(64),
      type: 'user', delivery: 'queue', location: 'queued', preview: 'First request', attachmentCount: 0,
      canResume: true, canDiscard: true, reason: null }] } };
  usePrimaryRecoveryStore.getState().accept('ses_test', retained);
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(true);
  expect(hostOwnsPrimaryRecovery('ses_other')).toBe(false);
  const previous = usePrimaryRecoveryStore.getState().snapshots.ses_test;
  usePrimaryRecoveryStore.getState().accept('ses_test', retained);
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test).toBe(previous);
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...retained,
    recoveredInput: { ...retained.recoveredInput, inputs: Array(129).fill(retained.recoveredInput.inputs[0]) } });
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test).toBe(previous);
});

test('partial record events preserve retained inventory until a full host snapshot confirms clearance', () => {
  const current = { ...snapshot(), recoveredInput: { revision: 'a'.repeat(64), state: 'paused', inputs: [] } };
  usePrimaryRecoveryStore.getState().accept('ses_test', current);
  const inventory = usePrimaryRecoveryStore.getState().snapshots.ses_test.recoveredInput;
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...snapshot(2, 'cancelled'), recoveredInputPartial: true });
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test.recoveredInput).toBe(inventory);
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(true);
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...snapshot(2, 'cancelled'), record: null });
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test.recoveredInput).toBeUndefined();
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test.recoveredInputPartial).toBeUndefined();
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(false);
});

test('a pending native transport continuation hides the manual card until the host declines or acts', () => {
  const store = usePrimaryRecoveryStore.getState();
  const current = snapshot(1, 'observing');
  const pending = { ...current, mode: 'observe', enforced: false, supported: false, automaticRecoveryPending: true,
    record: { ...current.record, recoveryID: null, readOnly: false, attemptCount: 0 } };
  store.accept('ses_test', pending);
  const read = () => usePrimaryRecoveryStore.getState().snapshots.ses_test;
  // The renderer still offers its card (it is not host-owned); only the card defers.
  expect(hostOwnsPrimaryRecovery('ses_test')).toBe(false);
  expect(primaryRecoveryDefersToHost(read())).toBe(true);
  store.accept('ses_test', { ...pending, automaticRecoveryPending: false,
    record: { ...pending.record, revision: 2, reason: 'failure_not_eligible' } });
  expect(primaryRecoveryDefersToHost(read())).toBe(false);
  store.accept('ses_test', { ...pending, automaticRecoveryPending: false,
    record: { ...current.record, revision: 3, state: 'recovering' } });
  expect(primaryRecoveryDefersToHost(read())).toBe(true);
  expect(primaryRecoveryDefersToHost(undefined)).toBe(false);
  // An older host without the field keeps today's manual behaviour.
  const { automaticRecoveryPending: _omitted, ...legacy } = pending;
  store.accept('ses_test', { ...legacy, record: { ...legacy.record, revision: 4 } });
  expect(primaryRecoveryDefersToHost(read())).toBe(false);
});
