const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;

const ALLOWLISTED_COMMANDS = new Set([
  'git rev-parse --absolute-git-dir',
  'git rev-parse --git-common-dir',
  'git rev-parse --absolute-git-dir --git-common-dir',
]);

export const normalizeDeterministicGitReadCommand = (command) => {
  if (typeof command !== 'string') return null;
  const normalized = command.trim().replace(/\s+/g, ' ');
  return ALLOWLISTED_COMMANDS.has(normalized) ? normalized : null;
};

const parseTtlMs = (env) => {
  const raw = Number(env?.DEVRYAN_GIT_READ_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_TTL_MS;
};

const resultByteSize = (result) => {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const error = typeof result?.error === 'string' ? result.error : '';
  return Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(error);
};

const cloneResult = (result, command) => ({
  ...result,
  command,
});

export const createDeterministicGitReadCache = (options = {}) => {
  const {
    env = process.env,
    path,
    now = () => Date.now(),
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  } = options;

  const cache = new Map();
  const inflight = new Map();
  let totalBytes = 0;

  const ttlMs = parseTtlMs(env);
  const enabled = ttlMs > 0;

  const resolveCwd = (cwd) => {
    const value = typeof cwd === 'string' ? cwd : '';
    return path?.resolve ? path.resolve(value) : value;
  };

  const keyFor = (cwd, command) => `${resolveCwd(cwd)}\0${command}`;

  const deleteEntry = (key) => {
    const entry = cache.get(key);
    if (!entry) return;
    totalBytes -= entry.bytes;
    cache.delete(key);
  };

  const pruneExpired = () => {
    const timestamp = now();
    for (const [key, entry] of cache.entries()) {
      if (entry.expiresAt <= timestamp) {
        deleteEntry(key);
      }
    }
  };

  const evictOverflow = () => {
    while (cache.size > maxEntries || totalBytes > maxResultBytes) {
      const oldest = cache.keys().next().value;
      if (typeof oldest !== 'string') break;
      deleteEntry(oldest);
    }
  };

  const read = (key, command) => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      deleteEntry(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return cloneResult(entry.result, command);
  };

  const write = (key, command, result) => {
    if (!result?.success) return;
    const bytes = resultByteSize(result);
    if (bytes > maxResultBytes) return;

    deleteEntry(key);
    cache.set(key, {
      result: cloneResult(result, command),
      bytes,
      expiresAt: now() + ttlMs,
    });
    totalBytes += bytes;
    pruneExpired();
    evictOverflow();
  };

  const run = async ({ command, resolvedCwd, execute }) => {
    const normalizedCommand = normalizeDeterministicGitReadCommand(command);
    if (!enabled || !normalizedCommand || typeof execute !== 'function') {
      return execute();
    }

    const key = keyFor(resolvedCwd, normalizedCommand);
    const cached = read(key, normalizedCommand);
    if (cached) return cached;

    const pending = inflight.get(key);
    if (pending) {
      return cloneResult(await pending, normalizedCommand);
    }

    const promise = Promise.resolve()
      .then(execute)
      .then((result) => {
        write(key, normalizedCommand, result);
        return cloneResult(result, normalizedCommand);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, promise);
    return cloneResult(await promise, normalizedCommand);
  };

  return {
    run,
    clear: () => {
      cache.clear();
      inflight.clear();
      totalBytes = 0;
    },
  };
};
