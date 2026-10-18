import crypto from 'node:crypto';

export const BOT_WORKSPACE_FILE_MAX_BYTES = 48 * 1024;
export const BOT_SHARED_FILE_MAX_BYTES = 25 * 1024 * 1024;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RESERVED_FILE_NAMES = new Set(['.devryan', '.opencode']);
const TAR_BLOCK_BYTES = 512;

export class BotWorkspaceArchiveError extends Error {
  constructor(message, code = 'bot_supervisor_workspace_write_invalid') {
    super(message);
    this.name = 'BotWorkspaceArchiveError';
    this.code = code;
    this.statusCode = 400;
  }
}

const fail = (message) => {
  throw new BotWorkspaceArchiveError(message);
};

export const normalizeBotWorkspaceFile = ({ path, content } = {}) => {
  if (typeof path !== 'string' || !FILE_NAME_PATTERN.test(path)
    || RESERVED_FILE_NAMES.has(path.toLowerCase())) {
    fail('Bot workspace file name is invalid');
  }
  if (typeof content !== 'string') fail('Bot workspace file content is invalid');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > BOT_WORKSPACE_FILE_MAX_BYTES) {
    bytes.fill(0);
    fail('Bot workspace file content is too large');
  }
  return Object.freeze({ path, content, bytes });
};

const writeString = (target, offset, length, value) => {
  const encoded = Buffer.from(value, 'ascii');
  if (encoded.byteLength > length) fail('Bot workspace archive field is too large');
  encoded.copy(target, offset);
};

const writeOctal = (target, offset, length, value) => {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, '0');
  if (encoded.length !== length - 1) fail('Bot workspace archive number is too large');
  writeString(target, offset, length, `${encoded}\0`);
};

const buildUstarHeader = ({
  name,
  prefix = '',
  mode,
  size = 0,
  type = 0x30,
}) => {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 10001);
  writeOctal(header, 116, 8, 10001);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type;
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'bot');
  writeString(header, 297, 32, 'bot');
  if (prefix) writeString(header, 345, 155, prefix);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
};

export const buildBotWorkspaceFileArchive = (input) => {
  const normalized = normalizeBotWorkspaceFile(input);
  const header = buildUstarHeader({
    name: normalized.path,
    mode: 0o600,
    size: normalized.bytes.byteLength,
  });

  const contentBlocks = Math.ceil(normalized.bytes.byteLength / TAR_BLOCK_BYTES);
  const archive = Buffer.alloc((1 + contentBlocks + 2) * TAR_BLOCK_BYTES);
  header.copy(archive, 0);
  normalized.bytes.copy(archive, TAR_BLOCK_BYTES);
  const result = Object.freeze({
    archive,
    path: normalized.path,
    bytes: normalized.bytes.byteLength,
    sha256: crypto.createHash('sha256').update(normalized.bytes).digest('hex'),
  });
  normalized.bytes.fill(0);
  return result;
};

const decodeSharedBytes = (contentBase64, expectedSize, expectedSha256) => {
  if (typeof contentBase64 !== 'string'
    || contentBase64.length > Math.ceil(BOT_SHARED_FILE_MAX_BYTES / 3) * 4
    || !CANONICAL_BASE64_PATTERN.test(contentBase64)
    || !Number.isSafeInteger(expectedSize) || expectedSize < 1
    || expectedSize > BOT_SHARED_FILE_MAX_BYTES
    || typeof expectedSha256 !== 'string' || !SHA256_PATTERN.test(expectedSha256)) {
    fail('Bot shared file content is invalid');
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  const canonical = bytes.toString('base64');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (canonical !== contentBase64 || bytes.byteLength !== expectedSize || sha256 !== expectedSha256) {
    bytes.fill(0);
    fail('Bot shared file integrity check failed');
  }
  return bytes;
};

export const buildBotSharedFileArchive = ({
  channelId,
  messageId,
  filename,
  contentBase64,
  expectedSize,
  sha256,
} = {}) => {
  if (!UUID_PATTERN.test(channelId || '') || !UUID_PATTERN.test(messageId || '')
    || typeof filename !== 'string' || !FILE_NAME_PATTERN.test(filename)
    || RESERVED_FILE_NAMES.has(filename.toLowerCase())) {
    fail('Bot shared file path is invalid');
  }
  const bytes = decodeSharedBytes(contentBase64, expectedSize, sha256);
  const prefix = `${channelId}/${messageId}`;
  const relativePath = `${prefix}/${filename}`;
  try {
    // Docker creates implicit archive parents as root-owned directories. Include
    // both fixed UUID parents explicitly so the non-root Bot user can perform
    // the same-directory atomic rename after the staged bytes are verified.
    const channelHeader = buildUstarHeader({
      name: `${channelId}/`,
      mode: 0o700,
      type: 0x35,
    });
    const messageHeader = buildUstarHeader({
      name: `${messageId}/`,
      prefix: channelId,
      mode: 0o700,
      type: 0x35,
    });
    const header = buildUstarHeader({
      name: filename,
      prefix,
      mode: 0o600,
      size: bytes.byteLength,
    });

    const contentBlocks = Math.ceil(bytes.byteLength / TAR_BLOCK_BYTES);
    const archive = Buffer.alloc((3 + contentBlocks + 2) * TAR_BLOCK_BYTES);
    channelHeader.copy(archive, 0);
    messageHeader.copy(archive, TAR_BLOCK_BYTES);
    header.copy(archive, 2 * TAR_BLOCK_BYTES);
    bytes.copy(archive, 3 * TAR_BLOCK_BYTES);
    return Object.freeze({
      archive,
      path: relativePath,
      filename,
      bytes: bytes.byteLength,
      sha256,
    });
  } finally {
    bytes.fill(0);
  }
};

export const buildBotResourceFileArchive = ({
  resourcePath,
  contentBase64,
  expectedSize,
  sha256,
} = {}) => {
  const segments = typeof resourcePath === 'string' ? resourcePath.split('/') : [];
  const filename = segments.at(-1) || '';
  const directories = segments.slice(0, -1);
  const prefix = ['Resources', ...directories].join('/');
  if (segments.length < 1 || segments.length > 32
    || Buffer.byteLength(resourcePath || '', 'utf8') > 180
    || Buffer.byteLength(prefix, 'utf8') > 155
    || segments.some((segment) => !FILE_NAME_PATTERN.test(segment)
      || RESERVED_FILE_NAMES.has(segment.toLowerCase()))) {
    fail('Bot resource file path is invalid');
  }
  const bytes = decodeSharedBytes(contentBase64, expectedSize, sha256);
  try {
    const directorySegments = ['Resources', ...directories];
    const headers = directorySegments.map((segment, index) => buildUstarHeader({
      name: `${segment}/`,
      prefix: directorySegments.slice(0, index).join('/'),
      mode: 0o700,
      type: 0x35,
    }));
    const fileHeader = buildUstarHeader({
      name: filename,
      prefix,
      mode: 0o600,
      size: bytes.byteLength,
    });
    const contentBlocks = Math.ceil(bytes.byteLength / TAR_BLOCK_BYTES);
    const archive = Buffer.alloc((headers.length + 1 + contentBlocks + 2) * TAR_BLOCK_BYTES);
    headers.forEach((header, index) => header.copy(archive, index * TAR_BLOCK_BYTES));
    fileHeader.copy(archive, headers.length * TAR_BLOCK_BYTES);
    bytes.copy(archive, (headers.length + 1) * TAR_BLOCK_BYTES);
    return Object.freeze({
      archive,
      path: `Resources/${resourcePath}`,
      filename,
      bytes: bytes.byteLength,
      sha256,
    });
  } finally {
    bytes.fill(0);
  }
};
