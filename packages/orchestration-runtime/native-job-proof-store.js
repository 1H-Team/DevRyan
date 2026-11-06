import { decodeLedgerSnapshot } from './codec.js';
import { isManagedNativeJobTombstone } from './persistence.js';

/** Directory beside `ledger.json` that holds released native-job proofs. */
export const MANAGED_NATIVE_JOB_PROOF_DIRECTORY = 'native-job-proofs';
export const MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT = 64;
// Every shard must stay readable by the bundle document readers, which bound
// one document at 32 MiB. 64 shards hold about a million 1.9 KB proofs.
export const MANAGED_NATIVE_JOB_PROOF_SHARD_MAX_BYTES = 32 * 1024 * 1024;
/** Every shard name, in order: two lowercase hex digits, `00` to `3f`. */
export const MANAGED_NATIVE_JOB_PROOF_SHARDS = Object.freeze(Array.from({ length: MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT },
  (_value, index) => index.toString(16).padStart(2, '0')));
const SHARDS = new Set(MANAGED_NATIVE_JOB_PROOF_SHARDS);
const DOCUMENT_KEYS = new Set(['version', 'shard', 'tasks', 'resultEnvelopes']);

const proofError = (code, message) => Object.assign(new TypeError(message), { code });
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isManagedNativeJobProofShard = value => typeof value === 'string' && SHARDS.has(value);

/** The shard of a task ID: 32-bit FNV-1a over its UTF-16 code units. */
export const managedNativeJobProofShard = (taskId) => {
  if (typeof taskId !== 'string' || !taskId) throw proofError('native_job_proof_invalid', 'native job proof task ID is invalid');
  let hash = 0x811c9dc5;
  for (let index = 0; index < taskId.length; index += 1) {
    hash ^= taskId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return MANAGED_NATIVE_JOB_PROOF_SHARDS[hash % MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT];
};

/** The file name of a shard inside `MANAGED_NATIVE_JOB_PROOF_DIRECTORY`. */
export const managedNativeJobProofShardFile = (shard) => {
  if (!isManagedNativeJobProofShard(shard)) throw proofError('native_job_proof_shard_invalid', 'native job proof shard name is invalid');
  return `${shard}.json`;
};

/**
 * Decodes one shard document into `{ task, envelope }` proofs. The document is
 * a version-1 ledger snapshot with its `shard` name: the ledger codec validates
 * every record, envelope match and identity, and every task must be a body-free
 * native proof tombstone that hashes to this shard. Any defect throws; a shard
 * is never partially accepted.
 */
export const decodeManagedNativeJobProofShard = (value, shard) => {
  const invalid = detail => proofError('native_job_proof_shard_invalid', `native job proof shard ${isManagedNativeJobProofShard(shard) ? shard : '?'} is invalid: ${detail}`);
  if (!isManagedNativeJobProofShard(shard)) throw invalid('name');
  if (!isRecord(value) || value.shard !== shard || Object.keys(value).some(key => !DOCUMENT_KEYS.has(key))
    || !Array.isArray(value.resultEnvelopes)) throw invalid('document');
  let ledger;
  try {
    ledger = decodeLedgerSnapshot(value, { createError: code => invalid(code) });
  } catch (error) {
    if (error?.code === 'native_job_proof_shard_invalid') throw error;
    throw invalid('record');
  }
  if (ledger.tasks.length !== ledger.resultEnvelopes.length) throw invalid('envelope');
  const envelopes = new Map(ledger.resultEnvelopes.map(envelope => [envelope.taskId, envelope]));
  return ledger.tasks.map((task) => {
    const envelope = envelopes.get(task.taskId);
    if (!envelope || !isManagedNativeJobTombstone(task) || managedNativeJobProofShard(task.taskId) !== shard) throw invalid('proof');
    return { task, envelope };
  });
};

/** Validates one proof for its shard and returns its decoded copy. */
export const decodeManagedNativeJobProof = (entry) => {
  const shard = managedNativeJobProofShard(entry?.task?.taskId);
  return decodeManagedNativeJobProofShard({ version: 1, shard, tasks: [entry.task], resultEnvelopes: [entry.envelope] }, shard)[0];
};

/**
 * Serializes a shard's complete proof set, ordered by task ID. Callers pass
 * proofs that were decoded on load or on entry (`decodeManagedNativeJobProof`),
 * so this checks placement only and never re-validates every record.
 */
export const encodeManagedNativeJobProofShard = (shard, entries) => {
  if (!isManagedNativeJobProofShard(shard)) throw proofError('native_job_proof_shard_invalid', 'native job proof shard name is invalid');
  const sorted = [...entries].sort((left, right) => (left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0));
  for (const entry of sorted) {
    if (managedNativeJobProofShard(entry.task.taskId) !== shard || entry.envelope?.taskId !== entry.task.taskId) {
      throw proofError('native_job_proof_invalid', `native job proof does not belong to shard ${shard}`);
    }
  }
  return `${JSON.stringify({ version: 1, shard, tasks: sorted.map(entry => entry.task), resultEnvelopes: sorted.map(entry => entry.envelope) })}\n`;
};
