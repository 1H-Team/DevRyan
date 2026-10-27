// Dependency-free leaf of the orchestration codec. The record validators
// (contract.js, result-envelope.js) and the policies share these constants and
// helpers; codec.js re-exports all of them and is their public owner. Keep this
// module browser-safe and free of package imports so nothing can cycle through it.

export const MANAGED_TASK_ID_PREFIX = 'dvr_task_';
export const MANAGED_WAVE_ID_PREFIX = 'dvr_wave_';
const MANAGED_TASK_ID_PATTERN = /^dvr_task_[A-Za-z0-9_-]+$/;

export const MANAGED_TASK_STATUSES = Object.freeze([
  'queued',
  'starting',
  'running',
  'completed',
  'failed',
  'aborted',
  'interrupted',
]);
export const MANAGED_TASK_LIVE_STATUSES = Object.freeze(['queued', 'starting', 'running']);
export const MANAGED_TASK_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'aborted', 'interrupted']);

export const MANAGED_TASK_FAILURE_KINDS = Object.freeze([
  'provider_configuration',
  'runtime_capability',
  'provider_transport',
  'provider_usage_limit',
  'provider_authentication',
  'provider_prompt_rejected',
  'model_unavailable',
  'deadline_exceeded',
]);

export const AUTO_RESUME_STATES = Object.freeze([
  'planning',
  'scheduled',
  'attempting',
  'superseded',
  'succeeded',
  'ended',
  'cancelled',
  'exhausted',
  'acknowledged',
]);
export const AUTO_RESUME_ACTIVE_STATES = Object.freeze(['planning', 'scheduled', 'attempting']);
export const AUTO_RESUME_RESET_SOURCES = Object.freeze(['opencode_status', 'meridian_quota', 'backoff']);
export const AUTO_RESUME_REASONS = Object.freeze([
  'user',
  'manual_retry',
  'session_deleted',
  'cancelled',
  'attempt_cap',
  'time_cap',
  'host_failures',
  'window_rejections',
  'backup_unavailable',
]);

/** Fields a result envelope copies from its task and must keep equal to it.
 * `canonicalRefs` is compared separately, by its JSON form. */
export const MANAGED_RESULT_PAYLOAD_FIELDS = Object.freeze([
  'taskId',
  'rootSessionId',
  'parentTaskId',
  'childSessionId',
  'directory',
  'status',
  'partial',
  'failureReason',
  'attempt',
  'priorTaskId',
  'executionKind',
  'recoverablePreview',
]);
/** Task fields a tool result may omit when its envelope carries the same copy. */
export const MANAGED_RESULT_COMPACTED_FIELDS = Object.freeze(['failureReason', 'recoverablePreview', 'canonicalRefs']);

const ACTIVE_STATE_SET = new Set(AUTO_RESUME_ACTIVE_STATES);
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isManagedTaskId = value => typeof value === 'string' && MANAGED_TASK_ID_PATTERN.test(value);
export const isAutoResumeActiveState = state => ACTIVE_STATE_SET.has(state);

/**
 * The first payload field where an envelope differs from its task, or null.
 * With `requireOwnFields`, a field missing from either side is a mismatch.
 * `canonicalRefs` is reported last and compared as JSON; unserializable refs
 * report it too.
 */
export const findManagedResultPayloadMismatch = (task, envelope, { requireOwnFields = false } = {}) => {
  for (const field of MANAGED_RESULT_PAYLOAD_FIELDS) {
    if (requireOwnFields && (!Object.hasOwn(task, field) || !Object.hasOwn(envelope, field))) return field;
    if (!Object.is(task[field], envelope[field])) return field;
  }
  if (requireOwnFields && (!Array.isArray(task.canonicalRefs) || !Array.isArray(envelope.canonicalRefs))) return 'canonicalRefs';
  try {
    return JSON.stringify(task.canonicalRefs) === JSON.stringify(envelope.canonicalRefs) ? null : 'canonicalRefs';
  } catch {
    return 'canonicalRefs';
  }
};

const textEncoder = new TextEncoder();
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** UTF-8 text to base64url. `pad: false` drops the trailing `=` (every cursor). */
export const encodeBase64Url = (text, { pad }) => {
  let binary = '';
  for (const byte of textEncoder.encode(text)) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
  return pad ? encoded : encoded.replace(/=+$/g, '');
};

/**
 * Unpadded base64url back to UTF-8 text; throws TypeError on any invalid input.
 * `pad: true` restores the `=` padding before decoding (result cursor v1);
 * `pad: false` hands the unpadded text to atob as is (section cursor v2).
 */
export const decodeBase64Url = (value, { pad }) => {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw new TypeError('base64url text is invalid');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(pad ? normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=') : normalized);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch {
    throw new TypeError('base64url text is invalid');
  }
};

/** JSON with every plain object's keys in code-unit order; arrays keep theirs. */
export const stableStringify = value => JSON.stringify(value, (_key, item) => (
  isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item
));
