import { expect, test } from 'bun:test';
import { isRebootRecoveredLease, originalRebootLease, recoverProcessLeaseAfterReboot, rebootRecoveryHash } from './session-reboot-recovery.js';

const lease = { token: '10000000-0000-4000-8000-000000000001', ownerID: '20000000-0000-4000-8000-000000000002',
  state: 'ready', executionKind: 'process', generation: 0, scope: { sessionID: 'session', messageID: 'message', userMessageID: 'user', callID: 'call' },
  directory: '/fixture/project', viewDirectory: '/fixture/ledger/views/token/view', cleaned: false, cleanupPending: false };
const proof = { fenceID: '30000000-0000-4000-8000-000000000003', previousBoot: '40000000-0000-4000-8000-000000000004',
  currentBoot: '50000000-0000-4000-8000-000000000005', originalLeaseSha256: rebootRecoveryHash(lease), viewSha256: 'a'.repeat(64) };

test('reboot attestation preserves original lease and never fabricates execution outcome', () => {
  const recovered = recoverProcessLeaseAfterReboot(lease, proof);
  expect(isRebootRecoveredLease(recovered)).toBe(true);
  expect(originalRebootLease(recovered)).toEqual(lease);
  expect(recovered.rebootRecovery.outcome).toBe('uncertain');
  expect(recovered.cancelledBeforeStart).toBeUndefined(); expect(recovered.result).toBeUndefined();
  // Relocation keeps stable lease identity, while crash retry needs the exact old record.
  expect(isRebootRecoveredLease({ ...recovered, directory: '/other/project', viewDirectory: '/other/view' })).toBe(true);
  expect(() => originalRebootLease({ ...recovered, directory: '/other/project' })).toThrow();
});

test('same boot, changed lease, forged success and unknown fields cannot authorize recovery', () => {
  for (const change of [{ currentBoot: proof.previousBoot }, { currentBoot: null }, { originalLeaseSha256: '0'.repeat(64) }, { viewSha256: null }])
    expect(() => recoverProcessLeaseAfterReboot(lease, { ...proof, ...change })).toThrow();
  const recovered = recoverProcessLeaseAfterReboot(lease, proof);
  for (const change of [{ state: 'published' }, { token: proof.fenceID }, { cancelledBeforeStart: true }, { cleanupPending: true }])
    expect(isRebootRecoveredLease({ ...recovered, ...change })).toBe(false);
  for (const change of [{ outcome: 'finished' }, { confined: true }, { previousBoot: proof.currentBoot }])
    expect(isRebootRecoveredLease({ ...recovered, rebootRecovery: { ...recovered.rebootRecovery, ...change } })).toBe(false);
});
