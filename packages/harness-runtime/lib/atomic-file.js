import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;
const DEFAULT_STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000;

const isNotFound = (error) => error && typeof error === 'object' && error.code === 'ENOENT';

const syncDirectory = async (fsApi, directory) => {
  let handle;
  try {
    handle = await fsApi.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const cleanupStaleAtomicFiles = async (filePath, options = {}) => {
  const fsApi = options.fs ?? fs;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_TMP_AGE_MS;
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.tmp-`;
  let entries;
  try {
    entries = await fsApi.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const candidate = path.join(directory, entry.name);
    try {
      const stat = await fsApi.stat(candidate);
      if (now() - stat.mtimeMs < staleAfterMs) continue;
      await fsApi.rm(candidate, { force: true });
      removed += 1;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return removed;
};

export const writeFileAtomic = async (filePath, data, options = {}) => {
  const fsApi = options.fs ?? fs;
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll('-', ''));
  const mode = options.mode ?? 0o600;
  const directoryMode = options.directoryMode ?? 0o700;
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${now()}-${randomId()}`;
  let handle;

  await fsApi.mkdir(directory, { recursive: true, mode: directoryMode });
  await cleanupStaleAtomicFiles(filePath, {
    fs: fsApi,
    now,
    staleAfterMs: options.staleTmpAgeMs,
  });

  try {
    handle = await fsApi.open(temporaryPath, 'wx', mode);
    await handle.writeFile(data, options.encoding ?? (typeof data === 'string' ? 'utf8' : undefined));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsApi.rename(temporaryPath, filePath);
    await fsApi.chmod(filePath, mode).catch(() => undefined);
    await syncDirectory(fsApi, directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsApi.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const quarantineInvalidFile = async (filePath, error, options) => {
  const fsApi = options.fs ?? fs;
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll('-', ''));
  const quarantineDir = options.quarantineDir ?? path.join(path.dirname(filePath), 'quarantine');
  const baseName = path.basename(filePath).replace(/\.json$/i, '');
  const destination = path.join(quarantineDir, `${baseName}.${now()}.${randomId()}.corrupt`);
  await fsApi.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
  await fsApi.rename(filePath, destination);
  await syncDirectory(fsApi, quarantineDir);
  options.onQuarantine?.({
    filePath,
    quarantinedPath: destination,
    error,
  });
  return destination;
};

export const readJsonGuarded = async (filePath, options = {}) => {
  const fsApi = options.fs ?? fs;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  try {
    const stat = await fsApi.stat(filePath);
    if (!stat.isFile()) {
      throw new TypeError('JSON record is not a regular file');
    }
    if (stat.size > maxBytes) {
      throw new RangeError(`JSON record exceeds ${maxBytes} bytes`);
    }
    const parsed = JSON.parse(await fsApi.readFile(filePath, 'utf8'));
    return typeof options.validate === 'function' ? options.validate(parsed) : parsed;
  } catch (error) {
    if (isNotFound(error)) return null;
    await quarantineInvalidFile(filePath, error, options).catch((quarantineError) => {
      if (!isNotFound(quarantineError)) throw quarantineError;
    });
    return null;
  }
};

export {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_STALE_TMP_AGE_MS,
};
