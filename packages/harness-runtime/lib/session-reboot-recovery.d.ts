import type { MutationLease } from './session-mutations.js';
export const SESSION_REBOOT_RECOVERY_PROTOCOL: 'devryan.session-reboot-recovery/1';
export interface RebootRecoveryProof {
  protocol: typeof SESSION_REBOOT_RECOVERY_PROTOCOL;
  fenceID: string;
  previousBoot: string;
  currentBoot: string;
  originalLeaseSha256: string;
  viewSha256: string;
  identitySha256: string;
  originalFlags: { state: 'ready'; cleaned?: boolean; cleanupPending?: boolean };
  outcome: 'uncertain';
  retained: true;
}
export function rebootRecoveryCanonical(value: unknown): string;
export function rebootRecoveryHash(value: unknown): string;
export function isRebootRecoveredLease(value: unknown): value is MutationLease & { rebootRecovery: RebootRecoveryProof };
export function recoverProcessLeaseAfterReboot(lease: MutationLease, proof: Pick<RebootRecoveryProof,
  'fenceID' | 'previousBoot' | 'currentBoot' | 'originalLeaseSha256' | 'viewSha256'>): MutationLease & { rebootRecovery: RebootRecoveryProof };
export function originalRebootLease(lease: MutationLease): MutationLease;
