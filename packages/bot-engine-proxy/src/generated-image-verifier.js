import crypto from 'node:crypto';

export const BOT_GENERATED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const BOT_GENERATED_IMAGE_OWNER_ID = 10001;
const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = BOT_GENERATED_IMAGE_MAX_BYTES + (4 * TAR_BLOCK_BYTES);

export class BotGeneratedImageVerificationError extends Error {
  constructor(message, code = 'bot_image_publication_failed') {
    super(message);
    this.name = 'BotGeneratedImageVerificationError';
    this.code = code;
    this.statusCode = 502;
  }
}

const fail = (message) => {
  throw new BotGeneratedImageVerificationError(message);
};

const tarString = (block, offset, length) => (
  block.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '')
);

const tarOctal = (block, offset, length) => {
  const value = tarString(block, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) fail('Generated image archive is invalid');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('Generated image archive is invalid');
  return parsed;
};

export const detectGeneratedImageType = (bytes) => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  fail('Generated image type is unsupported');
};

export const createBotGeneratedImageVerifier = ({ expectedFilename } = {}) => {
  if (typeof expectedFilename !== 'string' || !expectedFilename || expectedFilename.includes('/')) {
    fail('Generated image verification request is invalid');
  }
  const chunks = [];
  let received = 0;
  return Object.freeze({
    push(chunk) {
      received += chunk.byteLength;
      if (received > MAX_ARCHIVE_BYTES) fail('Generated image is too large');
      chunks.push(Buffer.from(chunk));
    },
    result() {
      const archive = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      try {
        let offset = 0;
        let image = null;
        while (offset + TAR_BLOCK_BYTES <= archive.byteLength) {
          const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
          if (header.every((byte) => byte === 0)) break;
          const name = tarString(header, 0, 100);
          const prefix = tarString(header, 345, 155);
          const archivePath = prefix ? `${prefix}/${name}` : name;
          const size = tarOctal(header, 124, 12);
          const uid = tarOctal(header, 108, 8);
          const gid = tarOctal(header, 116, 8);
          const type = header[156];
          const contentStart = offset + TAR_BLOCK_BYTES;
          const contentEnd = contentStart + size;
          if (contentEnd > archive.byteLength || size > BOT_GENERATED_IMAGE_MAX_BYTES) {
            fail('Generated image archive is truncated or too large');
          }
          if (type === 0 || type === 0x30) {
            if (image) fail('Generated image archive contains multiple files');
            if (uid !== BOT_GENERATED_IMAGE_OWNER_ID || gid !== BOT_GENERATED_IMAGE_OWNER_ID) {
              fail('Generated image is not owned by the reasoning runtime');
            }
            const bytes = Buffer.from(archive.subarray(contentStart, contentEnd));
            image = {
              archivePath,
              bytes,
              size,
              contentType: detectGeneratedImageType(bytes),
              sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            };
          } else {
            fail('Generated image archive contains an unsafe entry');
          }
          offset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
        }
        if (!image || image.archivePath.split('/').at(-1) !== expectedFilename || image.size < 1) {
          image?.bytes.fill(0);
          fail('Generated image archive did not contain the requested file');
        }
        return Object.freeze(image);
      } finally {
        archive.fill(0);
      }
    },
  });
};
