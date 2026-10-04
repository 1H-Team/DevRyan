// ---------------------------------------------------------------------------
// openCodeClient errors (DESIGN.md C.1).
//
// Every failure the client raises is an `OpenCodeClientError` with:
//   code        a DevRyan code (stable, machine-readable)
//   statusCode  the HTTP status DevRyan routes should answer with
//   retryable   true only for transient upstream unavailability
//   tag         the upstream gen-2 `_tag`, when there was one
//   operation   the client operation (`sessions.get`, ...)
//   generation  1 or 2
//
// Gen 1 keeps today's request-helper semantics (`orchestration/open-code-executor.js`):
// a non-2xx answer is `opencode_http_error` with the upstream status, an unparsable
// body is `opencode_invalid_response` (502). Gen 2 maps the typed `_tag` of the
// 2.0.20 error union to a DevRyan code (`V2_ERROR_TAG_CODES`); an untagged 503
// (the served host's readiness answer) is retryable unavailability.
//
// Error messages carry at most a bounded slice of the upstream body and never
// request headers, so credentials cannot leak through them.
// ---------------------------------------------------------------------------

export const MAX_ERROR_BODY_LENGTH = 2_000;

/** DevRyan error codes raised by the client. */
export const OPENCODE_CLIENT_ERROR_CODES = Object.freeze({
  httpError: 'opencode_http_error',
  invalidResponse: 'opencode_invalid_response',
  notFound: 'opencode_not_found',
  conflict: 'opencode_conflict',
  sessionBusy: 'opencode_session_busy',
  invalidRequest: 'opencode_invalid_request',
  unauthorized: 'opencode_unauthorized',
  forbidden: 'opencode_forbidden',
  payloadTooLarge: 'opencode_payload_too_large',
  unavailable: 'opencode_unavailable',
  upstreamFailure: 'opencode_upstream_failure',
  locationRequired: 'opencode_location_required',
  locationInvalid: 'opencode_location_invalid',
  routeDenied: 'opencode_route_denied',
  generationInvalid: 'opencode_generation_invalid',
  runtimeChanged: 'opencode_runtime_changed',
  capabilityUnavailable: 'capability_unavailable',
  admissionUnavailable: 'opencode_admission_unavailable',
  privilegeRequired: 'opencode_privilege_required',
  invalidCursor: 'opencode_invalid_cursor',
  invalidInput: 'opencode_invalid_input',
});

const C = OPENCODE_CLIENT_ERROR_CODES;

/**
 * Gen-2 `_tag` -> DevRyan code and status (the 2.0.20 OpenAPI error union).
 * @type {ReadonlyMap<string, { code: string, status: number, retryable?: boolean }>}
 */
export const V2_ERROR_TAG_CODES = new Map([
  ['SessionNotFoundError', { code: C.notFound, status: 404 }],
  ['MessageNotFoundError', { code: C.notFound, status: 404 }],
  ['FormNotFoundError', { code: C.notFound, status: 404 }],
  ['PermissionNotFoundError', { code: C.notFound, status: 404 }],
  ['AgentNotFoundError', { code: C.notFound, status: 404 }],
  ['ProviderNotFoundError', { code: C.notFound, status: 404 }],
  ['CommandNotFoundError', { code: C.notFound, status: 404 }],
  ['SkillNotFoundError', { code: C.notFound, status: 404 }],
  ['McpServerNotFoundError', { code: C.notFound, status: 404 }],
  ['ProjectNotFoundError', { code: C.notFound, status: 404 }],
  ['IntegrationNotFoundError', { code: C.notFound, status: 404 }],
  ['IntegrationMethodNotFoundError', { code: C.notFound, status: 404 }],
  ['IntegrationAttemptNotFoundError', { code: C.notFound, status: 404 }],
  ['FileNotFoundError', { code: C.notFound, status: 404 }],
  ['RouteNotFound', { code: C.notFound, status: 404 }],
  ['SessionBusyError', { code: C.sessionBusy, status: 409 }],
  ['ConflictError', { code: C.conflict, status: 409 }],
  ['FormAlreadySettledError', { code: C.conflict, status: 409 }],
  ['InvalidRequestError', { code: C.invalidRequest, status: 400 }],
  ['InvalidCursorError', { code: C.invalidRequest, status: 400 }],
  ['FormInvalidAnswerError', { code: C.invalidRequest, status: 400 }],
  ['UnauthorizedError', { code: C.unauthorized, status: 401 }],
  ['ForbiddenError', { code: C.forbidden, status: 403 }],
  ['InstructionEntryValueTooLargeError', { code: C.payloadTooLarge, status: 413 }],
  ['ServiceUnavailableError', { code: C.unavailable, status: 503, retryable: true }],
  ['CommandExecutionError', { code: C.upstreamFailure, status: 500 }],
  ['UnknownError', { code: C.upstreamFailure, status: 500 }],
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The error every client failure is raised as. */
export class OpenCodeClientError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, statusCode: number, retryable?: boolean, tag?: string | null,
   *   operation?: string | null, generation?: 1 | 2 | null, detail?: unknown, cause?: unknown }} options
   */
  constructor(message, options) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpenCodeClientError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable === true;
    this.tag = options.tag ?? null;
    this.operation = options.operation ?? null;
    this.generation = options.generation ?? null;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/**
 * @param {string} code
 * @param {number} statusCode
 * @param {string} message
 * @param {{ operation?: string | null, generation?: 1 | 2 | null, detail?: unknown, retryable?: boolean, tag?: string | null, cause?: unknown }} [context]
 */
export const createOpenCodeClientError = (code, statusCode, message, context = {}) => (
  new OpenCodeClientError(message, { code, statusCode, ...context })
);

/** True for a client error (or an upstream status) that means "not found". */
export const isOpenCodeNotFoundError = (error) => (
  isRecord(error) && (error.code === C.notFound || error.statusCode === 404)
);

const truncate = (text) => (typeof text === 'string' ? text.slice(0, MAX_ERROR_BODY_LENGTH).trim() : '');

/**
 * A 2xx body that is not JSON.
 * @param {{ label: string, operation?: string, generation: 2 }} input
 */
export const createInvalidResponseError = ({ label, operation, generation }) => (
  new OpenCodeClientError(`${label} returned invalid JSON`, {
    code: C.invalidResponse,
    statusCode: 502,
    operation: operation ?? label,
    generation,
  })
);

const statusFallback = (status) => {
  if (status === 404) return { code: C.notFound, status: 404 };
  if (status === 409) return { code: C.conflict, status: 409 };
  if (status === 400) return { code: C.invalidRequest, status: 400 };
  if (status === 401) return { code: C.unauthorized, status: 401 };
  if (status === 403) return { code: C.forbidden, status: 403 };
  if (status === 413) return { code: C.payloadTooLarge, status: 413 };
  if (status === 503) return { code: C.unavailable, status: 503, retryable: true };
  if (status >= 500) return { code: C.upstreamFailure, status };
  return { code: C.httpError, status };
};

/**
 * The DevRyan mapping of a gen-2 error answer. A known `_tag` decides; an
 * unknown or missing tag falls back on the HTTP status.
 * @param {number} status
 * @param {unknown} body the parsed error body (or `null`)
 * @returns {{ code: string, status: number, retryable: boolean, tag: string | null }}
 */
export const mapV2ErrorResponse = (status, body) => {
  const tag = isRecord(body) && typeof body._tag === 'string' && body._tag.length > 0 ? body._tag : null;
  const mapped = (tag ? V2_ERROR_TAG_CODES.get(tag) : undefined) ?? statusFallback(status);
  return { code: mapped.code, status: mapped.status, retryable: mapped.retryable === true, tag };
};

/**
 * Gen 2: a non-2xx answer as a client error, keyed on the typed `_tag`.
 * @param {{ status: number, body: unknown, bodyText: string, label: string, operation?: string }} input
 */
export const createV2HttpError = ({ status, body, bodyText, label, operation }) => {
  const mapped = mapV2ErrorResponse(status, body);
  const upstreamMessage = isRecord(body) && typeof body.message === 'string' ? body.message : truncate(bodyText);
  const message = `${label} failed (${status}${mapped.tag ? ` ${mapped.tag}` : ''})${upstreamMessage ? `: ${truncate(upstreamMessage)}` : ''}`;
  return new OpenCodeClientError(message, {
    code: mapped.code,
    statusCode: mapped.status,
    retryable: mapped.retryable,
    tag: mapped.tag,
    operation: operation ?? label,
    generation: 2,
  });
};

/**
 * A capability gen 2 (or gen 1, for the privileged client) does not offer.
 * @param {string} capability
 * @param {{ operation?: string, generation?: 1 | 2 | null }} [context]
 */
export const createCapabilityUnavailableError = (capability, context = {}) => (
  new OpenCodeClientError(`OpenCode capability unavailable: ${capability}`, {
    code: C.capabilityUnavailable,
    statusCode: 501,
    operation: context.operation ?? capability,
    generation: context.generation ?? null,
    detail: { capability },
  })
);
