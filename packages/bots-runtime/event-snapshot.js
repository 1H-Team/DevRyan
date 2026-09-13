// A snapshot is an aggregate of many bounded events. Keep each wire part small
// and publish the complete snapshot atomically after the last part arrives.
export const BOT_EVENT_MAX_BYTES = 256 * 1024;
export const BOT_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const BOT_SNAPSHOT_PART_CHARS = 32 * 1024;
export const BOT_SNAPSHOT_FORMAT = 'parts-v1';
export const BOT_SNAPSHOT_PART_KIND = 'snapshot.part';
const MAX_PARTS = Math.ceil(BOT_SNAPSHOT_MAX_BYTES / (BOT_SNAPSHOT_PART_CHARS - 1));
const encoder = new TextEncoder();

export class BotSnapshotError extends Error {
  constructor(message, code = 'bot_event_snapshot_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotSnapshotError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const invalid = () => { throw new BotSnapshotError('Bot snapshot is invalid'); };
const tooLarge = () => {
  throw new BotSnapshotError('Bot snapshot is too large', 'bot_event_too_large', 413);
};
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasDataFields = (value, fields) => {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== fields.length) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
  });
};

// Reject an oversized or excessively nested graph before JSON.stringify can
// allocate another unbounded copy. Accessors and custom serializers are excluded.
export function encodeBotSnapshot(value) {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set();
  const add = (amount) => {
    bytes += amount;
    if (bytes > BOT_SNAPSHOT_MAX_BYTES) tooLarge();
  };
  const string = (text) => {
    if (text.length > BOT_SNAPSHOT_MAX_BYTES - bytes) tooLarge();
    add(2);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2_048) add(2);
      else if (code >= 0xD800 && code <= 0xDBFF
        && text.charCodeAt(index + 1) >= 0xDC00 && text.charCodeAt(index + 1) <= 0xDFFF) {
        add(4);
        index += 1;
      } else if (code >= 0xD800 && code <= 0xDFFF) add(6);
      else add(3);
    }
  };
  const visit = (entry, depth) => {
    if (++nodes > 1_000_000 || depth > 32) tooLarge();
    if (entry === null) return add(4);
    if (typeof entry === 'string') return string(entry);
    if (typeof entry === 'boolean') return add(entry ? 4 : 5);
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) invalid();
      return add(String(entry).length);
    }
    if (!isRecord(entry) && !Array.isArray(entry)) invalid();
    if (ancestors.has(entry)) invalid();
    const array = Array.isArray(entry);
    const prototype = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) invalid();
    ancestors.add(entry);
    add(2);
    const keys = Reflect.ownKeys(entry).filter((key) => !(array && key === 'length'));
    if (array && keys.length !== entry.length) invalid();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string' || (array && key !== String(index))) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
      if (index > 0) add(1);
      if (!array) { string(key); add(1); }
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(entry);
  };
  if (!isRecord(value)) invalid();
  visit(value, 0);
  return Object.freeze({ text: JSON.stringify(value), bytes });
}

export function splitBotSnapshot(text) {
  if (typeof text !== 'string') invalid();
  if (text.length > BOT_SNAPSHOT_MAX_BYTES || encoder.encode(text).byteLength > BOT_SNAPSHOT_MAX_BYTES) tooLarge();
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + BOT_SNAPSHOT_PART_CHARS, text.length);
    // Keep a surrogate pair together so part byte budgets sum exactly.
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts.map((part, index) => Object.freeze({ index, total: parts.length, text: part }));
}

export function createBotSnapshotAssembler() {
  let snapshotId = null;
  let expected = 0;
  let bytes = 0;
  let parts = [];
  const reset = () => { snapshotId = null; expected = 0; bytes = 0; parts = []; };
  return Object.freeze({
    reset,
    push(event) {
      try {
        if (!hasDataFields(event, ['id', 'sequence', 'kind', 'payload'])
          || event.kind !== BOT_SNAPSHOT_PART_KIND || event.sequence !== 0
          || typeof event.id !== 'string' || event.id.length > 200 || !event.id.endsWith(':0')
          || event.id.length < 3 || !isRecord(event.payload)) invalid();
        const payload = event.payload;
        if (!hasDataFields(payload, ['index', 'total', 'text'])
          || !Number.isSafeInteger(payload.index) || payload.index < 0
          || !Number.isSafeInteger(payload.total) || payload.total < 1 || payload.total > MAX_PARTS
          || payload.index >= payload.total || typeof payload.text !== 'string'
          || payload.text.length < 1 || payload.text.length > BOT_SNAPSHOT_PART_CHARS) invalid();
        if (snapshotId === null) {
          if (payload.index !== 0) invalid();
          snapshotId = event.id;
          expected = payload.total;
        }
        if (event.id !== snapshotId || payload.total !== expected || payload.index !== parts.length) invalid();
        bytes += encoder.encode(payload.text).byteLength;
        if (bytes > BOT_SNAPSHOT_MAX_BYTES) tooLarge();
        parts.push(payload.text);
        if (parts.length !== expected) return null;
        const text = parts.join('');
        const id = snapshotId;
        reset();
        const snapshot = JSON.parse(text);
        if (!isRecord(snapshot)) invalid();
        return Object.freeze({ id, sequence: 0, kind: 'snapshot', payload: snapshot });
      } catch (error) {
        reset();
        if (error instanceof BotSnapshotError) throw error;
        invalid();
      }
    },
  });
}
