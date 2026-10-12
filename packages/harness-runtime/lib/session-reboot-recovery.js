import { createHash } from 'node:crypto';
import { changeError } from './session-changes-git.js';

export const SESSION_REBOOT_RECOVERY_PROTOCOL = 'devryan.session-reboot-recovery/1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const rebootRecoveryHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const identity = lease => ({ token: lease.token, ownerID: lease.ownerID, scope: lease.scope,
  generation: lease.generation, executionKind: lease.executionKind });
const validIdentity = lease => uuid.test(lease?.token) && uuid.test(lease?.ownerID)
  && Number.isSafeInteger(lease.generation) && lease.generation >= 0
  && ['sessionID', 'messageID', 'userMessageID', 'callID'].every(key => typeof lease.scope?.[key] === 'string'
    && lease.scope[key].length > 0 && lease.scope[key].length <= 1024 && !lease.scope[key].includes('\0'));

/** A reboot proves termination, never confinement, command success or publication. */
export function isRebootRecoveredLease(lease) {
  const proof = lease?.rebootRecovery;
  return validIdentity(lease) && lease.executionKind === 'process' && lease.state === 'cancelled' && lease.cleaned === true
    && lease.cleanupPending === false && lease.cancelledBeforeStart !== true
    && lease.result === undefined
    && proof?.protocol === SESSION_REBOOT_RECOVERY_PROTOCOL && proof.outcome === 'uncertain' && proof.retained === true
    && uuid.test(proof.fenceID) && uuid.test(proof.previousBoot) && uuid.test(proof.currentBoot)
    && proof.previousBoot.toLowerCase() !== proof.currentBoot.toLowerCase()
    && digest.test(proof.originalLeaseSha256) && digest.test(proof.viewSha256)
    && proof.identitySha256 === rebootRecoveryHash(identity(lease))
    && proof.originalFlags?.state === 'ready'
    && Object.keys(proof.originalFlags).every(key => ['state', 'cleaned', 'cleanupPending'].includes(key))
    && ['cleaned', 'cleanupPending'].every(key => proof.originalFlags[key] === undefined || typeof proof.originalFlags[key] === 'boolean')
    && Object.keys(proof).sort().join(',') === 'currentBoot,fenceID,identitySha256,originalFlags,originalLeaseSha256,outcome,previousBoot,protocol,retained,viewSha256';
}

/** Only the cold host calls this after its locked, exact fence and boot checks. */
export function recoverProcessLeaseAfterReboot(lease, { fenceID, previousBoot, currentBoot, originalLeaseSha256, viewSha256 }) {
  if (lease?.state !== 'ready' || lease.executionKind !== 'process' || lease.cancelledBeforeStart
    || !validIdentity(lease) || lease.result !== undefined || lease.rebootRecovery
    || rebootRecoveryHash(lease) !== originalLeaseSha256) throw changeError('bundle_reboot_recovery_changed');
  const recovered = { ...lease, state: 'cancelled', cleaned: true, cleanupPending: false,
    rebootRecovery: { protocol: SESSION_REBOOT_RECOVERY_PROTOCOL, fenceID, previousBoot, currentBoot,
      originalLeaseSha256, viewSha256, identitySha256: rebootRecoveryHash(identity(lease)),
      originalFlags: Object.fromEntries(['state', 'cleaned', 'cleanupPending'].filter(key => Object.hasOwn(lease, key)).map(key => [key, lease[key]])),
      outcome: 'uncertain', retained: true } };
  if (!isRebootRecoveredLease(recovered)) throw changeError('bundle_reboot_recovery_invalid');
  return recovered;
}

/** Crash recovery compares the original ledger without discarding its attestation. */
export function originalRebootLease(lease) {
  if (!isRebootRecoveredLease(lease)) throw changeError('bundle_reboot_recovery_invalid');
  const original = { ...lease };
  delete original.rebootRecovery;
  for (const key of ['state', 'cleaned', 'cleanupPending']) {
    delete original[key];
    if (Object.hasOwn(lease.rebootRecovery.originalFlags, key)) original[key] = lease.rebootRecovery.originalFlags[key];
  }
  if (rebootRecoveryHash(original) !== lease.rebootRecovery.originalLeaseSha256) throw changeError('bundle_reboot_recovery_changed');
  return original;
}
