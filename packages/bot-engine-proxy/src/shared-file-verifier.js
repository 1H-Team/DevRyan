import crypto from 'node:crypto';

import { BOT_SHARED_FILE_MAX_BYTES } from './workspace-archive.js';

const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = BOT_SHARED_FILE_MAX_BYTES + (4 * TAR_BLOCK_BYTES);

export class BotSharedFileVerificationError extends Error {
  constructor(message, code = 'bot_supervisor_shared_file_integrity_failed') {
    super(message);
    this.name = 'BotSharedFileVerificationError';
    this.code = code;
    this.statusCode = 502;
  }
}

const fail = (message) => {
  throw new BotSharedFileVerificationError(message);
};

const tarString = (block, offset, length) => (
  block.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '')
);

const tarOctal = (block, offset, length) => {
  const value = tarString(block, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) fail('Bot shared file archive is invalid');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('Bot shared file archive is invalid');
  return parsed;
};

export const createBotSharedFileVerifier = ({ expectedFilename, expectedSize, expectedSha256 } = {}) => {
  if (typeof expectedFilename !== 'string' || !expectedFilename
    || !Number.isSafeInteger(expectedSize) || expectedSize < 1
    || typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    fail('Bot shared file verification request is invalid');
  }
  const chunks = [];
  let received = 0;
  return Object.freeze({
    push(chunk) {
      received += chunk.byteLength;
      if (received > MAX_ARCHIVE_BYTES) fail('Bot shared file archive is too large');
      chunks.push(Buffer.from(chunk));
    },
    result() {
      const archive = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      try {
        let offset = 0;
        let regularFiles = 0;
        let verified = null;
        while (offset + TAR_BLOCK_BYTES <= archive.byteLength) {
          const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
          if (header.every((byte) => byte === 0)) break;
          const name = tarString(header, 0, 100);
          const prefix = tarString(header, 345, 155);
          const path = prefix ? `${prefix}/${name}` : name;
          const size = tarOctal(header, 124, 12);
          const type = header[156];
          const contentStart = offset + TAR_BLOCK_BYTES;
          const contentEnd = contentStart + size;
          if (contentEnd > archive.byteLength) fail('Bot shared file archive is truncated');
          if (type === 0 || type === 0x30) {
            regularFiles += 1;
            const content = archive.subarray(contentStart, contentEnd);
            verified = {
              path,
              size,
              sha256: crypto.createHash('sha256').update(content).digest('hex'),
            };
          } else if (type !== 0x35) {
            fail('Bot shared file archive contains an unsafe entry');
          }
          offset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
        }
        if (regularFiles !== 1 || !verified
          || verified.path.split('/').at(-1) !== expectedFilename
          || verified.size !== expectedSize || verified.sha256 !== expectedSha256) {
          fail('Bot shared file integrity verification failed');
        }
        return Object.freeze(verified);
      } finally {
        archive.fill(0);
      }
    },
  });
};
