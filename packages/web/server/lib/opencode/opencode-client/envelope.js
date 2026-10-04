// ---------------------------------------------------------------------------
// Response envelopes (DESIGN.md C.1, [http risks]).
//
// OpenCode 2.0.20 answers in four shapes:
//   {data}              single records (session, message, inbox items)
//   {data, cursor}      paged lists (sessions, messages)
//   {location, data}    location-scoped catalog and interaction lists
//   204                 writes without a body
// and a few bare bodies (`GET /api/config` entry list, `GET /api/project`,
// `POST /interrupt` `{interrupted}`). Gen 1 answers bare v1 values; today's
// helpers unwrap a top-level `data` key defensively (`unwrapV1Payload`).
// Everything here is pure except `readResponseBody`, which reads a Response.
// ---------------------------------------------------------------------------

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Sentinel for "no body" (204 or an empty 2xx body). */
export const NO_CONTENT = Object.freeze({ noContent: true });

/** True for the {@link NO_CONTENT} sentinel. */
export const isNoContent = (value) => value === NO_CONTENT;

/**
 * Reads a fetch Response once.
 * A failure while reading the body (abort, timeout, connection reset) rejects
 * with the read error, as today's `await response.text()` does: a truncated
 * transfer is never an empty answer. Error paths preserve the same contract.
 * @param {{ status: number, text: () => Promise<string>, body?: ReadableStream<Uint8Array> | null }} response
 * @param {{ maxResponseBytes?: number, signal?: AbortSignal,
 *   onResponseRead?: (event: { phase: 'start' | 'chunk' | 'end', bytes: number }) => void }} [options]
 * @returns {Promise<{ empty: boolean, text: string, value: unknown, parsed: boolean }>}
 *   `parsed` is false when the text is not JSON (value is then `undefined`).
 */
export const readResponseBody = async (response, { maxResponseBytes, onResponseRead, signal } = {}) => {
  if (maxResponseBytes !== undefined && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)) {
    throw new TypeError('maxResponseBytes must be a positive integer');
  }
  signal?.throwIfAborted();
  let text;
  const reader = response.body?.getReader();
  if (reader) {
    const chunks = [];
    let bytes = 0;
    const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      onResponseRead?.({ phase: 'start', bytes: 0 });
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        onResponseRead?.({ phase: 'chunk', bytes: value.byteLength });
        if (maxResponseBytes !== undefined && bytes > maxResponseBytes) {
          throw Object.assign(new Error('OpenCode response exceeds the read limit'), { code: 'opencode_response_too_large', statusCode: 503 });
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
      text = Buffer.concat(chunks, bytes).toString('utf8');
    } finally {
      signal?.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      onResponseRead?.({ phase: 'end', bytes });
    }
  } else if (response.body === null || response.status === 204) {
    try { onResponseRead?.({ phase: 'start', bytes: 0 }); text = ''; }
    finally { onResponseRead?.({ phase: 'end', bytes: 0 }); }
  } else {
    // Legacy test/adapter responses have only text(). A bounded read requires
    // a stream so a large transfer can be stopped before it is buffered.
    if (maxResponseBytes !== undefined || onResponseRead !== undefined) {
      throw Object.assign(new Error('OpenCode response stream is unavailable'), { code: 'opencode_invalid_response', statusCode: 502 });
    }
    text = await response.text();
  }
  signal?.throwIfAborted();
  if (!text.trim()) return { empty: true, text, value: undefined, parsed: true };
  try {
    return { empty: false, text, value: JSON.parse(text), parsed: true };
  } catch {
    return { empty: false, text, value: undefined, parsed: false };
  }
};

/**
 * Gen 1 (today's `unwrapPayload` in `orchestration/open-code-executor.js`): a
 * top-level object with a `data` key yields `data`, anything else is returned.
 * @param {unknown} value
 */
export const unwrapV1Payload = (value) => (
  isRecord(value) && 'data' in value ? value.data : value
);

/**
 * `{data}` / `{location, data}` / `{data, cursor}` -> `data`. A bare body is
 * returned unchanged; 204 (or `null`) yields `null`.
 * @param {unknown} body
 */
export const unwrapData = (body) => {
  if (body === undefined || body === null || isNoContent(body)) return null;
  if (isRecord(body) && Object.hasOwn(body, 'data')) return body.data;
  return body;
};

/**
 * `{location, data}` -> both parts (location `null` when absent).
 * @param {unknown} body
 * @returns {{ location: Record<string, unknown> | null, data: unknown }}
 */
export const unwrapLocated = (body) => ({
  location: isRecord(body) && isRecord(body.location) ? body.location : null,
  data: unwrapData(body),
});

/**
 * `{data, cursor: {previous?, next?}}` -> rows and the next cursor. Malformed
 * pages and cursors fail explicitly rather than becoming a complete empty page.
 * @param {unknown} body
 * @returns {{ data: unknown[], next: string | undefined, previous: string | undefined }}
 */
export const unwrapPage = (body) => {
  if (!isRecord(body) || !Array.isArray(body.data) || (body.cursor != null && !isRecord(body.cursor))) {
    throw Object.assign(new Error('Invalid OpenCode page envelope'), { code: 'opencode_invalid_response', statusCode: 502 });
  }
  for (const value of Object.values(body.cursor ?? {})) {
    if (value != null && (typeof value !== 'string' || value.length === 0)) {
      throw Object.assign(new Error('Invalid OpenCode page cursor'), { code: 'opencode_invalid_response', statusCode: 502 });
    }
  }
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const cursor = isRecord(body) && isRecord(body.cursor) ? body.cursor : {};
  return {
    data,
    next: typeof cursor.next === 'string' && cursor.next.length > 0 ? cursor.next : undefined,
    previous: typeof cursor.previous === 'string' && cursor.previous.length > 0 ? cursor.previous : undefined,
  };
};

/**
 * The array inside `{data: []}` or a bare array; anything else is empty.
 * @param {unknown} body
 * @returns {unknown[]}
 */
export const unwrapList = (body) => {
  const data = unwrapData(body);
  return Array.isArray(data) ? data : [];
};
