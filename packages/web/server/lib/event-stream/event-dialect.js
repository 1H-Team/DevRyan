// DevRyan event type names on the wire. Server-side payloads, journals and
// ledgers keep the `openchamber:*` literals (persisted records and in-process
// observers read them). A client that opts in with `?events=devryan` (or the
// `X-DevRyan-Events: devryan` header) receives `devryan:*`; any other client,
// such as a stale or cached tab, still receives `openchamber:*`.
export const LEGACY_EVENT_TYPE_PREFIX = 'openchamber:';
export const DEVRYAN_EVENT_TYPE_PREFIX = 'devryan:';
export const DEVRYAN_EVENT_DIALECT = 'devryan';
export const EVENT_DIALECT_QUERY = 'events';
export const EVENT_DIALECT_HEADER = 'x-devryan-events';

const LEGACY_HEAD = `{"type":"${LEGACY_EVENT_TYPE_PREFIX}`;
const DEVRYAN_HEAD = `{"type":"${DEVRYAN_EVENT_TYPE_PREFIX}`;

/** `devryan` when the request opted in, else null (legacy names). */
export function resolveEventDialect(req) {
  const header = req?.headers?.[EVENT_DIALECT_HEADER];
  if (typeof header === 'string' && header.trim().toLowerCase() === DEVRYAN_EVENT_DIALECT) return DEVRYAN_EVENT_DIALECT;
  let query = req?.query?.[EVENT_DIALECT_QUERY];
  if (query === undefined && typeof req?.url === 'string') {
    try { query = new URL(req.url, 'http://127.0.0.1').searchParams.get(EVENT_DIALECT_QUERY); } catch { query = null; }
  }
  return typeof query === 'string' && query.trim().toLowerCase() === DEVRYAN_EVENT_DIALECT ? DEVRYAN_EVENT_DIALECT : null;
}

/**
 * Renames a serialized payload's leading `openchamber:` type for an opted-in
 * connection. One prefix check and slice: the shared payload serialization is
 * reused, never re-stringified.
 */
export function applyEventDialect(json, dialect) {
  return dialect === DEVRYAN_EVENT_DIALECT && typeof json === 'string' && json.startsWith(LEGACY_HEAD)
    ? `${DEVRYAN_HEAD}${json.slice(LEGACY_HEAD.length)}` : json;
}
