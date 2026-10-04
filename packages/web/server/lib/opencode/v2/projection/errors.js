// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) structured errors <-> DevRyan's v1 named error union.
//
// v2 reports `Session.StructuredError {type, message, status?, response?}`.
// v1 consumers key on `error.name` and read `error.data.message`, so the
// projection produces `{name, data: {message, statusCode?, v2Type}}`:
//
//   provider.auth             -> ProviderAuthError
//   provider.error            -> APIError
//   aborted                   -> MessageAbortedError
//   provider.invalid-request  -> APIError, or ContextOverflowError when the
//                                caller-supplied overflow classifier matches
//   provider.content-filter   -> ContentFilterError
//   provider.invalid-output   -> StructuredOutputError
//   anything else             -> UnknownError
//
// `v2Type` is a lossless pass-through for classifiers that will be rewritten
// against v2 types later. `isRetryable` stays undefined; `response.body` is not
// carried (no DevRyan consumer reads v1 `responseBody`). Everything here is pure.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} V2StructuredError
 * @property {string} type
 * @property {string} message
 * @property {number} [status]
 * @property {{ body: string }} [response]
 */

/**
 * @typedef {object} V1ErrorData
 * @property {string} message
 * @property {number} [statusCode]
 * @property {string} [v2Type]
 * @property {string} [reason]
 */

/**
 * @typedef {object} V1NamedError
 * @property {string} name
 * @property {V1ErrorData} data
 */

/**
 * @typedef {object} ToV1ErrorOptions
 * @property {(message: string) => boolean} [isContextOverflow] DevRyan has no
 *   message-based overflow classifier today, so `provider.invalid-request` maps
 *   to `APIError` unless a caller supplies one.
 */

const UNKNOWN_V2_TYPE = 'unknown';
const UNKNOWN_V1_NAME = 'UnknownError';
const INVALID_REQUEST_TYPE = 'provider.invalid-request';
const CONTEXT_OVERFLOW_NAME = 'ContextOverflowError';
const OUTPUT_LENGTH_NAME = 'MessageOutputLengthError';
const OUTPUT_LENGTH_MESSAGE = 'The model exceeded its output limit';

/** v2 `type` -> v1 `name` (B.3). */
const V2_TYPE_TO_V1_NAME = new Map([
  ['provider.auth', 'ProviderAuthError'],
  ['provider.error', 'APIError'],
  ['aborted', 'MessageAbortedError'],
  [INVALID_REQUEST_TYPE, 'APIError'],
  ['provider.content-filter', 'ContentFilterError'],
  ['provider.invalid-output', 'StructuredOutputError'],
]);

/** v1 `name` -> v2 `type`, as OpenCode 2.0.20's own v1 migration maps it. */
const V1_NAME_TO_V2_TYPE = new Map([
  ['ProviderAuthError', 'provider.auth'],
  ['ContentFilterError', 'provider.content-filter'],
  [CONTEXT_OVERFLOW_NAME, INVALID_REQUEST_TYPE],
  ['StructuredOutputError', 'provider.invalid-output'],
  [OUTPUT_LENGTH_NAME, 'provider.invalid-output'],
  ['MessageAbortedError', 'aborted'],
  ['APIError', 'provider.error'],
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isHttpStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599;

/**
 * The v1 error name for a v2 error type and message.
 * @param {unknown} type
 * @param {string} message
 * @param {ToV1ErrorOptions} [options]
 * @returns {string}
 */
export const v1ErrorNameForV2Type = (type, message, options = {}) => {
  if (typeof type !== 'string') return UNKNOWN_V1_NAME;
  const name = V2_TYPE_TO_V1_NAME.get(type);
  if (name === undefined) return UNKNOWN_V1_NAME;
  if (type === INVALID_REQUEST_TYPE && typeof options.isContextOverflow === 'function'
    && options.isContextOverflow(message) === true) {
    return CONTEXT_OVERFLOW_NAME;
  }
  return name;
};

/**
 * Projects a v2 structured error into the v1 named error union. Returns
 * `undefined` when there is no error (absent or not an object), so it can be
 * applied directly to an optional `error` field.
 * @param {unknown} error
 * @param {ToV1ErrorOptions} [options]
 * @returns {V1NamedError | undefined}
 */
export const toV1Error = (error, options = {}) => {
  if (!isRecord(error)) return undefined;
  const message = typeof error.message === 'string' ? error.message : '';
  const v2Type = typeof error.type === 'string' && error.type.length > 0 ? error.type : UNKNOWN_V2_TYPE;
  /** @type {V1ErrorData} */
  const data = isHttpStatus(error.status)
    ? { message, statusCode: error.status, v2Type }
    : { message, v2Type };
  return { name: v1ErrorNameForV2Type(v2Type, message, options), data };
};

/**
 * The v1 error for `session.execution.interrupted`. v2 interruptions carry only
 * a reason (`user`, `shutdown`, `superseded`, `inactivity`) and no message.
 * @param {unknown} reason
 * @returns {V1NamedError}
 */
export const toV1InterruptError = (reason) => {
  const data = typeof reason === 'string' && reason.length > 0
    ? { message: 'Aborted', reason, v2Type: 'aborted' }
    : { message: 'Aborted', v2Type: 'aborted' };
  return { name: 'MessageAbortedError', data };
};

/**
 * Reverse direction, for fixtures and wire round trips: a v1 named error to a
 * v2 structured error. A projected error's `data.v2Type` wins over the name, so
 * `toV2Error(toV1Error(e))` keeps `type`, `message` and `status`.
 * @param {unknown} error
 * @returns {V2StructuredError | undefined}
 */
export const toV2Error = (error) => {
  if (!isRecord(error)) return undefined;
  const name = typeof error.name === 'string' ? error.name : UNKNOWN_V1_NAME;
  const data = isRecord(error.data) ? error.data : {};
  const type = typeof data.v2Type === 'string' && data.v2Type.length > 0
    ? data.v2Type
    : V1_NAME_TO_V2_TYPE.get(name) ?? UNKNOWN_V2_TYPE;
  let message = name;
  if (typeof data.message === 'string') {
    message = data.message;
  } else if (name === OUTPUT_LENGTH_NAME) {
    message = OUTPUT_LENGTH_MESSAGE;
  }
  return isHttpStatus(data.statusCode)
    ? { type, message, status: data.statusCode }
    : { type, message };
};
