const CONTEXT_EXECUTE_TOOLS = new Set([
  'ctx_execute',
  'mcp__context_mode__ctx_execute',
]);

const READ_TOOLS = new Set(['read', 'oc_read']);
const SHELL_TOOLS = new Set(['bash', 'shell']);

const BINARY_READ_EXTENSIONS = new Set([
  '.7z', '.a', '.aac', '.aiff', '.apk', '.avif', '.avi', '.bin', '.bmp', '.bz2',
  '.class', '.dmg', '.doc', '.docx', '.eot', '.exe', '.flac', '.gif', '.gz', '.heic',
  '.heif', '.ico', '.jar', '.jpeg', '.jpg', '.m4a', '.m4v', '.mkv', '.mov', '.mp3',
  '.mp4', '.mpeg', '.mpg', '.o', '.ogg', '.otf', '.pdf', '.png', '.ppt', '.pptx',
  '.rar', '.so', '.tar', '.tif', '.tiff', '.ttf', '.wav', '.webm', '.webp', '.woff',
  '.woff2', '.xls', '.xlsx', '.xz', '.zip',
]);

const BINARY_SAMPLE_LENGTH = 4_096;
const BINARY_READ_BLOCKED_CODE = 'DEVRYAN_BINARY_READ_BLOCKED';

// NOTE: OpenCode's plugin loader iterates *every* named export and rejects the
// whole module if any of them is not a function (or an object exposing a
// `.server` function). Constants are therefore re-exposed on the callable
// `__test` export instead of being exported directly.
const DEFAULT_SHELL_TIMEOUT_MS = 240_000;
const MIN_SHELL_TIMEOUT_MS = 1_000;
const MAX_SHELL_TIMEOUT_MS = 3_600_000;

const JAVASCRIPT_LANGUAGES = new Set(['javascript', 'js']);
const ABSOLUTE_PATH_START_PATTERN = /(?:^|\s)["']?(?:\/(?!\/)|[a-z]:[\\/]|\\\\)/gi;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const inputError = (message) => {
  const error = new Error(`DEVRYAN_TOOL_INPUT_INVALID: Invalid input: ${message}`);
  error.code = 'DEVRYAN_TOOL_INPUT_INVALID';
  return error;
};

const getReadPath = (args) => {
  if (!isRecord(args)) return '';
  for (const candidate of [args.path, args.filePath, args.file_path, args.file]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
};

const getPathExtension = (value) => {
  const normalized = typeof value === 'string'
    ? value.trim().replaceAll('\\', '/').toLowerCase()
    : '';
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex > 0 ? basename.slice(dotIndex) : '';
};

const isKnownBinaryReadPath = (value) => BINARY_READ_EXTENSIONS.has(getPathExtension(value));

const hasBinaryMagic = (value) => (
  value.startsWith('\uFFFDPNG\r\n\u001a\n')
  || value.startsWith('\u0089PNG\r\n\u001a\n')
  || value.startsWith('GIF87a')
  || value.startsWith('GIF89a')
  || value.startsWith('%PDF-')
  || value.startsWith('PK\u0003\u0004')
  || value.startsWith('PK\u0005\u0006')
  || value.startsWith('PK\u0007\u0008')
  || (value.startsWith('RIFF') && value.slice(8, 12) === 'WEBP')
);

const looksLikeBinaryReadOutput = (value) => {
  if (typeof value !== 'string' || !value) return false;
  const sample = value.slice(0, BINARY_SAMPLE_LENGTH);
  if (hasBinaryMagic(sample) || sample.includes('\u0000')) return true;

  let invalidCharacters = 0;
  let controlCharacters = 0;
  for (const character of sample) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '\uFFFD') invalidCharacters += 1;
    if (
      (codePoint >= 0 && codePoint <= 8)
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 26)
      || (codePoint >= 28 && codePoint <= 31)
      || codePoint === 127
    ) {
      controlCharacters += 1;
    }
  }

  return (
    (invalidCharacters >= 3 && invalidCharacters / sample.length >= 0.01)
    || (controlCharacters >= 8 && controlCharacters / sample.length >= 0.05)
  );
};

const renderBlockedBinaryRead = (readPath = '') => {
  const extension = getPathExtension(readPath);
  const fileHint = extension ? ` (${extension})` : '';
  return `${BINARY_READ_BLOCKED_CODE}: Native read returned binary data${fileHint}. Raw bytes were removed before entering model context. Use an appropriate image, document, archive, media, or metadata inspection tool; do not retry the raw read.`;
};

const shouldBlockReadResult = (output) => looksLikeBinaryReadOutput(output);

const sanitizeReadToolPart = (part) => {
  if (!isRecord(part) || part.type !== 'tool' || !READ_TOOLS.has(part.tool)) return;
  if (!isRecord(part.state) || typeof part.state.output !== 'string') return;
  const readPath = getReadPath(part.state.input);
  if (!shouldBlockReadResult(part.state.output)) return;
  part.state = {
    ...part.state,
    output: renderBlockedBinaryRead(readPath),
  };
};

const hasMultipleAbsoluteTargets = (value) => {
  if (typeof value !== 'string') return false;
  const matches = value.match(ABSOLUTE_PATH_START_PATTERN);
  return Array.isArray(matches) && matches.length > 1;
};

const validateGrepInput = (args) => {
  if (!isRecord(args) || !hasMultipleAbsoluteTargets(args.path)) return;
  throw inputError(
    'grep.path accepts exactly one path. Use one grep call per target or pass their common parent directory.',
  );
};

const validateReadInput = (args) => {
  const readPath = getReadPath(args);
  if (!readPath) throw inputError('read.path must be a non-empty string.');
  if (!isKnownBinaryReadPath(readPath)) return;
  throw inputError(
    `read cannot load binary files${getPathExtension(readPath) ? ` with extension ${getPathExtension(readPath)}` : ''} as text. Use an appropriate image, document, archive, media, or metadata inspection tool; do not retry the raw read.`,
  );
};

const validateContextExecuteInput = (args) => {
  if (!isRecord(args)) return;
  const language = typeof args.language === 'string' ? args.language.trim().toLowerCase() : '';
  const code = typeof args.code === 'string' ? args.code : '';
  if (!JAVASCRIPT_LANGUAGES.has(language) || !code.trim()) return;

  try {
    // Compile as an async function body so top-level await and return remain valid.
    // The function is never invoked; this hook performs syntax validation only.
    new AsyncFunction(code);
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` (${error.message})` : '';
    throw inputError(`ctx_execute JavaScript must parse before execution${reason}. Correct the syntax and retry once.`);
  }
};

const enforceShellTimeout = (args) => {
  if (!isRecord(args)) return;
  if (args.timeout === undefined) {
    args.timeout = DEFAULT_SHELL_TIMEOUT_MS;
    return;
  }
  if (
    !Number.isSafeInteger(args.timeout)
    || args.timeout < MIN_SHELL_TIMEOUT_MS
    || args.timeout > MAX_SHELL_TIMEOUT_MS
  ) {
    throw inputError(
      `shell timeout must be an integer between ${MIN_SHELL_TIMEOUT_MS} and ${MAX_SHELL_TIMEOUT_MS} milliseconds.`,
    );
  }
};

export const DevRyanToolInputGuardPlugin = async () => ({
  'tool.execute.before': async (input, output) => {
    if (READ_TOOLS.has(input?.tool)) {
      validateReadInput(output?.args);
      return;
    }
    if (input?.tool === 'grep') {
      validateGrepInput(output?.args);
      return;
    }
    if (CONTEXT_EXECUTE_TOOLS.has(input?.tool)) {
      validateContextExecuteInput(output?.args);
      return;
    }
    if (SHELL_TOOLS.has(input?.tool)) {
      enforceShellTimeout(output?.args);
    }
  },
  'tool.execute.after': async (input, output) => {
    if (!READ_TOOLS.has(input?.tool) || !isRecord(output) || typeof output.output !== 'string') return;
    const readPath = getReadPath(input?.args);
    if (!shouldBlockReadResult(output.output)) return;
    output.output = renderBlockedBinaryRead(readPath);
  },
  'experimental.chat.messages.transform': async (_input, output) => {
    if (!Array.isArray(output?.messages)) return;
    for (const message of output.messages) {
      if (!Array.isArray(message?.parts)) continue;
      for (const part of message.parts) sanitizeReadToolPart(part);
    }
  },
});

// Callable so the plugin loader accepts it; constants ride along as properties.
export const __test = Object.assign(() => ({}), {
  getPathExtension,
  isKnownBinaryReadPath,
  looksLikeBinaryReadOutput,
  renderBlockedBinaryRead,
  DEFAULT_SHELL_TIMEOUT_MS,
  MIN_SHELL_TIMEOUT_MS,
  MAX_SHELL_TIMEOUT_MS,
});

export default DevRyanToolInputGuardPlugin;
