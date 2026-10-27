// Turn timing for native provider requests (observation only, never an
// authority input). The controller's committed observations name the model
// request preparation and each physical send; its unawaited
// `native.provider-timing` RPC names the first response bytes and the
// Responses `response.created` frame. Native Step.Started is published after
// the first provider output, so the primary step diagnostic resolves its real
// request identity and times here, by the attempt span both share.
// A `failed` frame is a rejected send or a failed response stream: it becomes
// one `turn.provider_request_failed` journal record and one main.log line for
// every request kind, with an optional connectivity probe of the same host.

import net from 'node:net';

const MAX_ENTRIES = 256;
const KINDS = new Set(['primary', 'title', 'compaction', 'generate']);
const TRANSPORTS = new Set(['http', 'ws']);
const EVENTS = new Map([['headers','provider_response_headers'],['first-byte', 'provider_first_byte'], ['response-created', 'provider_response_created'],['body-end','provider_body_end'],['failed','provider_request_failed']]);
const PAYLOAD_KEYS = ['controllerInstanceID', 'sessionID', 'requestID', 'kind', 'transport', 'event', 'statusCode'];
const DETAIL_KEYS = new Map([['body-end', 'body'], ['failed', 'failure']]);
const PHASES = new Set(['connect', 'headers', 'stream']);
const FAILURE_KEYS = ['phase', 'elapsedMs', 'code', 'host', 'port', 'providerID', 'modelID', 'providerRequestID'];
export const PROVIDER_PROBE_WINDOW_MS = 60_000;
export const PROVIDER_PROBE_TIMEOUT_MS = 3_000;

const invalid = () => Object.assign(new Error('native_provider_timing_invalid'), { code: 'native_provider_timing_invalid', statusCode: 400 });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const validFailure = (value) => object(value)
  && Object.keys(value).length === FAILURE_KEYS.length + Number(value.phase === 'stream')
  && FAILURE_KEYS.every((key) => Object.hasOwn(value, key)) && PHASES.has(value.phase)
  && count(value.elapsedMs) && (value.phase !== 'stream' || count(value.sinceLastByteMs))
  && typeof value.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value.code)
  && (value.host === null || (typeof value.host === 'string' && /^[A-Za-z0-9.:-]{1,253}$/.test(value.host)))
  && (value.port === null || (Number.isSafeInteger(value.port) && value.port > 0 && value.port < 65536))
  && id(value.providerID) && id(value.modelID)
  && (value.providerRequestID === null || (typeof value.providerRequestID === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.providerRequestID)));
const remember = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
};

/** Exact controller payload; anything else is refused. */
export function parseNativeProviderTiming(value) {
  const detail = DETAIL_KEYS.get(value?.event);
  if (!object(value) || Object.keys(value).length !== PAYLOAD_KEYS.length + Number(Boolean(detail)) || PAYLOAD_KEYS.some((key) => !Object.hasOwn(value, key))
    || (detail && !Object.hasOwn(value, detail))) throw invalid();
  if (!id(value.controllerInstanceID) || !id(value.sessionID) || !id(value.requestID) || !KINDS.has(value.kind)
    || !TRANSPORTS.has(value.transport) || !EVENTS.has(value.event)
    || (value.statusCode !== null && (!Number.isSafeInteger(value.statusCode) || value.statusCode < 100 || value.statusCode > 599))) throw invalid();
  if(value.event==='body-end'&&(!object(value.body)||Object.keys(value.body).length!==3
    ||!['bytes','chunks','maxGapMs'].every(key=>Number.isSafeInteger(value.body[key])&&value.body[key]>=0)))throw invalid();
  if (value.event === 'failed' && (value.statusCode !== null || !validFailure(value.failure))) throw invalid();
  return detail ? { ...value, [detail]: { ...value[detail] } } : { ...value };
}

/** DNS + TCP connect to the failed host within the budget: `ok` or `unreachable`. */
export function probeProviderHost({ host, port }, { timeoutMs = PROVIDER_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let socket;
    const finish = (result) => {
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('unreachable'), timeoutMs);
    try {
      socket = net.connect({ host, port });
      socket.once('connect', () => finish('ok'));
      socket.once('error', () => finish('unreachable'));
    } catch {
      finish('unreachable');
    }
  });
}

/** One main.log line; every field was validated by the parser. */
export function formatNativeProviderFailure(record) {
  const fields = [`session=${record.sessionID}`, `request=${record.requestID}`, `kind=${record.kind}`, `transport=${record.transport}`, `phase=${record.phase}`,
    `code=${record.code}`, `host=${record.host ?? '?'}${record.port === null ? '' : `:${record.port}`}`,
    `model=${record.providerID}/${record.modelID}`, `elapsedMs=${record.elapsedMs}`,
    ...(record.sinceLastByteMs === undefined ? [] : [`sinceLastByteMs=${record.sinceLastByteMs}`]),
    ...(record.statusCode === null ? [] : [`status=${record.statusCode}`]),
    ...(record.providerRequestID === null ? [] : [`providerRequestID=${record.providerRequestID}`]),
    ...(record.probe === undefined ? [] : [`probe=${record.probe}`])];
  return `[native-provider] request failed ${fields.join(' ')}`;
}

export function createNativeProviderTiming(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const prepared = new Map();
  const requests = new Map();
  const attempts = new Map();
  const mark = (input) => {
    try { options.onMark?.(input); } catch { /* Observer only. */ }
  };
  const probedAt = new Map();
  const report = (record) => {
    try { options.onFailure?.(record); } catch { /* Observer only. */ }
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
      const request = requests.get(observation.requestID) ?? { requestID: observation.requestID, sessionID: observation.sessionID, kind: observation.kind,
        transport: observation.transport, preparedAt: prepared.get(observation.requestID) ?? null, sentAt: at, headersAt:null,firstByteAt: null };
      remember(requests, observation.requestID, request);
      const key = attemptKey(observation.sessionID, observation.attempt);
      if (key && !attempts.has(key)) remember(attempts, key, request);
      if (primary) mark({ sessionId: observation.sessionID, mark: 'provider_request_sent', metadata: { kind: observation.kind, transport: observation.transport, requestID: observation.requestID } });
    },
    /** A parsed `native.provider-timing` payload. */
    response(timing) {
      if (timing.event === 'failed') {
        const { controllerInstanceID: _controller, event: _event, failure, ...request } = timing;
        const record = { ...request, ...failure };
        const at = now();
        const probe = typeof options.probe === 'function' && record.host !== null && record.port !== null
          && !(at - (probedAt.get(record.host) ?? -Infinity) < PROVIDER_PROBE_WINDOW_MS);
        if (!probe) return report(record);
        remember(probedAt, record.host, at);
        // The record waits for the bounded probe; a failed probe is still a record.
        void Promise.resolve().then(() => options.probe({ host: record.host, port: record.port }))
          .then((result) => (result === 'ok' ? 'ok' : 'unreachable'), () => 'unreachable')
          .then((result) => report({ ...record, probe: result }));
        return;
      }
      const request = requests.get(timing.requestID);
      if (!request || request.sessionID !== timing.sessionID || request.kind !== timing.kind) return;
      if (timing.event === 'first-byte' && request && request.firstByteAt === null) request.firstByteAt = now();
      if(timing.event==='headers'&&request.headersAt===null)request.headersAt=now();
      if (timing.kind !== 'primary') return;
      mark({ sessionId: timing.sessionID, mark: EVENTS.get(timing.event),
        metadata: { kind: timing.kind, transport: timing.transport, requestID: timing.requestID, ...(timing.statusCode === null ? {} : { statusCode: timing.statusCode }),
          ...timing.event==='body-end'?timing.body:{} } });
    },
    /** The physical request of a native attempt span, or null when unobserved. */
    resolve({ sessionID, attempt } = {}) {
      const key = id(sessionID) ? attemptKey(sessionID, attempt) : null;
      const request = key ? attempts.get(key) : undefined;
      return request ? { ...request } : null;
    },
  };
}
