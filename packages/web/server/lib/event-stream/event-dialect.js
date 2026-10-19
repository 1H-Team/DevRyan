// New events use DevRyan names. The no-query wire dialect stays legacy for
// cached clients; explicit DevRyan clients receive canonical names.
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
 * Renames only a serialized payload's leading type for its connection dialect.
 * Journals can contain either spelling; payload bytes are never re-stringified.
 */
export function applyEventDialect(json, dialect) {
  if (typeof json !== 'string') return json;
  if (dialect === DEVRYAN_EVENT_DIALECT && json.startsWith(LEGACY_HEAD))
    return `${DEVRYAN_HEAD}${json.slice(LEGACY_HEAD.length)}`;
  if (dialect !== DEVRYAN_EVENT_DIALECT && json.startsWith(DEVRYAN_HEAD))
    return `${LEGACY_HEAD}${json.slice(DEVRYAN_HEAD.length)}`;
  return json;
}
