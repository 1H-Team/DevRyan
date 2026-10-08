// Turn timing for native provider requests (observation only, never an
// authority input). The controller's committed observations name the model
// request preparation and each physical send; its unawaited
// `native.provider-timing` RPC names the first response bytes and the
// Responses `response.created` frame. Native Step.Started is published after
// the first provider output, so the primary step diagnostic resolves its real
// request identity and times here, by the attempt span both share.

const MAX_ENTRIES = 256;
const KINDS = new Set(['primary', 'title', 'compaction', 'generate']);
const TRANSPORTS = new Set(['http', 'ws']);
const EVENTS = new Map([['first-byte', 'provider_first_byte'], ['response-created', 'provider_response_created']]);
const PAYLOAD_KEYS = ['controllerInstanceID', 'sessionID', 'requestID', 'kind', 'transport', 'event', 'statusCode'];

const invalid = () => Object.assign(new Error('native_provider_timing_invalid'), { code: 'native_provider_timing_invalid', statusCode: 400 });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value);
const remember = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
};

/** Exact controller payload; anything else is refused. */
export function parseNativeProviderTiming(value) {
  if (!object(value) || Object.keys(value).length !== PAYLOAD_KEYS.length || PAYLOAD_KEYS.some((key) => !Object.hasOwn(value, key))) throw invalid();
  if (!id(value.controllerInstanceID) || !id(value.sessionID) || !id(value.requestID) || !KINDS.has(value.kind)
    || !TRANSPORTS.has(value.transport) || !EVENTS.has(value.event)
    || (value.statusCode !== null && (!Number.isSafeInteger(value.statusCode) || value.statusCode < 100 || value.statusCode > 599))) throw invalid();
  return { ...value };
}

export function createNativeProviderTiming(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const prepared = new Map();
  const requests = new Map();
  const attempts = new Map();
  const mark = (input) => {
    try { options.onMark?.(input); } catch { /* Observer only. */ }
  };
  const attemptKey = (sessionID, attempt) => (object(attempt) && id(attempt.traceID) && id(attempt.spanID)
    ? `${sessionID}\0${attempt.traceID}\0${attempt.spanID}` : null);
  return {
    /** A committed native observation (already validated by its owner). */
    observe(observation) {
      if (!object(observation) || !id(observation.sessionID) || !id(observation.requestID)) return;
      const primary = observation.kind === 'primary';
      if (observation.stage === 'model-prepared') {
        remember(prepared, observation.requestID, now());
        if (primary) mark({ sessionId: observation.sessionID, mark: 'provider_request_prepared', metadata: { kind: observation.kind, requestID: observation.requestID } });
        return;
      }
      if (observation.stage !== 'physical') return;
      const at = now();
      const request = requests.get(observation.requestID) ?? { requestID: observation.requestID, sessionID: observation.sessionID,
        transport: observation.transport, preparedAt: prepared.get(observation.requestID) ?? null, sentAt: at, firstByteAt: null };
      remember(requests, observation.requestID, request);
      const key = attemptKey(observation.sessionID, observation.attempt);
      if (key && !attempts.has(key)) remember(attempts, key, request);
      if (primary) mark({ sessionId: observation.sessionID, mark: 'provider_request_sent', metadata: { kind: observation.kind, transport: observation.transport, requestID: observation.requestID } });
    },
    /** A parsed `native.provider-timing` payload. */
    response(timing) {
      const request = requests.get(timing.requestID);
      if (timing.event === 'first-byte' && request && request.firstByteAt === null) request.firstByteAt = now();
      if (timing.kind !== 'primary') return;
      mark({ sessionId: timing.sessionID, mark: EVENTS.get(timing.event),
        metadata: { kind: timing.kind, transport: timing.transport, requestID: timing.requestID, ...(timing.statusCode === null ? {} : { statusCode: timing.statusCode }) } });
    },
    /** The physical request of a native attempt span, or null when unobserved. */
    resolve({ sessionID, attempt } = {}) {
      const key = id(sessionID) ? attemptKey(sessionID, attempt) : null;
      const request = key ? attempts.get(key) : undefined;
      return request ? { ...request } : null;
    },
  };
}
