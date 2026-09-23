// A published event reaches every connected client. Payloads are never mutated
// after publication, so each is serialized once and reused for replay
// accounting, queue accounting and frames. Only recent payloads are retained:
// live fan-out reuses them within milliseconds, and a slow client or a replay
// that misses the cache simply serializes again.
const MAX_CACHED_CHARS = 4 * 1024 * 1024;
const MAX_CACHED_ENTRIES = 256;
const cache = new Map();
let cachedChars = 0;

const serialize = (payload) => {
  if (!payload || typeof payload !== 'object') {
    const json = JSON.stringify(payload);
    return { json, bytes: typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : 0 };
  }
  const hit = cache.get(payload);
  if (hit) return hit;
  const json = JSON.stringify(payload);
  const entry = { json, bytes: typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : 0 };
  if (typeof json !== 'string' || json.length > MAX_CACHED_CHARS) return entry;
  cache.set(payload, entry);
  cachedChars += json.length;
  while (cache.size > MAX_CACHED_ENTRIES || cachedChars > MAX_CACHED_CHARS) {
    const [oldest, evicted] = cache.entries().next().value;
    cache.delete(oldest);
    cachedChars -= evicted.json.length;
  }
  return entry;
};

/** JSON text of an event payload, exactly as `JSON.stringify(payload)`. */
export const serializeEventPayload = (payload) => serialize(payload).json;

/** UTF-8 size of `serializeEventPayload(payload)`. */
export const eventPayloadBytes = (payload) => serialize(payload).bytes;

/** Approximate queued size of an event entry: its payload plus framing. */
export const eventEntryBytes = (entry) => eventPayloadBytes(entry?.payload)
  + (typeof entry?.directory === 'string' ? Buffer.byteLength(entry.directory, 'utf8') : 0)
  + (typeof entry?.eventId === 'string' ? Buffer.byteLength(entry.eventId, 'utf8') : 0)
  + 96;
