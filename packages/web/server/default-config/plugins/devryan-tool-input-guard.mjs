import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// Process tracking: when a project opts in (server-written tracking.json), agent
// shell commands are prefixed with an exported session marker so the server can
// group their processes by session and stop matched dev servers on delete.
const SESSION_MARKER_ENV = 'DEVRYAN_SESSION_ID';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACKING_FILE_RELATIVE_PATH = ['processes', 'tracking.json'];
const TRACKING_REFRESH_MS = 5_000;

// Heavy validation slots: machine-wide lock directories so concurrent agent
// sessions do not all run tsc/vitest/playwright at once. The command text is
// never modified; the hook only delays the call until a slot frees up.
const HEAVY_CHECK_SLOT_COUNT = 2;
const HEAVY_CHECK_SLOT_STALE_MS = 15 * 60_000;
const HEAVY_CHECK_MAX_WAIT_MS = 10 * 60_000;
const HEAVY_CHECK_POLL_MS = 500;
const HEAVY_CHECK_LOCK_RELATIVE_PATH = ['locks', 'heavy-checks'];
const HEAVY_CHECK_OWNER_FILE = 'owner.json';
// Heavy binaries only count in command position (start of the line, after a
// `;`/`&&`/`|`/`(` separator, or as a path such as node_modules/.bin/tsc), so
// `grep -rn tsc src` or `echo "tsc"` never wait for a slot.
const COMMAND_START = String.raw`(?:^|[;&|(]\s*|\S*/)`;
const RUNNER_PREFIX = String.raw`(?:npx\s+(?:-y\s+)?|bunx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+(?:exec\s+)?)?`;
const HEAVY_CHECK_PATTERNS = [
  new RegExp(String.raw`${COMMAND_START}${RUNNER_PREFIX}tsc(?:\s|$)`),
  new RegExp(String.raw`${COMMAND_START}${RUNNER_PREFIX}vitest(?:\s|$)`),
  new RegExp(String.raw`${COMMAND_START}${RUNNER_PREFIX}jest(?:\s|$)`),
  // eslint only counts when it is pointed at something (a directory or file
  // argument after any flags); `eslint --version` / `--help` stay light.
  new RegExp(String.raw`${COMMAND_START}${RUNNER_PREFIX}eslint\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*(?!-)\S`),
  new RegExp(String.raw`${COMMAND_START}${RUNNER_PREFIX}playwright(?:\s|$)`),
  new RegExp(String.raw`${COMMAND_START}${RUNNER_PREFIX}next\s+build(?:\s|$)`),
  new RegExp(String.raw`${COMMAND_START}${RUNNER_PREFIX}vite\s+build(?:\s|$)`),
  new RegExp(String.raw`${COMMAND_START}(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:-{1,2}[\w=./-]+\s+)*(?:build|test|lint|type-check)(?::[\w.-]+)?(?:\s|$)`),
];

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
  // Models routinely send `timeout: 30` / `120` meaning seconds. Any positive
  // integer below the millisecond floor can only sensibly mean seconds, so
  // convert it instead of rejecting the call.
  if (
    Number.isSafeInteger(args.timeout)
    && args.timeout >= 1
    && args.timeout < MIN_SHELL_TIMEOUT_MS
  ) {
    args.timeout = Math.min(args.timeout * 1000, MAX_SHELL_TIMEOUT_MS);
    return;
  }
  if (
    !Number.isSafeInteger(args.timeout)
    || args.timeout < MIN_SHELL_TIMEOUT_MS
    || args.timeout > MAX_SHELL_TIMEOUT_MS
  ) {
    throw inputError(
      `shell timeout must be an integer between ${MIN_SHELL_TIMEOUT_MS} and ${MAX_SHELL_TIMEOUT_MS} milliseconds; values under ${MIN_SHELL_TIMEOUT_MS} are read as seconds.`,
    );
  }
};

// ---------------------------------------------------------------------------
// Process tracking + heavy-check slots
// ---------------------------------------------------------------------------

const resolveDataDir = (env = process.env) => {
  for (const key of ['OPENCHAMBER_DATA_DIR', 'CONTEXT_MODE_DATA_DIR']) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (value) return path.resolve(value);
  }
  return path.join(os.homedir(), '.config', 'openchamber');
};

const normalizeDirectory = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value.trim());
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
};

const directoryCovers = (key, directory) => (
  key === directory || directory.startsWith(key.endsWith(path.sep) ? key : `${key}${path.sep}`)
);

const resolvePluginDirectory = (pluginInput) => {
  if (typeof pluginInput?.directory === 'string' && pluginInput.directory) return pluginInput.directory;
  if (typeof pluginInput?.worktree === 'string' && pluginInput.worktree) return pluginInput.worktree;
  return process.cwd();
};

// Path guard: absolute tool paths are validated before OpenCode's own
// `external_directory` permission check, so a degenerate path (a model
// repetition loop) or a path under a directory that does not exist fails the
// call with DEVRYAN_TOOL_INPUT_INVALID instead of asking the user to approve a
// directory that is not there. Relative paths, non-strings, anything inside the
// project (OpenCode reports missing files itself) and existing external
// directories are left alone, so OpenCode's prompt still fires for real paths.
const READ_PATH_ARGS = ['path', 'filePath', 'file_path', 'file'];
const WRITE_PATH_ARGS = ['filePath', 'path'];
const PATH_TOOL_ARGS = new Map([
  ['read', READ_PATH_ARGS],
  ['oc_read', READ_PATH_ARGS],
  ['edit', WRITE_PATH_ARGS],
  ['multiedit', WRITE_PATH_ARGS],
  ['patch', WRITE_PATH_ARGS],
  ['write', WRITE_PATH_ARGS],
  ['grep', ['path']],
  ['glob', ['path']],
  ['list', ['path']],
  ['bash', ['cwd', 'workdir']],
  ['shell', ['cwd', 'workdir']],
]);
// Tools that create their target: the parent directory must exist, the target need not.
const PARENT_EXISTS_TOOLS = new Set(['edit', 'multiedit', 'patch', 'write']);
const PATH_MAX_LENGTH = 512;
const PATH_MAX_SEGMENTS = 40;
const PATH_SEGMENT_MAX_BYTES = 255; // NAME_MAX on macOS and Linux
const PATH_MAX_SEGMENT_REPEATS = 4;
const PATH_EXISTENCE_MAX_STEPS = 64;
const PATH_GUARD_HINT = 'Use an existing absolute path inside the project or list the parent first.';
const PATH_SEGMENT_SEPARATOR = path.sep === '\\' ? /[\\/]/ : '/';

const describePathDegeneration = (value) => {
  if (value.length > PATH_MAX_LENGTH) {
    return `is ${value.length} characters long (limit ${PATH_MAX_LENGTH})`;
  }
  const segments = value.split(PATH_SEGMENT_SEPARATOR).filter(Boolean);
  if (segments.length > PATH_MAX_SEGMENTS) {
    return `has ${segments.length} path segments (limit ${PATH_MAX_SEGMENTS})`;
  }
  const counts = new Map();
  for (const segment of segments) {
    const bytes = Buffer.byteLength(segment, 'utf8');
    if (bytes > PATH_SEGMENT_MAX_BYTES) {
      return `contains a ${bytes}-byte segment (file names are limited to ${PATH_SEGMENT_MAX_BYTES} bytes)`;
    }
    const count = (counts.get(segment) ?? 0) + 1;
    counts.set(segment, count);
    if (count >= PATH_MAX_SEGMENT_REPEATS) {
      return `repeats the segment "${segment}" ${count} times`;
    }
  }
  const doubleSlash = value.indexOf('//');
  if (doubleSlash !== -1) {
    const prefix = value.slice(0, doubleSlash) || path.parse(value).root;
    if (!fs.existsSync(prefix)) return `contains "//" after the non-existent prefix ${prefix}`;
  }
  return null;
};

const findDeepestExistingAncestor = (start) => {
  let current = start;
  for (let step = 0; step < PATH_EXISTENCE_MAX_STEPS; step += 1) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return null;
};

const validateToolPathInput = (tool, args, { directory } = {}) => {
  const keys = PATH_TOOL_ARGS.get(tool);
  if (!keys || !isRecord(args)) return;
  const projectRoot = normalizeDirectory(directory);
  for (const key of keys) {
    const raw = args[key];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    // A path that exists on disk is never garbage, whatever its shape.
    const targetExists = fs.existsSync(resolved);
    const degeneration = targetExists ? null : describePathDegeneration(value);
    if (degeneration) {
      throw inputError(`${tool}.${key} ${degeneration}; this is not a real path. ${PATH_GUARD_HINT}`);
    }
    if (targetExists) continue;
    if (projectRoot && directoryCovers(projectRoot, resolved)) continue;
    const parent = path.dirname(resolved);
    const parentExists = fs.existsSync(parent);
    if (parentExists && PARENT_EXISTS_TOOLS.has(tool)) continue;
    const ancestor = (parentExists ? parent : findDeepestExistingAncestor(parent)) ?? path.parse(resolved).root;
    throw inputError(
      `${tool}.${key} points to a ${parentExists ? 'path' : 'directory'} that does not exist; deepest existing ancestor is ${ancestor}. ${PATH_GUARD_HINT}`,
    );
  }
};

const isHeavyCheckCommand = (command) => {
  if (typeof command !== 'string') return false;
  const text = command.replace(/\s+/g, ' ').trim();
  return Boolean(text) && HEAVY_CHECK_PATTERNS.some((pattern) => pattern.test(text));
};

const createTrackingReader = ({ dataDir, refreshMs = TRACKING_REFRESH_MS, now = Date.now } = {}) => {
  const filePath = path.join(dataDir, ...TRACKING_FILE_RELATIVE_PATH);
  let cachedAt = -Infinity;
  let cachedProjects = {};

  const read = () => {
    const timestamp = now();
    if (timestamp - cachedAt < refreshMs) return cachedProjects;
    cachedAt = timestamp;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      cachedProjects = isRecord(parsed?.projects) ? parsed.projects : {};
    } catch {
      cachedProjects = {};
    }
    return cachedProjects;
  };

  const lookup = (directory) => {
    const normalized = normalizeDirectory(directory);
    const defaults = { trackAgentProcesses: false, heavyCheckSlots: HEAVY_CHECK_SLOT_COUNT };
    if (!normalized) return defaults;
    const projects = read();
    let bestKey = null;
    for (const key of Object.keys(projects)) {
      if (!directoryCovers(key, normalized)) continue;
      if (!bestKey || key.length > bestKey.length) bestKey = key;
    }
    const entry = bestKey ? projects[bestKey] : null;
    if (!isRecord(entry)) return defaults;
    return {
      trackAgentProcesses: entry.trackAgentProcesses === true,
      heavyCheckSlots: entry.heavyCheckSlots === 0 ? 0 : HEAVY_CHECK_SLOT_COUNT,
    };
  };

  return { lookup, filePath };
};

const isProcessAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const slotManagers = new Set();
let exitHookInstalled = false;
const installExitHook = () => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const manager of slotManagers) manager.releaseAll();
  });
};

const createHeavyCheckSlots = ({
  dataDir,
  slotCount = HEAVY_CHECK_SLOT_COUNT,
  staleMs = HEAVY_CHECK_SLOT_STALE_MS,
  maxWaitMs = HEAVY_CHECK_MAX_WAIT_MS,
  pollMs = HEAVY_CHECK_POLL_MS,
  now = Date.now,
  isAlive = isProcessAlive,
  ownerPid = process.pid,
} = {}) => {
  const root = path.join(dataDir, ...HEAVY_CHECK_LOCK_RELATIVE_PATH);
  const held = new Map();

  const readOwner = (slotDir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(slotDir, HEAVY_CHECK_OWNER_FILE), 'utf8'));
    } catch {
      return null;
    }
  };

  const isStale = (slotDir) => {
    const owner = readOwner(slotDir);
    if (!isRecord(owner)) {
      // No readable owner: treat as stale once past the stale window (the
      // directory may be mid-creation by another process right now).
      try {
        return now() - fs.statSync(slotDir).mtimeMs > Math.min(staleMs, 5_000);
      } catch {
        return true;
      }
    }
    if (!Number.isFinite(owner.since) || now() - owner.since > staleMs) return true;
    return !isAlive(owner.pid);
  };

  const tryClaim = (slotDir, callID) => {
    try {
      fs.mkdirSync(slotDir);
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      if (!isStale(slotDir)) return false;
      try {
        fs.rmSync(slotDir, { recursive: true, force: true });
        fs.mkdirSync(slotDir);
      } catch {
        return false;
      }
    }
    try {
      fs.writeFileSync(
        path.join(slotDir, HEAVY_CHECK_OWNER_FILE),
        JSON.stringify({ pid: ownerPid, since: now(), callID: callID ?? null }),
        { mode: 0o600 },
      );
    } catch {
      fs.rmSync(slotDir, { recursive: true, force: true });
      return false;
    }
    return true;
  };

  const tryAcquire = (callID) => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (let index = 1; index <= slotCount; index += 1) {
      const slotDir = path.join(root, `slot-${index}`);
      if (tryClaim(slotDir, callID)) {
        held.set(callID, slotDir);
        return slotDir;
      }
    }
    return null;
  };

  // Bounded wait: never block a validation run forever because of a stuck
  // sibling; after maxWaitMs the command proceeds without a slot.
  const acquire = async (callID) => {
    const startedAt = now();
    if (held.has(callID)) return { slot: held.get(callID), waitedMs: 0 };
    let slot = tryAcquire(callID);
    let polled = false;
    while (!slot && now() - startedAt < maxWaitMs) {
      polled = true;
      await sleep(pollMs);
      slot = tryAcquire(callID);
    }
    // Only a real wait is reported; an instant claim (or stale reclaim) is 0.
    return { slot, waitedMs: polled ? Math.max(0, now() - startedAt) : 0 };
  };

  const release = (callID) => {
    const slotDir = held.get(callID);
    if (!slotDir) return false;
    held.delete(callID);
    fs.rmSync(slotDir, { recursive: true, force: true });
    return true;
  };

  const releaseAll = () => {
    for (const callID of [...held.keys()]) release(callID);
  };

  const manager = { root, acquire, release, releaseAll, heldSlots: () => [...held.values()] };
  slotManagers.add(manager);
  installExitHook();
  return manager;
};

const prefixSessionMarker = (command, sessionID) => {
  if (typeof command !== 'string' || !command.trim()) return command;
  if (typeof sessionID !== 'string' || !SESSION_ID_PATTERN.test(sessionID)) return command;
  const prefix = `export ${SESSION_MARKER_ENV}=${sessionID}; `;
  if (command.startsWith(prefix)) return command;
  return `${prefix}${command}`;
};

const createShellPolicies = (pluginInput = {}, testOptions = {}) => {
  const dataDir = typeof testOptions.dataDir === 'string' && testOptions.dataDir
    ? path.resolve(testOptions.dataDir)
    : resolveDataDir(testOptions.env);
  const directory = resolvePluginDirectory(pluginInput);
  const tracking = createTrackingReader({
    dataDir,
    refreshMs: testOptions.trackingRefreshMs,
    now: testOptions.now,
  });
  const slots = createHeavyCheckSlots({
    dataDir,
    slotCount: testOptions.slotCount,
    staleMs: testOptions.slotStaleMs,
    maxWaitMs: testOptions.slotMaxWaitMs,
    pollMs: testOptions.slotPollMs,
    now: testOptions.now,
    isAlive: testOptions.isProcessAlive,
    ownerPid: testOptions.ownerPid,
  });
  const waits = new Map();

  const before = async (input, args) => {
    if (!isRecord(args) || typeof args.command !== 'string') return;
    const settings = tracking.lookup(directory);
    if (settings.trackAgentProcesses) {
      args.command = prefixSessionMarker(args.command, input?.sessionID);
    }
    if (settings.heavyCheckSlots !== 0 && isHeavyCheckCommand(args.command)) {
      const callID = typeof input?.callID === 'string' && input.callID ? input.callID : `anonymous-${Date.now()}`;
      const { waitedMs } = await slots.acquire(callID);
      if (waitedMs > 0) waits.set(callID, waitedMs);
    }
  };

  const after = (input, output) => {
    const callID = input?.callID;
    if (typeof callID !== 'string' || !callID) return;
    slots.release(callID);
    const waitedMs = waits.get(callID);
    if (waitedMs === undefined) return;
    waits.delete(callID);
    if (!isRecord(output)) return;
    output.metadata = { ...(isRecord(output.metadata) ? output.metadata : {}), waitedForSlotMs: waitedMs };
  };

  return { before, after, slots, tracking, directory, dataDir };
};

export const DevRyanToolInputGuardPlugin = async (pluginInput = {}, testOptions = {}) => {
  const directory = resolvePluginDirectory(pluginInput);
  const shellPolicies = createShellPolicies(pluginInput, testOptions);

  return {
    'tool.execute.before': async (input, output) => {
      validateToolPathInput(input?.tool, output?.args, { directory });
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
        await shellPolicies.before(input, output?.args);
      }
    },
    'tool.execute.after': async (input, output) => {
      if (SHELL_TOOLS.has(input?.tool)) {
        shellPolicies.after(input, output);
        return;
      }
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
  };
};

// Callable so the plugin loader accepts it; constants ride along as properties.
export const __test = Object.assign(() => ({}), {
  getPathExtension,
  isKnownBinaryReadPath,
  looksLikeBinaryReadOutput,
  renderBlockedBinaryRead,
  validateToolPathInput,
  resolvePluginDirectory,
  isHeavyCheckCommand,
  prefixSessionMarker,
  createHeavyCheckSlots,
  createTrackingReader,
  resolveDataDir,
  DEFAULT_SHELL_TIMEOUT_MS,
  MIN_SHELL_TIMEOUT_MS,
  MAX_SHELL_TIMEOUT_MS,
  SESSION_MARKER_ENV,
  HEAVY_CHECK_SLOT_COUNT,
  HEAVY_CHECK_SLOT_STALE_MS,
  HEAVY_CHECK_MAX_WAIT_MS,
});

export default DevRyanToolInputGuardPlugin;
