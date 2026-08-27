const DEFAULT_MAX_CHARS = 1_200;
const DEFAULT_OVERLAP_CHARS = 200;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS = 4_096;
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024;

export class BotChunkerError extends Error {
  constructor(message, code = 'bot_indexer_chunk_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotChunkerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotChunkerError(message, code, statusCode);
};

const safeBoundary = (text, index) => {
  if (index <= 0 || index >= text.length) return index;
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
    ? index - 1
    : index;
};

const chooseBreak = (text, hardEnd, minimumEnd) => {
  if (hardEnd >= text.length) return text.length;
  for (const separator of ['\n\n', '\n', ' ']) {
    const candidate = text.lastIndexOf(separator, hardEnd);
    if (candidate >= minimumEnd) return candidate + separator.length;
  }
  return hardEnd;
};

export function chunkBotText(text, {
  maxChars = DEFAULT_MAX_CHARS,
  overlapChars = DEFAULT_OVERLAP_CHARS,
} = {}) {
  if (typeof text !== 'string') {
    fail('Index source must be text');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
    fail('Index source exceeds the byte limit', 'bot_indexer_chunk_limit', 413);
  }
  if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 8_192
    || !Number.isInteger(overlapChars) || overlapChars < 0
    || overlapChars > Math.floor(maxChars / 2)) {
    fail('Chunking limits are invalid');
  }
  const normalized = text.normalize('NFC').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (!normalized) return Object.freeze([]);

  const chunks = [];
  let cursor = 0;
  let expandedBytes = 0;
  while (cursor < normalized.length) {
    const hardEnd = safeBoundary(normalized, Math.min(normalized.length, cursor + maxChars));
    const minimumEnd = Math.min(hardEnd, cursor + Math.floor(maxChars * 0.6));
    const selectedEnd = safeBoundary(normalized, chooseBreak(normalized, hardEnd, minimumEnd));
    const raw = normalized.slice(cursor, selectedEnd);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = cursor + leading;
    const end = Math.max(start, selectedEnd - trailing);
    const value = normalized.slice(start, end);
    if (value) {
      const bytes = Buffer.byteLength(value, 'utf8');
      expandedBytes += bytes;
      chunks.push(Object.freeze({
        ordinal: chunks.length,
        text: value,
        start,
        end,
        bytes,
      }));
      if (chunks.length > MAX_CHUNKS || expandedBytes > MAX_EXPANDED_BYTES) {
        fail('Chunked index source exceeds expansion limits', 'bot_indexer_chunk_limit', 413);
      }
    }
    if (selectedEnd >= normalized.length) break;
    let next = safeBoundary(normalized, Math.max(cursor + 1, selectedEnd - overlapChars));
    while (next < selectedEnd && /\s/u.test(normalized[next])) next += 1;
    cursor = Math.max(cursor + 1, next);
  }
  return Object.freeze(chunks);
}

export const BOT_CHUNK_LIMITS = Object.freeze({
  defaultMaxChars: DEFAULT_MAX_CHARS,
  defaultOverlapChars: DEFAULT_OVERLAP_CHARS,
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxChunks: MAX_CHUNKS,
  maxExpandedBytes: MAX_EXPANDED_BYTES,
});
