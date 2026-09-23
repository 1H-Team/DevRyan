import os from 'node:os';
import path from 'node:path';

import { createDiagnosticSanitizer, createRecordStore } from '@openchamber/harness-runtime';

import { DIAGNOSTIC_IMPACTS, DIAGNOSTIC_SOURCES } from './error-diagnostics.js';

const OUTBOX_VERSION = 1;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
// A caller waits at most this long for opportunistic delivery; the record is
// already durable, and background flushes keep delivering after it returns.
const ENQUEUE_DELIVERY_WAIT_MS = 2_000;
// A caller waits for delivery only when few records are ahead of its own.
const ENQUEUE_WAIT_MAX_BACKLOG = 16;
const DRAIN_FLUSH_WAIT_MS = 5_000;
const SLOW_BACKEND_HOLD_MS = 15_000;
// 4xx (except timeout/rate limit) is a problem with one record; anything else
// means the backend is unavailable and the rest of a pass would fail too.
const isBackendUnavailable = (error) => !(Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
  && error.status !== 408 && error.status !== 429);
const CLIPBOARD_TEXT_LIMIT_BYTES = 64 * 1024;
const CLIPBOARD_PREVIEW_CHARACTERS = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9_.:/-]{1,512}$/;
const UUID_PAYLOAD_FIELDS = ['actor_user_id', 'target_user_id', 'project_id'];
const CORRELATION_PAYLOAD_FIELDS = [
  'actor_role',
  'action',
  'target_type',
  'target_id',
  'session_id',
  'request_id',
];
const ISO_TIMESTAMP_FIELDS = ['created_at'];
const DIAGNOSTIC_PAYLOAD_FIELDS = Object.freeze({
  diagnostic_impact: new Set(DIAGNOSTIC_IMPACTS),
  diagnostic_source: new Set(DIAGNOSTIC_SOURCES),
});

const normalizeUuidPayloadFields = (payload) => {
  const normalized = { ...payload };
  for (const field of UUID_PAYLOAD_FIELDS) {
    const value = payload[field];
    normalized[field] = typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
  }
  for (const [field, allowed] of Object.entries(DIAGNOSTIC_PAYLOAD_FIELDS)) {
    if (field in payload) normalized[field] = allowed.has(payload[field]) ? payload[field] : null;
  }
  return normalized;
};

const truncateUtf8 = (value, limitBytes) => {
  const source = String(value || '');
  if (Buffer.byteLength(source, 'utf8') <= limitBytes) return { text: source, truncated: false };
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(source.slice(0, middle), 'utf8') <= limitBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(source[low - 1])) low -= 1;
  return { text: source.slice(0, low), truncated: true };
};

const sanitizeAuditPayload = (payload, sanitizer) => {
  const sanitized = sanitizer.sanitizeExportValue(payload);

  if (typeof payload.clipboard_text === 'string' && typeof sanitized.clipboard_text === 'string') {
    const bounded = truncateUtf8(sanitized.clipboard_text, CLIPBOARD_TEXT_LIMIT_BYTES);
    let preview = bounded.text.slice(0, CLIPBOARD_PREVIEW_CHARACTERS);
    if (preview && /[\uD800-\uDBFF]/.test(preview.at(-1))) preview = preview.slice(0, -1);
    sanitized.clipboard_text = bounded.text;
    sanitized.clipboard_text_preview = preview;
    sanitized.clipboard_text_original_length = Number.isInteger(payload.clipboard_text_original_length)
      ? payload.clipboard_text_original_length
      : payload.clipboard_text.length;
    sanitized.clipboard_text_truncated = payload.clipboard_text_truncated === true || bounded.truncated;
    sanitized.clipboard_text_redacted = sanitized.clipboard_text !== payload.clipboard_text;
  }

  // Diagnostic high-entropy filtering is appropriate for free-form metadata,
  // but UUIDs and OpenCode/session correlation IDs are the audit schema's
  // foreign keys. Restore only tightly validated top-level identifiers after
  // sanitizing the complete payload so secrets cannot escape through metadata.
  for (const field of UUID_PAYLOAD_FIELDS) {
    const value = payload[field];
    sanitized[field] = typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
  }
  for (const field of CORRELATION_PAYLOAD_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string' && SAFE_CORRELATION_ID_PATTERN.test(value)) {
      sanitized[field] = value;
    }
  }
  for (const field of ISO_TIMESTAMP_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
      sanitized[field] = new Date(value).toISOString();
    }
  }
  for (const [field, allowed] of Object.entries(DIAGNOSTIC_PAYLOAD_FIELDS)) {
    const value = payload[field];
    if (allowed.has(value)) sanitized[field] = value;
  }

  const sanitizedMetadata = sanitized.metadata && typeof sanitized.metadata === 'object' && !Array.isArray(sanitized.metadata)
    ? sanitized.metadata
    : {};
  for (const field of ['requestedEventId', 'originalEventId']) {
    const value = payload.metadata?.[field];
    if (typeof value === 'string' && UUID_PATTERN.test(value)) {
      sanitizedMetadata[field] = value;
    }
  }
  sanitized.metadata = sanitizedMetadata;

  return sanitized;
};

const validateRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('audit outbox record must be an object');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    throw new TypeError('audit outbox payload must be an object');
  }
  return {
    payload: normalizeUuidPayloadFields(value.payload),
    attempts: Number.isInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    lastAttemptAt: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError.slice(0, 500) : null,
    sequence: Number.isSafeInteger(value.sequence) ? value.sequence : null,
  };
};

// Deliver in append order; legacy records without a sequence sort by time.
const byAppendOrder = (a, b) => (a.record.sequence ?? Date.parse(a.record.createdAt) * 1_000)
  - (b.record.sequence ?? Date.parse(b.record.createdAt) * 1_000) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const knownSecretsFromEnvironment = () => Object.entries(process.env)
  .filter(([key, value]) => (
    /(?:secret|token|password|api[_-]?key|authorization)/i.test(key)
    && typeof value === 'string'
    && value.length >= 6
  ))
  .map(([, value]) => value);

export async function createAuditOutbox({
  dataDirectory,
  supabase,
  logger = console,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
} = {}) {
  const sanitizer = createDiagnosticSanitizer({
    homeDir: os.homedir(),
    dataDir: dataDirectory,
    knownSecrets: knownSecretsFromEnvironment(),
  });
  const store = createRecordStore({
    directory: path.join(dataDirectory, 'multi-user', 'audit-outbox'),
    version: OUTBOX_VERSION,
    validateRecord,
    logger,
  });
  await store.initialize();

  let stopped = false;
  let delivered = 0;
  let deliveryFailures = 0;
  let operationTail = Promise.resolve();
  let backoffMs = 0;
  let backoffUntil = 0;
  let flushInFlight = null;
  let flushRequested = false;
  let slowUntil = 0;
  // Records appended by this process and not yet delivered or rejected.
  const undelivered = new Set();
  // Callers waiting for their own record's outcome.
  const waiters = new Map();
  const settleWaiter = (key) => { const resolve = waiters.get(key); if (resolve) { waiters.delete(key); resolve(true); } };

  const serialize = (operation) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => {});
    return result;
  };

  // Returns 'delivered', 'rejected' (this record only) or 'unavailable'.
  const deliver = async (key, record) => {
    try {
      await supabase.rest('activity_logs', {
        method: 'POST',
        query: { on_conflict: 'event_id' },
        body: { event_id: key, ...record.payload },
        prefer: 'resolution=ignore-duplicates,return=minimal',
      });
      await store.deleteRecord(key);
      undelivered.delete(key); settleWaiter(key);
      delivered += 1;
      backoffMs = 0; backoffUntil = 0;
      return 'delivered';
    } catch (error) {
      deliveryFailures += 1;
      await store.writeRecord(key, {
        ...record,
        attempts: record.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
      if (!isBackendUnavailable(error)) { undelivered.delete(key); settleWaiter(key); return 'rejected'; }
      return 'unavailable';
    }
  };

  // One pass stops once the backend is unavailable instead of spending a
  // request timeout on every remaining record. A single failure may be
  // specific to its record (a timeout on one payload), so the next record is
  // tried once; two consecutive failures end the pass. Records that failed
  // before go after fresh ones, so failing records never block later records;
  // without failures, delivery follows append order.
  // A record that failed before waits out its own backoff in background passes;
  // explicit flushes and the delivery barrier try every record.
  const recordDue = (record, now) => record.attempts === 0 || !record.lastAttemptAt
    || now >= Date.parse(record.lastAttemptAt) + Math.min(5_000 * 2 ** (record.attempts - 1), MAX_BACKOFF_MS);
  const flushUnlocked = async ({ all = true } = {}) => {
    const now = Date.now();
    const records = (await store.listRecords())
      .filter(({ record }) => all || recordDue(record, now))
      .sort((left, right) => (left.record.attempts - right.record.attempts) || byAppendOrder(left, right));
    let failedLast = false, delivered = 0, freshUnavailable = false;
    for (const { key, record } of records) {
      const outcome = await deliver(key, record);
      if (outcome === 'delivered') delivered += 1;
      freshUnavailable ||= outcome === 'unavailable' && record.attempts === 0;
      if (outcome === 'unavailable' && failedLast) break;
      failedLast = outcome === 'unavailable';
    }
    // The whole outbox backs off only when a fresh record failed and nothing
    // was delivered: one record that keeps failing never delays the others.
    if (freshUnavailable && delivered === 0) {
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : Math.max(1_000, flushIntervalMs), MAX_BACKOFF_MS);
      backoffUntil = Date.now() + backoffMs;
    }
    // A backend that keeps up drains the backlog; one that answers but falls
    // behind keeps callers off the delivery path until it catches up.
    if (delivered === records.length) slowUntil = 0;
    return records.length;
  };

  // At most one background flush runs; requests during it coalesce into more
  // passes. A barrier or explicit flush makes it yield after the current pass,
  // so steady traffic cannot keep them waiting; yielded work resumes after.
  let yieldRequested = 0;
  const runFlush = () => {
    if (flushInFlight) { flushRequested = true; return flushInFlight; }
    flushInFlight = serialize(async () => {
      let total = 0;
      do {
        flushRequested = false;
        total += await flushUnlocked({ all: false });
      } while (flushRequested && !yieldRequested && !stopped && Date.now() >= backoffUntil);
      return total;
    }).finally(() => {
      flushInFlight = null;
      if (flushRequested && !stopped) {
        flushRequested = false;
        setImmediate(() => { if (!stopped && Date.now() >= backoffUntil) requestFlush(); }).unref?.();
      }
    });
    return flushInFlight;
  };
  // Runs one pass over every record that starts after the call, even while
  // backing off; background requests only coalesce.
  const withYield = async (operation) => {
    yieldRequested += 1;
    try { return await operation(); } finally { yieldRequested -= 1; }
  };
  const flush = () => withYield(() => serialize(() => flushUnlocked({ all: true })));
  const requestFlush = () => {
    if (stopped) return;
    void runFlush().catch((error) => {
      logger.warn?.('[MultiUser] Audit outbox flush failed:', error?.message || error);
    });
  };

  // Local appends complete in call order (they never wait on the network), so
  // an ordered flush pass always sees a prefix of the append sequence.
  let lastSequence = 0;
  let writeTail = Promise.resolve();
  const writeRecord = (eventId, payload) => {
    const record = {
      payload: sanitizeAuditPayload(payload, sanitizer),
      attempts: 0,
      createdAt: new Date().toISOString(),
      lastAttemptAt: null,
      lastError: null,
      sequence: lastSequence = Math.max(lastSequence + 1, Date.now() * 1_000),
    };
    const written = writeTail.then(() => store.writeRecord(eventId, record)).then((result) => { undelivered.add(eventId); return result; });
    writeTail = written.catch(() => {});
    return written;
  };

  // Durable append first; delivery is opportunistic and bounded so an
  // unavailable Supabase never holds an audited operation or response.
  // Durable append first; delivery happens in ordered, coalesced flush passes.
  // A caller waits a bounded time for it, and never while the backend is
  // unavailable or slow, so Supabase never holds an audited operation.
  const enqueue = async (eventId, payload) => {
    await writeRecord(eventId, payload);
    if (stopped || Date.now() < backoffUntil) return;
    // The caller waits for its own record's outcome, or for a flush that ends
    // without it (an unavailable backend), never for later records.
    const outcome = new Promise((resolve) => { waiters.set(eventId, resolve); });
    const flushing = runFlush().then(() => true, () => true);
    // Waiting behind a backlog would hold this caller for other records.
    if (Date.now() < slowUntil || undelivered.size - 1 > ENQUEUE_WAIT_MAX_BACKLOG) { waiters.delete(eventId); return; }
    let timer;
    const settled = await Promise.race([outcome, flushing, new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ENQUEUE_DELIVERY_WAIT_MS);
      timer.unref?.();
    })]);
    clearTimeout(timer);
    waiters.delete(eventId);
    // A backend that has not answered within the wait is treated as slow
    // until a delivery succeeds, so later callers do not queue behind it.
    if (!settled) slowUntil = Date.now() + SLOW_BACKEND_HOLD_MS;
  };

  const enqueueDeferred = async (eventId, payload) => {
    await writeRecord(eventId, payload);
    setImmediate(() => {
      if (!stopped && Date.now() >= backoffUntil) requestFlush();
    }).unref?.();
  };

  const withFlushedDeliveryBarrier = (operation) => {
    if (typeof operation !== 'function') {
      throw new TypeError('audit outbox delivery barrier operation must be a function');
    }
    return withYield(() => serialize(async () => {
      // Only records that existed when the barrier started must be delivered;
      // later appends are delivered after the protected operation.
      const required = new Set((await store.listRecords()).map(({ key }) => key));
      await flushUnlocked();
      const pending = (await store.listRecords()).filter(({ key }) => required.has(key));
      if (pending.length > 0) {
        const error = new Error('Audit outbox backlog could not be delivered before the protected operation');
        error.code = 'DEVRYAN_AUDIT_OUTBOX_NOT_FLUSHED';
        throw error;
      }
      return operation();
    }));
  };

  const timer = setInterval(() => {
    if (!stopped && !flushInFlight && Date.now() >= backoffUntil) requestFlush();
  }, Math.max(1_000, flushIntervalMs));
  timer.unref?.();
  void flush().catch((error) => {
    logger.warn?.('[MultiUser] Initial audit outbox flush failed:', error?.message || error);
  });

  return {
    enqueue,
    enqueueDeferred,
    flush,
    withFlushedDeliveryBarrier,
    async getStatus() {
      const records = await store.listRecords();
      return {
        backlog: records.length,
        delivered,
        deliveryFailures,
        retryAfterMs: Math.max(0, backoffUntil - Date.now()),
        sanitizer: sanitizer.getReport(),
      };
    },
    async drain() {
      stopped = true;
      clearInterval(timer);
      // Records stay durable; shutdown never waits on an unavailable backend.
      let drainTimer;
      await Promise.race([flush().catch(() => {}), new Promise((resolve) => {
        drainTimer = setTimeout(resolve, DRAIN_FLUSH_WAIT_MS);
        drainTimer.unref?.();
      })]);
      clearTimeout(drainTimer);
      await store.drain();
    },
  };
}
