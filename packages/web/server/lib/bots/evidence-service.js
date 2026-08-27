import zlib from 'node:zlib';

import {
  validateBoundedJsonObject,
  validateUuid,
} from './validation.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 4_096;
const MAX_PIXELS = 4_000_000;
const MAX_EVIDENCE_PIXELS = 1_000_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export class BotEvidenceServiceError extends Error {
  constructor(message, code = 'bot_evidence_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotEvidenceServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotEvidenceServiceError(message, code, statusCode);
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return output;
};

const paeth = (left, above, upperLeft) => {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
};

const parsePng = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 45 || bytes.byteLength > MAX_SOURCE_BYTES
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('Evidence source must be a bounded PNG', 'bot_evidence_image_invalid', 502);
  }
  let offset = 8;
  let header = null;
  const compressed = [];
  let ended = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) fail('Evidence PNG is truncated', 'bot_evidence_image_invalid', 502);
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > MAX_SOURCE_BYTES || dataEnd + 4 > bytes.byteLength) {
      fail('Evidence PNG is truncated', 'bot_evidence_image_invalid', 502);
    }
    const typeAndData = bytes.subarray(offset + 4, dataEnd);
    if (crc32(typeAndData) !== bytes.readUInt32BE(dataEnd)) {
      fail('Evidence PNG integrity check failed', 'bot_evidence_image_invalid', 502);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (header || data.byteLength !== 13) fail('Evidence PNG header is invalid', 'bot_evidence_image_invalid', 502);
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      compressed.push(Buffer.from(data));
    } else if (type === 'IEND') {
      ended = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!header || !ended || offset !== bytes.byteLength || compressed.length < 1
    || header.bitDepth !== 8 || ![2, 6].includes(header.colorType)
    || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0
    || header.width < 1 || header.height < 1
    || header.width > MAX_DIMENSION || header.height > MAX_DIMENSION
    || header.width * header.height > MAX_PIXELS) {
    fail('Evidence PNG format is unsupported', 'bot_evidence_image_invalid', 502);
  }
  const channels = header.colorType === 6 ? 4 : 3;
  const rowBytes = header.width * channels;
  let filtered;
  try {
    filtered = zlib.inflateSync(Buffer.concat(compressed), {
      maxOutputLength: (rowBytes + 1) * header.height,
    });
  } catch {
    fail('Evidence PNG pixels are invalid', 'bot_evidence_image_invalid', 502);
  }
  if (filtered.byteLength !== (rowBytes + 1) * header.height) {
    fail('Evidence PNG pixels are invalid', 'bot_evidence_image_invalid', 502);
  }
  const pixels = Buffer.alloc(rowBytes * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const filterType = filtered[y * (rowBytes + 1)];
    if (filterType > 4) fail('Evidence PNG filter is invalid', 'bot_evidence_image_invalid', 502);
    const sourceOffset = y * (rowBytes + 1) + 1;
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = filtered[sourceOffset + x];
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
      const above = y > 0 ? pixels[rowOffset + x - rowBytes] : 0;
      const upperLeft = y > 0 && x >= channels
        ? pixels[rowOffset + x - rowBytes - channels]
        : 0;
      const predictor = filterType === 1
        ? left
        : filterType === 2
          ? above
          : filterType === 3
            ? Math.floor((left + above) / 2)
            : filterType === 4
              ? paeth(left, above, upperLeft)
              : 0;
      pixels[rowOffset + x] = (raw + predictor) & 0xff;
    }
  }
  return { ...header, channels, pixels };
};

const rectangle = (value, field, width, height) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== 'height\0width\0x\0y') {
    fail(`${field} is invalid`);
  }
  const values = [value.x, value.y, value.width, value.height];
  if (!values.every(Number.isSafeInteger) || value.x < 0 || value.y < 0
    || value.width < 1 || value.height < 1 || value.x + value.width > width
    || value.y + value.height > height) {
    fail(`${field} is outside the screenshot`);
  }
  return Object.freeze({ ...value });
};

export const sanitizeBotEvidencePng = ({ bytes, bounds, redactions = [] } = {}) => {
  const image = parsePng(bytes);
  const crop = rectangle(bounds, 'evidence bounds', image.width, image.height);
  if (crop.width * crop.height > MAX_EVIDENCE_PIXELS) {
    fail('Evidence target is too large', 'bot_evidence_too_large', 413);
  }
  if (!Array.isArray(redactions) || redactions.length > 64) fail('Evidence redactions are invalid');
  const masks = redactions.map((entry, index) => rectangle(
    entry,
    `evidence redactions[${index}]`,
    image.width,
    image.height,
  ));
  const rowBytes = crop.width * image.channels;
  const outputPixels = Buffer.alloc(rowBytes * crop.height);
  for (let y = 0; y < crop.height; y += 1) {
    const sourceOffset = ((crop.y + y) * image.width + crop.x) * image.channels;
    image.pixels.copy(outputPixels, y * rowBytes, sourceOffset, sourceOffset + rowBytes);
  }
  let redactedPixelCount = 0;
  for (const mask of masks) {
    const startX = Math.max(crop.x, mask.x);
    const startY = Math.max(crop.y, mask.y);
    const endX = Math.min(crop.x + crop.width, mask.x + mask.width);
    const endY = Math.min(crop.y + crop.height, mask.y + mask.height);
    if (startX >= endX || startY >= endY) continue;
    redactedPixelCount += (endX - startX) * (endY - startY);
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = ((y - crop.y) * crop.width + (x - crop.x)) * image.channels;
        outputPixels[offset] = 0;
        outputPixels[offset + 1] = 0;
        outputPixels[offset + 2] = 0;
        if (image.channels === 4) outputPixels[offset + 3] = 0xff;
      }
    }
  }
  const filtered = Buffer.alloc((rowBytes + 1) * crop.height);
  for (let y = 0; y < crop.height; y += 1) {
    outputPixels.copy(filtered, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(crop.width, 0);
  header.writeUInt32BE(crop.height, 4);
  header[8] = 8;
  header[9] = image.colorType;
  const output = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  if (output.byteLength > MAX_EVIDENCE_BYTES) {
    fail('Redacted evidence is too large', 'bot_evidence_too_large', 413);
  }
  return Object.freeze({
    bytes: output,
    width: crop.width,
    height: crop.height,
    redactedPixelCount,
  });
};

const evidenceProjection = (row) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  actionAttemptId: row.provenance?.actionEvidence?.actionAttemptId || null,
  phase: row.provenance?.actionEvidence?.phase || null,
  contentType: row.content_type,
  ciphertextSize: Number(row.ciphertext_size || 0),
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

export function createBotEvidenceService({
  store,
  blobStore,
  authorization,
  browserService,
  now = () => new Date(),
  retentionMs = DEFAULT_RETENTION_MS,
} = {}) {
  if (!store?.repositories?.bot_action_attempts || !blobStore
    || typeof blobStore.uploadPrivate !== 'function'
    || typeof blobStore.downloadAuthorized !== 'function'
    || !authorization || typeof authorization.requireManager !== 'function'
    || !browserService || typeof browserService.capturePng !== 'function'
    || typeof now !== 'function' || !Number.isSafeInteger(retentionMs)
    || retentionMs < 60_000 || retentionMs > MAX_RETENTION_MS) {
    throw new TypeError('Bot evidence service is misconfigured');
  }

  return Object.freeze({
    async capture({
      retain,
      principal,
      actionAttemptId,
      phase,
      run,
      bot,
      channel,
      target,
      signal,
    } = {}) {
      if (retain !== true) return null;
      if (!['before', 'after'].includes(phase)) fail('Evidence phase is invalid');
      const normalizedTarget = validateBoundedJsonObject(target, 'target', 16 * 1024);
      const evidence = normalizedTarget.evidence;
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
        || Object.keys(evidence).sort().join('\0') !== 'bounds\0redactions') {
        fail('Evidence policy requires bounded target geometry', 'bot_evidence_bounds_required', 409);
      }
      const source = await browserService.capturePng({
        run,
        bot,
        ownerUserId: channel.owner_user_id,
        signal,
      });
      const sanitized = sanitizeBotEvidencePng({
        bytes: source,
        bounds: evidence.bounds,
        redactions: evidence.redactions,
      });
      const capturedAt = now();
      const capturedMs = capturedAt instanceof Date ? capturedAt.getTime() : Number(capturedAt);
      if (!Number.isFinite(capturedMs)) fail('Evidence clock is invalid', 'bot_evidence_invalid', 500);
      const expiresAt = new Date(capturedMs + retentionMs).toISOString();
      const row = await blobStore.uploadPrivate({
        principal,
        botId: validateUuid(bot.id, 'bot.id'),
        channelId: validateUuid(channel.id, 'channel.id'),
        contentType: 'image/png',
        bytes: sanitized.bytes,
        expiresAt,
        provenance: {
          actionEvidence: {
            version: 1,
            actionAttemptId: validateUuid(actionAttemptId, 'actionAttemptId'),
            runId: validateUuid(run.id, 'run.id'),
            phase,
            width: sanitized.width,
            height: sanitized.height,
            redactedPixelCount: sanitized.redactedPixelCount,
            capturedAt: new Date(capturedMs).toISOString(),
          },
        },
      });
      return evidenceProjection(row);
    },

    async download({ principal, botId, actionAttemptId, objectId } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const normalizedActionId = validateUuid(actionAttemptId, 'actionAttemptId');
      await authorization.requireManager(principal, normalizedBotId);
      const action = await store.repositories.bot_action_attempts.get({
        id: normalizedActionId,
        bot_id: normalizedBotId,
      });
      if (!action) fail('Bot action evidence was not found', 'bot_evidence_not_found', 404);
      const result = await blobStore.downloadAuthorized({
        botId: normalizedBotId,
        objectId: validateUuid(objectId, 'objectId'),
      });
      if (result.object.provenance?.actionEvidence?.actionAttemptId !== normalizedActionId) {
        fail('Bot action evidence was not found', 'bot_evidence_not_found', 404);
      }
      return Object.freeze({ evidence: evidenceProjection(result.object), bytes: result.bytes });
    },
  });
}
