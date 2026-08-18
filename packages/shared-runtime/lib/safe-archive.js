import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';

const MIB = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const UNIX_DIRECTORY = 0x4000;

export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 16 * MIB,
  maxEntries: 2_048,
  maxTotalBytes: 64 * MIB,
  maxFileBytes: 16 * MIB,
  maxPathBytes: 512,
  maxDepth: 32,
});

export class ArchiveRejectionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ArchiveRejectionError';
    this.code = code;
  }
}

export function isArchiveRejectionError(error) {
  return error instanceof ArchiveRejectionError;
}

function reject(code, message, cause) {
  throw new ArchiveRejectionError(code, message, cause === undefined ? undefined : { cause });
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resolveLimits(overrides = {}) {
  return {
    maxArchiveBytes: positiveLimit(overrides.maxArchiveBytes, DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes),
    maxEntries: positiveLimit(overrides.maxEntries, DEFAULT_ARCHIVE_LIMITS.maxEntries),
    maxTotalBytes: positiveLimit(overrides.maxTotalBytes, DEFAULT_ARCHIVE_LIMITS.maxTotalBytes),
    maxFileBytes: positiveLimit(overrides.maxFileBytes, DEFAULT_ARCHIVE_LIMITS.maxFileBytes),
    maxPathBytes: positiveLimit(overrides.maxPathBytes, DEFAULT_ARCHIVE_LIMITS.maxPathBytes),
    maxDepth: positiveLimit(overrides.maxDepth, DEFAULT_ARCHIVE_LIMITS.maxDepth),
  };
}

function normalizeAllowedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function fail(message, cause) {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function parseHttpsUrl(value, code = 'ARCHIVE_UNSAFE_ENTRY') {
  let parsed;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (error) {
    reject(code, 'The skill archive URL is invalid.', error);
  }

  if (parsed.protocol !== 'https:') {
    reject(code, 'Skill archives must be downloaded over HTTPS.');
  }
  return parsed;
}

function combineSignals(controller, externalSignal) {
  if (!externalSignal) return controller.signal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([controller.signal, externalSignal]);
  }
  if (externalSignal.aborted) controller.abort(externalSignal.reason);
  else externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
  return controller.signal;
}

async function readBoundedBody(response, maxBytes, failureCode) {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject('ARCHIVE_DOWNLOAD_TOO_LARGE', `The skill archive exceeds the ${maxBytes}-byte download limit.`);
    }
  }

  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        try {
          await response.body.cancel();
        } catch {
          // The size rejection is authoritative even if cancellation fails.
        }
        reject('ARCHIVE_DOWNLOAD_TOO_LARGE', `The skill archive exceeds the ${maxBytes}-byte download limit.`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (isArchiveRejectionError(error)) throw error;
    if (failureCode) reject(failureCode, 'The skill archive response could not be read.', error);
    fail('The skill archive response could not be read.', error);
  }
  return Buffer.concat(chunks, total);
}

export async function downloadArchive(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('No fetch implementation is available for skill archive downloads.');
  }

  const initial = parseHttpsUrl(url);
  const allowedOrigins = new Set([initial.origin]);
  for (const candidate of options.allowedOrigins || []) {
    const origin = normalizeAllowedOrigin(candidate);
    if (origin) allowedOrigins.add(origin);
  }

  const timeoutMs = positiveLimit(options.timeoutMs, 60_000);
  const maxRedirects = Number.isSafeInteger(options.maxRedirects) && options.maxRedirects >= 0
    ? options.maxRedirects
    : 5;
  const maxArchiveBytes = positiveLimit(options.maxArchiveBytes, DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes);
  const controller = new AbortController();
  const signal = combineSignals(controller, options.signal);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('archive download timeout'));
  }, timeoutMs);
  timeout.unref?.();

  let current = initial;
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      let response;
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          headers: options.headers,
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (timedOut) reject('ARCHIVE_DOWNLOAD_TIMEOUT', 'The skill archive download timed out.', error);
        fail('The skill archive could not be downloaded.', error);
      }

      if (typeof response.url === 'string' && response.url) {
        const reportedUrl = parseHttpsUrl(response.url, 'ARCHIVE_UNSAFE_ENTRY');
        if (!allowedOrigins.has(reportedUrl.origin)) {
          reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive response came from an unapproved origin.');
        }
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects === maxRedirects) {
          reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive used too many redirects.');
        }
        const location = response.headers.get('location');
        if (!location) reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive redirect has no destination.');
        let redirectUrl;
        try {
          redirectUrl = new URL(location, current);
        } catch (error) {
          reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive redirect destination is invalid.', error);
        }
        const next = parseHttpsUrl(redirectUrl, 'ARCHIVE_UNSAFE_ENTRY');
        if (!allowedOrigins.has(next.origin)) {
          reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive redirected to an unapproved origin.');
        }
        current = next;
        continue;
      }

      if (!response.ok) {
        await readBoundedBody(response, 64 * 1024, null).catch(() => Buffer.alloc(0));
        fail(`The skill archive download failed with HTTP ${response.status}.`);
      }

      try {
        return await readBoundedBody(response, maxArchiveBytes, null);
      } catch (error) {
        if (timedOut && !isArchiveRejectionError(error)) {
          reject('ARCHIVE_DOWNLOAD_TIMEOUT', 'The skill archive download timed out.', error);
        }
        throw error;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive redirect could not be resolved.');
}

function normalizeEntryName(rawName, isDirectory, limits) {
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.includes('\0')) {
    reject('ARCHIVE_INVALID_PATH', 'The skill archive contains an empty or invalid path.');
  }
  if (Buffer.byteLength(rawName, 'utf8') > limits.maxPathBytes) {
    reject('ARCHIVE_INVALID_PATH', 'The skill archive contains a path that is too long.');
  }
  if (/^[a-zA-Z]:/.test(rawName) || rawName.startsWith('/') || rawName.startsWith('\\') || rawName.startsWith('//')) {
    reject('ARCHIVE_INVALID_PATH', 'The skill archive contains an absolute path.');
  }

  const slashName = rawName.replaceAll('\\', '/');
  const withoutTrailingSlash = isDirectory && slashName.endsWith('/') ? slashName.slice(0, -1) : slashName;
  const segments = withoutTrailingSlash.split('/');
  if (
    withoutTrailingSlash.length === 0
    || segments.length > limits.maxDepth
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    reject('ARCHIVE_INVALID_PATH', 'The skill archive contains an unsafe path.');
  }
  return segments.join('/');
}

function decodeEntryName(entry) {
  const rawName = entry?.rawEntryName;
  if (!(rawName instanceof Uint8Array) || rawName.byteLength === 0) {
    reject('ARCHIVE_INVALID_PATH', 'The skill archive contains an empty or invalid path.');
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawName);
  } catch (error) {
    reject('ARCHIVE_INVALID_PATH', 'The skill archive contains a malformed path.', error);
  }
  if (decoded !== entry.entryName) {
    reject('ARCHIVE_INVALID_PATH', 'The skill archive contains an inconsistently encoded path.');
  }
  return decoded;
}

function getUnixEntryType(entry) {
  const madeByPlatform = (Number(entry.header?.made) >>> 8) & 0xff;
  if (madeByPlatform !== 3) return 0;
  return (Number(entry.header?.attr) >>> 16) & UNIX_FILE_TYPE_MASK;
}

function validateEntryKind(entry) {
  if (entry.header?.encrypted === true || (Number(entry.header?.flags) & 0x1) !== 0) {
    reject('ARCHIVE_UNSAFE_ENTRY', 'Encrypted skill archives are not supported.');
  }

  const unixType = getUnixEntryType(entry);
  if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
    reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive contains a symbolic link or special file.');
  }
  if (unixType === UNIX_DIRECTORY && !entry.isDirectory) {
    reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive contains conflicting file metadata.');
  }
  if (unixType === UNIX_REGULAR_FILE && entry.isDirectory) {
    reject('ARCHIVE_UNSAFE_ENTRY', 'The skill archive contains conflicting directory metadata.');
  }
}

function validatePathGraph(entries) {
  const exact = new Map();
  const folded = new Map();

  for (const entry of entries) {
    if (exact.has(entry.name)) {
      reject('ARCHIVE_PATH_COLLISION', 'The skill archive contains a duplicate path.');
    }
    const caseKey = entry.name.toLocaleLowerCase('en-US');
    if (folded.has(caseKey)) {
      reject('ARCHIVE_PATH_COLLISION', 'The skill archive contains paths that differ only by letter case.');
    }
    exact.set(entry.name, entry.isDirectory);
    folded.set(caseKey, entry.name);
  }

  for (const entry of entries) {
    const segments = entry.name.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      if (exact.get(ancestor) === false) {
        reject('ARCHIVE_PATH_COLLISION', 'The skill archive uses a file as a directory.');
      }
    }
    if (entry.isDirectory) continue;
    const prefix = `${entry.name}/`;
    for (const other of entries) {
      if (other !== entry && other.name.startsWith(prefix)) {
        reject('ARCHIVE_PATH_COLLISION', 'The skill archive uses a file as a directory.');
      }
    }
  }
}

export function preflightSkillArchive(archiveBuffer, overrides = {}) {
  const limits = resolveLimits(overrides);
  const buffer = Buffer.isBuffer(archiveBuffer)
    ? archiveBuffer
    : archiveBuffer instanceof ArrayBuffer
      ? Buffer.from(archiveBuffer)
      : Buffer.from(archiveBuffer.buffer, archiveBuffer.byteOffset, archiveBuffer.byteLength);
  if (buffer.length > limits.maxArchiveBytes) {
    reject('ARCHIVE_DOWNLOAD_TOO_LARGE', 'The skill archive is larger than the accepted compressed size.');
  }

  let archive;
  let zipEntries;
  try {
    archive = new AdmZip(buffer);
    zipEntries = archive.getEntries();
  } catch (error) {
    reject('ARCHIVE_CORRUPT', 'The downloaded skill is not a valid ZIP archive.', error);
  }

  if (zipEntries.length === 0) reject('ARCHIVE_CORRUPT', 'The skill archive is empty.');
  if (zipEntries.length > limits.maxEntries) {
    reject('ARCHIVE_ENTRY_LIMIT', 'The skill archive contains too many entries.');
  }

  let totalDeclaredBytes = 0;
  const entries = zipEntries.map((entry) => {
    validateEntryKind(entry);
    const name = normalizeEntryName(decodeEntryName(entry), entry.isDirectory, limits);
    const declaredSize = Number(entry.header?.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      reject('ARCHIVE_CORRUPT', 'The skill archive contains an invalid entry size.');
    }
    if (!entry.isDirectory && declaredSize > limits.maxFileBytes) {
      reject('ARCHIVE_SIZE_LIMIT', 'A file in the skill archive exceeds the expanded size limit.');
    }
    totalDeclaredBytes += declaredSize;
    if (!Number.isSafeInteger(totalDeclaredBytes) || totalDeclaredBytes > limits.maxTotalBytes) {
      reject('ARCHIVE_SIZE_LIMIT', 'The skill archive exceeds the total expanded size limit.');
    }
    return { name, isDirectory: entry.isDirectory, declaredSize, zipEntry: entry };
  });

  validatePathGraph(entries);
  const manifest = entries.find((entry) => entry.name === 'SKILL.md' && !entry.isDirectory);
  if (!manifest) {
    reject('ARCHIVE_MISSING_SKILL_FILE', 'The skill archive must contain SKILL.md at its root.');
  }

  return { archive, entries, totalDeclaredBytes };
}

function makeFsOps(overrides = {}) {
  return {
    mkdir: overrides.mkdir || fs.promises.mkdir.bind(fs.promises),
    mkdtemp: overrides.mkdtemp || fs.promises.mkdtemp.bind(fs.promises),
    writeFile: overrides.writeFile || fs.promises.writeFile.bind(fs.promises),
    rename: overrides.rename || fs.promises.rename.bind(fs.promises),
    rm: overrides.rm || fs.promises.rm.bind(fs.promises),
    cp: overrides.cp || fs.promises.cp.bind(fs.promises),
    lstat: overrides.lstat || fs.promises.lstat.bind(fs.promises),
    readdir: overrides.readdir || fs.promises.readdir.bind(fs.promises),
  };
}

async function removeQuietly(fsOps, target) {
  if (!target) return;
  try {
    await fsOps.rm(target, { recursive: true, force: true });
  } catch {
    // Cleanup must not hide the authoritative install or rollback result.
  }
}

async function auditTree(root, limits, fsOps, requiredRootFile) {
  const pending = [{ absolute: root, relative: '', depth: 0 }];
  let entries = 0;
  let files = 0;
  let bytes = 0;
  let hasRequiredRootFile = false;

  while (pending.length > 0) {
    const current = pending.pop();
    const children = await fsOps.readdir(current.absolute, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > limits.maxEntries) reject('ARCHIVE_ENTRY_LIMIT', 'The extracted skill contains too many entries.');
      const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
      if (Buffer.byteLength(relative, 'utf8') > limits.maxPathBytes || current.depth + 1 > limits.maxDepth) {
        reject('ARCHIVE_INVALID_PATH', 'The extracted skill contains an unsafe path.');
      }
      const absolute = path.join(current.absolute, child.name);
      const stat = await fsOps.lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        reject('ARCHIVE_UNSAFE_ENTRY', 'The extracted skill contains a symbolic link or special file.');
      }
      if (stat.isDirectory()) {
        pending.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      files += 1;
      if (relative === requiredRootFile) hasRequiredRootFile = true;
      if (stat.size > limits.maxFileBytes) reject('ARCHIVE_SIZE_LIMIT', 'An extracted skill file exceeds the size limit.');
      bytes += stat.size;
      if (bytes > limits.maxTotalBytes) reject('ARCHIVE_SIZE_LIMIT', 'The extracted skill exceeds the total size limit.');
    }
  }

  if (!hasRequiredRootFile) {
    reject('ARCHIVE_MISSING_SKILL_FILE', `The skill archive must contain ${requiredRootFile} at its root.`);
  }
  return { files, bytes };
}

async function extractPlan(plan, stagingDir, limits, fsOps) {
  let actualBytes = 0;
  for (const entry of plan.entries) {
    const destination = path.resolve(stagingDir, ...entry.name.split('/'));
    const assertContained = () => {
      const relativeDestination = path.relative(stagingDir, destination);
      if (
        !relativeDestination
        || relativeDestination === '..'
        || relativeDestination.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeDestination)
      ) {
        reject('ARCHIVE_INVALID_PATH', 'The skill archive contains a path outside its staging directory.');
      }
    };
    assertContained();
    if (entry.isDirectory) {
      await fsOps.mkdir(destination, { recursive: true, mode: 0o755 });
      continue;
    }

    let data;
    try {
      data = entry.zipEntry.getData();
    } catch (error) {
      reject('ARCHIVE_CORRUPT', 'A skill archive entry could not be decompressed.', error);
    }
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);
    if (data.length > limits.maxFileBytes) {
      reject('ARCHIVE_SIZE_LIMIT', 'A file in the skill archive exceeds the actual expanded size limit.');
    }
    actualBytes += data.length;
    if (actualBytes > limits.maxTotalBytes) {
      reject('ARCHIVE_SIZE_LIMIT', 'The skill archive exceeds the actual expanded size limit.');
    }
    await fsOps.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    assertContained();
    try {
      await fsOps.writeFile(destination, data, { flag: 'wx', mode: 0o644 });
    } catch (error) {
      fail('A skill archive entry could not be written safely.', error);
    }
  }
  return actualBytes;
}

async function moveStagingIntoPlace(stagingDir, targetDir, parentDir, basename, fsOps) {
  try {
    await fsOps.rename(stagingDir, targetDir);
    return null;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }

  const copiedStaging = await fsOps.mkdtemp(path.join(parentDir, `.${basename}.copy-`));
  try {
    await fsOps.cp(stagingDir, copiedStaging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    });
    await fsOps.rename(copiedStaging, targetDir);
    return stagingDir;
  } catch (error) {
    await removeQuietly(fsOps, copiedStaging);
    throw error;
  }
}

export async function installSkillArchive({
  archiveBuffer,
  targetDir,
  replace = false,
  limits: limitOverrides = {},
  requiredRootFile = 'SKILL.md',
  fsOps: fsOverrides = {},
} = {}) {
  if (typeof targetDir !== 'string' || targetDir.length === 0 || path.basename(targetDir) === '.') {
    fail('A valid skill installation target is required.');
  }
  if (requiredRootFile !== 'SKILL.md') {
    fail('Only a root SKILL.md manifest is supported.');
  }

  const limits = resolveLimits(limitOverrides);
  const plan = preflightSkillArchive(archiveBuffer, limits);
  const fsOps = makeFsOps(fsOverrides);
  const resolvedTarget = path.resolve(targetDir);
  const parentDir = path.dirname(resolvedTarget);
  const basename = path.basename(resolvedTarget);
  await fsOps.mkdir(parentDir, { recursive: true, mode: 0o755 });

  let targetExists = false;
  try {
    await fsOps.lstat(resolvedTarget);
    targetExists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (targetExists && !replace) {
    fail('The skill is already installed and replacement was not approved.');
  }

  const nonce = randomBytes(6).toString('hex');
  let stagingDir = await fsOps.mkdtemp(path.join(parentDir, `.${basename}.staging-`));
  const backupDir = path.join(parentDir, `.${basename}.backup-${nonce}`);
  let backupCreated = false;
  let targetCommitted = false;
  try {
    await extractPlan(plan, stagingDir, limits, fsOps);
    const audit = await auditTree(stagingDir, limits, fsOps, requiredRootFile);

    if (targetExists) {
      await fsOps.rename(resolvedTarget, backupDir);
      backupCreated = true;
    }

    try {
      const sourceToClean = await moveStagingIntoPlace(stagingDir, resolvedTarget, parentDir, basename, fsOps);
      targetCommitted = true;
      stagingDir = sourceToClean;
      await auditTree(resolvedTarget, limits, fsOps, requiredRootFile);
    } catch (error) {
      await removeQuietly(fsOps, resolvedTarget);
      if (backupCreated) {
        try {
          await fsOps.rename(backupDir, resolvedTarget);
          backupCreated = false;
        } catch (restoreError) {
          fail('The skill update failed and the previous installation could not be restored.', restoreError);
        }
      }
      fail('The skill archive could not be committed.', error);
    }

    if (backupCreated) {
      await removeQuietly(fsOps, backupDir);
      backupCreated = false;
    }
    return { installedPath: resolvedTarget, files: audit.files, bytes: audit.bytes };
  } finally {
    await removeQuietly(fsOps, stagingDir);
    if (!targetCommitted && backupCreated) {
      try {
        await fsOps.rename(backupDir, resolvedTarget);
        backupCreated = false;
      } catch {
        // The commit path reports an explicit rollback failure when it owns it.
      }
    }
    if (!backupCreated) await removeQuietly(fsOps, backupDir);
  }
}
