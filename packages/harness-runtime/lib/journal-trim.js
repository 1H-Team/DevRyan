import { resolveRecordSessionID } from './session-id.js';

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const RUNTIME_KEY = '__runtime__';

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const eventTypeOf = (record) => (
  record?.type === 'open_code_event' && typeof record?.payload?.type === 'string'
    ? record.payload.type
    : ''
);

const sessionKeyOf = (record) => resolveRecordSessionID(record) || RUNTIME_KEY;

const partIdentity = (record) => {
  const properties = record?.payload?.properties;
  const part = properties?.part;
  const messageID = properties?.messageID
    ?? properties?.messageId
    ?? part?.messageID
    ?? part?.messageId;
  const partID = part?.id ?? properties?.partID ?? properties?.partId;
  if (!messageID || !partID) return '';
  return `${String(messageID)}:${String(partID)}`;
};

const partIsComplete = (record) => {
  const part = record?.payload?.properties?.part;
  if (!part || typeof part !== 'object') return false;
  const status = typeof part.status === 'string' ? part.status : part.status?.type;
  return Boolean(
    part.completed
    || part.finished
    || part.time?.end
    || part.time?.ended
    || ['completed', 'done', 'error'].includes(status),
  );
};

const sessionIsIdle = (record) => {
  const eventType = eventTypeOf(record);
  if (eventType === 'session.idle') return true;
  if (eventType !== 'session.status') return false;
  const status = record?.payload?.properties?.status;
  const value = typeof status === 'string' ? status : status?.type;
  return value === 'idle';
};

const addCoalescedCount = (record, count) => ({
  ...record,
  coalesced: count,
});

export const createJournalTrimmer = (options = {}) => {
  const now = options.now ?? Date.now;
  const onFlush = typeof options.onFlush === 'function' ? options.onFlush : () => {};
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const pending = new Map();
  const counters = new Map();
  let pendingBytes = 0;
  let order = 0;

  const counterFor = (sessionKey) => {
    let counter = counters.get(sessionKey);
    if (!counter) {
      counter = {
        trimmedDeltas: 0,
        coalescedParts: 0,
        coalescedSessionUpdates: 0,
      };
      counters.set(sessionKey, counter);
    }
    return counter;
  };

  const removeEntry = (key) => {
    const entry = pending.get(key);
    if (!entry) return null;
    pending.delete(key);
    pendingBytes -= entry.bytes;
    clearTimer(entry.timer);
    const counter = counterFor(entry.sessionKey);
    const eliminated = Math.max(0, entry.count - 1);
    if (entry.kind === 'part') counter.coalescedParts += eliminated;
    else counter.coalescedSessionUpdates += eliminated;
    return addCoalescedCount(entry.record, entry.count);
  };

  const emitKeys = (keys, notify = false) => {
    const records = [];
    for (const key of keys) {
      const record = removeEntry(key);
      if (record) records.push(record);
    }
    if (notify && records.length > 0) onFlush(records);
    return records;
  };

  const keysForSession = (sessionKey) => [...pending.entries()]
    .filter(([, entry]) => entry.sessionKey === sessionKey)
    .sort((left, right) => left[1].order - right[1].order)
    .map(([key]) => key);

  const flushOldestUntilWithinCap = () => {
    const records = [];
    while (pending.size > maxEntries || pendingBytes > maxBytes) {
      let oldestKey = '';
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const [key, entry] of pending) {
        if (entry.order >= oldestOrder) continue;
        oldestKey = key;
        oldestOrder = entry.order;
      }
      if (!oldestKey) break;
      records.push(...emitKeys([oldestKey]));
    }
    return records;
  };

  const scheduleEntry = (key, entry) => {
    clearTimer(entry.timer);
    entry.timer = setTimer(() => {
      emitKeys([key], true);
    }, debounceMs);
    entry.timer?.unref?.();
  };

  const hold = (key, kind, record, sessionKey) => {
    const previous = pending.get(key);
    if (previous) {
      pendingBytes -= previous.bytes;
      clearTimer(previous.timer);
    }
    const entry = {
      kind,
      record,
      sessionKey,
      count: (previous?.count ?? 0) + 1,
      bytes: byteLength(record),
      order: previous?.order ?? order++,
      timer: null,
      updatedAt: now(),
    };
    pending.set(key, entry);
    pendingBytes += entry.bytes;
    scheduleEntry(key, entry);
    return flushOldestUntilWithinCap();
  };

  const admit = (record) => {
    const eventType = eventTypeOf(record);
    if (!eventType) return [record];
    const sessionKey = sessionKeyOf(record);

    if (eventType === 'message.part.delta') {
      counterFor(sessionKey).trimmedDeltas += 1;
      return [];
    }

    if (eventType === 'message.part.updated') {
      const identity = partIdentity(record);
      if (!identity) return [record];
      const key = `part:${sessionKey}:${identity}`;
      const ready = hold(key, 'part', record, sessionKey);
      if (partIsComplete(record)) ready.push(...emitKeys([key]));
      return ready;
    }

    if (eventType === 'session.updated') {
      return hold(`session:${sessionKey}`, 'session', record, sessionKey);
    }

    const ready = [];
    if (
      eventType === 'message.updated'
      || sessionIsIdle(record)
      || eventType === 'session.deleted'
    ) {
      ready.push(...emitKeys(keysForSession(sessionKey)));
    }
    ready.push(record);
    return ready;
  };

  const flushAll = () => emitKeys(
    [...pending.entries()]
      .sort((left, right) => left[1].order - right[1].order)
      .map(([key]) => key),
  );

  const flushSession = (sessionID) => emitKeys(keysForSession(sessionID || RUNTIME_KEY));

  const stats = () => {
    const output = Object.create(null);
    for (const [key, value] of counters) {
      output[key] = { ...value };
    }
    return output;
  };

  const reset = () => {
    for (const entry of pending.values()) clearTimer(entry.timer);
    pending.clear();
    counters.clear();
    pendingBytes = 0;
  };

  return { admit, flushAll, flushSession, stats, reset };
};

export {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  RUNTIME_KEY,
};
