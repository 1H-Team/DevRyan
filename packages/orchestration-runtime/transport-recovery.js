import { PROVIDER_TRANSPORT_FAILURE_KINDS, classifyProviderTransportFailure } from './provider-retry-policy.js';

const PHASES = new Set(['backup_pending', 'reserved', 'submitted', 'recovered', 'exhausted', 'uncertain', 'blocked']);
const KINDS = new Set(PROVIDER_TRANSPORT_FAILURE_KINDS);
const FIELDS = new Set([
  'revision', 'phase', 'kind', 'sameModelAttempts', 'backupAttempts',
  'failedMessageId', 'failedUserMessageId', 'recoveryMessageId', 'eventId',
  'reservedAt', 'submittedAt',
]);

/** A bounded dispatch receipt, never a prompt or a replayable tool invocation. */
export const validateManagedTransportRecovery = (value) => {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('transportRecovery must be an object or null');
  }
  for (const field of Object.keys(value)) {
    if (!FIELDS.has(field)) throw new TypeError(`Unknown transportRecovery field: ${field}`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1
    || !PHASES.has(value.phase) || !KINDS.has(value.kind)
    || value.sameModelAttempts !== 1 || ![0, 1].includes(value.backupAttempts)) {
    throw new TypeError('Invalid transportRecovery state or attempt count');
  }
  for (const field of ['failedMessageId', 'failedUserMessageId', 'recoveryMessageId', 'eventId']) {
    if (value[field] === null && ['failedUserMessageId', 'eventId'].includes(field)) continue;
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 256) {
      throw new TypeError(`Invalid transportRecovery.${field}`);
    }
  }
  if (!Number.isFinite(value.reservedAt) || value.reservedAt < 0
    || (value.submittedAt !== null && (!Number.isFinite(value.submittedAt)
      || value.submittedAt < value.reservedAt))) {
    throw new TypeError('Invalid transportRecovery timestamps');
  }
  return { ...value };
};

export const isManagedTransportBackupEligible = (task) => (
  task?.transportRecovery?.phase === 'exhausted'
  && task.transportRecovery.sameModelAttempts === 1
  && task.transportRecovery.backupAttempts === 0
  && classifyProviderTransportFailure(null, task.failureReason) !== null
);

/** OpenCode sorts message IDs; reserve a fresh ID beyond the canonical tail. */
export const createManagedRecoveryMessageId = (now, latestMessageId) => {
  const clock = BigInt(Math.floor(now)) * 4096n & 0xffffffffffffn;
  const match = /^msg_([0-9a-f]{12})/i.exec(latestMessageId ?? '');
  const tail = match ? BigInt(`0x${match[1]}`) + 1n : 0n;
  const prefix = (clock > tail ? clock : tail).toString(16).padStart(12, '0');
  return `msg_${prefix}${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`;
};
