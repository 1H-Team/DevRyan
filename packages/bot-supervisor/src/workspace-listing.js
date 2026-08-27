// Docker Engine has no directory-listing verb, so a workspace listing reads the
// container archive and keeps only the tar headers. Bodies are counted and
// discarded as they stream past, which is what keeps a large workspace from
// turning into a large response.

const TAR_BLOCK_BYTES = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const MODE_OFFSET = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const MTIME_OFFSET = 136;
const MTIME_LENGTH = 12;
const TYPE_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

export const BOT_WORKSPACE_LISTING_MAX_ENTRIES = 500;

// Read-only mounts the Bot never owns. They are always present and listing them
// would only be noise.
const HIDDEN_ROOT_ENTRIES = new Set(['.devryan', '.opencode']);

export const BOT_CONTAINER_RESTRICTED_PATHS = Object.freeze([
  '/data/chromium',
  '/data/opencode',
  '/runtime-config',
  '/workspace/.devryan',
  '/workspace/.opencode',
  '/proc',
  '/sys',
  '/dev',
  '/run/secrets',
]);

export class BotWorkspaceListingError extends Error {
  constructor(message, code = 'bot_supervisor_workspace_listing_invalid', statusCode = 502) {
    super(message);
    this.name = 'BotWorkspaceListingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotWorkspaceListingError(message, code, statusCode);
};

const readString = (block, offset, length) => {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
};

const readOctal = (block, offset, length) => {
  const text = readString(block, offset, length).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) fail('Docker returned an unreadable archive header');
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const isZeroBlock = (block) => {
  for (let index = 0; index < block.length; index += 1) {
    if (block[index] !== 0) return false;
  }
  return true;
};

// Docker roots the archive at the requested directory, so every path arrives
// prefixed with that directory's own name.
const stripArchiveRoot = (name) => {
  const normalized = name.replace(/\\/g, '/').replace(/\/+$/, '');
  const separator = normalized.indexOf('/');
  return separator === -1 ? '' : normalized.slice(separator + 1);
};

const entryType = (typeFlag) => {
  if (typeFlag === '5') return 'dir';
  if (typeFlag === '0' || typeFlag === '' || typeFlag === '\0') return 'file';
  if (typeFlag === '1' || typeFlag === '2') return 'link';
  return 'other';
};

/**
 * Consumes a tar stream and yields one entry per header.
 *
 * Entries are capped; once the cap is reached the stream is still drained so
 * the caller can report a truncated listing instead of a partial-looking one.
 */
export const createBotWorkspaceListingParser = ({
  maxEntries = BOT_WORKSPACE_LISTING_MAX_ENTRIES,
  maxDepth = 1,
  includeSpecialEntries = false,
  hiddenRootEntries = HIDDEN_ROOT_ENTRIES,
} = {}) => {
  let pending = Buffer.alloc(0);
  let remainingBody = 0;
  let finished = false;
  let truncated = false;
  const entries = [];

  const pushEntry = (block) => {
    const prefix = readString(block, PREFIX_OFFSET, PREFIX_LENGTH);
    const name = prefix
      ? `${prefix}/${readString(block, NAME_OFFSET, NAME_LENGTH)}`
      : readString(block, NAME_OFFSET, NAME_LENGTH);
    const size = readOctal(block, SIZE_OFFSET, SIZE_LENGTH);
    const relativePath = stripArchiveRoot(name);
    remainingBody = size;
    if (!relativePath) return;

    const segments = relativePath.split('/');
    if (hiddenRootEntries?.has(segments[0])) return;
    // A listing is one directory level at a time; deeper entries arrive in the
    // same archive and are simply skipped.
    if (segments.length > maxDepth) return;

    const type = entryType(String.fromCharCode(block[TYPE_OFFSET]).replace('\0', ''));
    // A symlink out of the workspace is never presented as a real file.
    if (!includeSpecialEntries && (type === 'link' || type === 'other')) return;

    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    const modifiedSeconds = readOctal(block, MTIME_OFFSET, MTIME_LENGTH);
    entries.push(Object.freeze({
      path: relativePath,
      name: segments[segments.length - 1],
      type,
      size: type === 'dir' ? 0 : size,
      mode: readOctal(block, MODE_OFFSET, 8) & 0o7777,
      modifiedAt: modifiedSeconds > 0
        ? new Date(modifiedSeconds * 1000).toISOString()
        : null,
    }));
  };

  return {
    push(chunk) {
      if (finished) return;
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      while (pending.length >= TAR_BLOCK_BYTES) {
        if (remainingBody > 0) {
          // Skip whole blocks of file content without keeping any of it.
          const bodyBlocks = Math.ceil(remainingBody / TAR_BLOCK_BYTES);
          const available = Math.floor(pending.length / TAR_BLOCK_BYTES);
          const consumed = Math.min(bodyBlocks, available);
          pending = pending.subarray(consumed * TAR_BLOCK_BYTES);
          remainingBody -= Math.min(remainingBody, consumed * TAR_BLOCK_BYTES);
          continue;
        }
        const block = pending.subarray(0, TAR_BLOCK_BYTES);
        pending = pending.subarray(TAR_BLOCK_BYTES);
        if (isZeroBlock(block)) {
          finished = true;
          return;
        }
        pushEntry(block);
      }
    },
    result() {
      return Object.freeze({
        entries: Object.freeze([...entries].sort((left, right) => {
          if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
          return left.name.localeCompare(right.name);
        })),
        truncated,
      });
    },
  };
};

/**
 * Resolves a caller-supplied subdirectory to an absolute container path.
 * Only plain relative segments are accepted; there is no way to name a parent,
 * an absolute path, or one of the read-only mounts.
 */
export const resolveBotWorkspacePath = (value) => {
  if (value === undefined || value === null || value === '') return '/workspace';
  // Absolute paths are rejected rather than reinterpreted, so a caller can
  // never believe it asked for one location and got another.
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024
    || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    fail('Bot workspace path is invalid', 'bot_supervisor_workspace_path_unsafe', 400);
  }
  const segments = value.split('/');
  if (segments.length > 32) {
    fail('Bot workspace path is too deep', 'bot_supervisor_workspace_path_unsafe', 400);
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..'
      || Buffer.byteLength(segment, 'utf8') > 255) {
      fail('Bot workspace path is invalid', 'bot_supervisor_workspace_path_unsafe', 400);
    }
  }
  if (HIDDEN_ROOT_ENTRIES.has(segments[0])) {
    fail('Bot workspace path is reserved', 'bot_supervisor_workspace_path_unsafe', 400);
  }
  return `/workspace/${segments.join('/')}`;
};

export const isBotContainerPathRestricted = (value) => (
  BOT_CONTAINER_RESTRICTED_PATHS.some((restricted) => (
    value === restricted || value.startsWith(`${restricted}/`)
  ))
);

/**
 * Resolves an administrator-supplied relative directory beneath the container
 * root. The caller never supplies an absolute path or changes the root.
 */
export const resolveBotContainerPath = (value) => {
  if (value === undefined || value === null || value === '') return '/';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024
    || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    fail('Bot container path is invalid', 'bot_supervisor_filesystem_path_unsafe', 400);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '')) {
    fail('Bot container path is invalid', 'bot_supervisor_filesystem_path_unsafe', 400);
  }
  if (segments.length > 32) {
    fail('Bot container path is too deep', 'bot_supervisor_filesystem_path_unsafe', 400);
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || Buffer.byteLength(segment, 'utf8') > 255) {
      fail('Bot container path is invalid', 'bot_supervisor_filesystem_path_unsafe', 400);
    }
  }
  const resolved = `/${segments.join('/')}`;
  if (isBotContainerPathRestricted(resolved)) {
    fail('Bot container path is restricted', 'bot_supervisor_filesystem_path_restricted', 403);
  }
  return resolved;
};

/**
 * Resolves a generated-image path beneath the reasoning workspace. Image tools
 * may legitimately choose names containing spaces or non-ASCII characters, so
 * this validator constrains path structure and encoded size instead of using a
 * filename character allow-list.
 */
export const resolveBotGeneratedImagePath = (value) => {
  if (typeof value !== 'string' || value === ''
    || Buffer.byteLength(value, 'utf8') > 1024
    || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    fail('Generated image path is invalid', 'bot_supervisor_workspace_path_unsafe', 400);
  }
  const segments = value.split('/');
  if (segments.length > 32 || segments.some((segment) => (
    segment === '' || segment === '.' || segment === '..'
    || Buffer.byteLength(segment, 'utf8') > 255
  ))) {
    fail('Generated image path is invalid', 'bot_supervisor_workspace_path_unsafe', 400);
  }
  if (HIDDEN_ROOT_ENTRIES.has(segments[0].toLowerCase())) {
    fail('Generated image path is reserved', 'bot_supervisor_workspace_path_unsafe', 400);
  }
  return `/workspace/${segments.join('/')}`;
};
