import os from 'node:os';
import path from 'node:path';

import { createDiagnosticSanitizer, createRecordStore } from '@openchamber/harness-runtime';

import { DIAGNOSTIC_IMPACTS, DIAGNOSTIC_SOURCES } from './error-diagnostics.js';

const OUTBOX_VERSION = 1;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
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
  };
};

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

  const serialize = (operation) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => {});
    return result;
  };

  const deliver = async (key, record) => {
    try {
      await supabase.rest('activity_logs', {
        method: 'POST',
        query: { on_conflict: 'event_id' },
        body: { event_id: key, ...record.payload },
        prefer: 'resolution=ignore-duplicates,return=minimal',
      });
      await store.deleteRecord(key);
      delivered += 1;
      return true;
    } catch (error) {
      deliveryFailures += 1;
      await store.writeRecord(key, {
        ...record,
        attempts: record.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const flushUnlocked = async () => {
    const records = await store.listRecords();
    for (const { key, record } of records) await deliver(key, record);
    return records.length;
  };

  const flush = () => serialize(flushUnlocked);

  const enqueue = (eventId, payload) => serialize(async () => {
    const record = await store.writeRecord(eventId, {
      payload: sanitizeAuditPayload(payload, sanitizer),
      attempts: 0,
      createdAt: new Date().toISOString(),
      lastAttemptAt: null,
      lastError: null,
    });
    await deliver(eventId, record);
  });

  const enqueueDeferred = async (eventId, payload) => {
    await serialize(() => store.writeRecord(eventId, {
      payload: sanitizeAuditPayload(payload, sanitizer),
      attempts: 0,
      createdAt: new Date().toISOString(),
      lastAttemptAt: null,
      lastError: null,
    }));
    setImmediate(() => {
      if (stopped) return;
      void flush().catch((error) => {
        logger.warn?.('[MultiUser] Deferred audit outbox flush failed:', error?.message || error);
      });
    }).unref?.();
  };

  const withFlushedDeliveryBarrier = (operation) => {
    if (typeof operation !== 'function') {
      throw new TypeError('audit outbox delivery barrier operation must be a function');
    }
    return serialize(async () => {
      await flushUnlocked();
      const pending = await store.listRecords();
      if (pending.length > 0) {
        const error = new Error('Audit outbox backlog could not be delivered before the protected operation');
        error.code = 'DEVRYAN_AUDIT_OUTBOX_NOT_FLUSHED';
        throw error;
      }
      return operation();
    });
  };

  const timer = setInterval(() => {
    if (!stopped) void flush().catch((error) => {
      logger.warn?.('[MultiUser] Audit outbox flush failed:', error?.message || error);
    });
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
        sanitizer: sanitizer.getReport(),
      };
    },
    async drain() {
      stopped = true;
      clearInterval(timer);
      await flush();
      await store.drain();
    },
  };
}
