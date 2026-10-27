import fs from 'node:fs/promises';
import { constants, createReadStream, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkExecutionAdmission, executionProgress, executionStep } from './execution-admission.js';
import { changeError } from './session-changes-git.js';
import { hasDirectoryAncestors, hasDirectoryAncestorsSync, safeChangePath } from './session-changes-snapshot.js';
import { markObjectDirectoryPending, markObjectIfUnsynced } from './object-durability.js';

export const GRANULAR_TEXT_BYTES = 8 * 1024 * 1024;
const stamp = (stat) => stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':') : null;
/** Stamp of an lstat result the caller already holds (bigint). */
export const mutationStatStamp = stamp;
const absent = (cause) => { if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return null; throw cause; };
export async function mutationFileStamp(directory, file, verifiedAncestors) {
  if (!await hasDirectoryAncestors(directory, file, verifiedAncestors)) return null;
  return stamp(await fs.lstat(path.join(directory, file), { bigint: true }).catch(absent));
}

// mutationFileStamp with synchronous lstat, for the ledger worker's walks.
export function mutationFileStampSync(directory, file, verifiedAncestors) {
  if (!hasDirectoryAncestorsSync(directory, file, verifiedAncestors)) return null;
  try { return stamp(lstatSync(path.join(directory, file), { bigint: true })); }
  catch (cause) { return absent(cause); }
}

export async function requireMutationSpace(directory, bytes) {
  const space = await fs.statfs(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(bytes) + 1024n * 1024n) throw changeError('storage_unavailable', 503);
}

const describe = (stat, digest, whole) => {
  const mode = Number(stat.mode);
  return { hash: digest, mode: stat.isSymbolicLink() ? '120000' : mode & 0o111 ? '100755' : '100644',
    ...(stat.isFile() ? { permissions: mode & 0o7777 } : {}), identity: `${stat.dev}:${stat.ino}`,
    observation: stamp(stat), size: Number(stat.size), whole };
};

// A path that vanished or changed type since its lstat is a changed
// observation (retried by the caller), not a failure of the preparation.
const CHANGED_PATH_CODES = new Set(['ENOENT', 'ELOOP', 'ENOTDIR', 'EINVAL']);
const observed = (action) => action().catch((cause) => {
  if (CHANGED_PATH_CODES.has(cause?.code)) throw changeError('observation_changed');
  throw cause;
});

// Reads one stable observation of the file, passing each chunk to `accept`.
// Symlink targets are raw bytes: a non-UTF-8 target must round-trip exactly.
async function readObservation(directory, file, target, stat, accept) {
  if (stat.isSymbolicLink()) { await accept(await observed(() => fs.readlink(target, { encoding: 'buffer' }))); return; }
  const input = await observed(() => fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW));
  try {
    if (stamp(await input.stat({ bigint: true })) !== stamp(stat)) throw changeError('observation_changed');
    const chunk = Buffer.allocUnsafe(128 * 1024);
    for (;;) {
      const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      await accept(chunk.subarray(0, bytesRead));
    }
    if (stamp(await input.stat({ bigint: true })) !== stamp(stat)) throw changeError('observation_changed');
  } finally { await input.close(); }
}

const classifier = (stat) => {
  let whole = stat.isSymbolicLink() || stat.size > BigInt(GRANULAR_TEXT_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    update(bytes) {
      if (whole) return;
      try { if (bytes.includes(0)) whole = true; else decoder.decode(bytes, { stream: true }); }
      catch { whole = true; }
    },
    get whole() {
      if (!whole) { try { decoder.decode(); } catch { whole = true; } }
      return whole;
    },
  };
};

export async function inspectMutationFile(repo, file, directory = repo.directory, { preview = false } = {}) {
  checkExecutionAdmission();
  if (!await hasDirectoryAncestors(directory, file)) return null;
  const target = path.join(directory, file);
  const stat = await fs.lstat(target, { bigint: true }).catch(absent);
  if (!stat) return null;
  if (!stat.isFile() && !stat.isSymbolicLink()) throw changeError('unsupported_file_type');
  const objects = path.join(repo.root, 'objects');
  // Hash before copying: content already in the immutable object store (the
  // common case after a tool that changed nothing) is neither copied nor
  // synced again. New content falls through to the durable path below.
  {
    const hash = createHash('sha256'), kind = classifier(stat);
    let size = 0;
    await readObservation(directory, file, target, stat, async (bytes) => {
      checkExecutionAdmission();
      hash.update(bytes); kind.update(bytes); size += bytes.length;
      executionProgress();
    });
    if (await mutationFileStamp(directory, file) !== stamp(stat)) throw changeError('observation_changed');
    const digest = hash.digest('hex');
    if (preview) return describe(stat, digest, kind.whole);
    const existing = await fs.lstat(path.join(objects, digest)).catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (existing?.isFile() && existing.size === size) {
      markObjectIfUnsynced(objects, existing.ctimeMs);
      return describe(stat, digest, kind.whole);
    }
  }
  await fs.mkdir(objects, { recursive: true, mode: 0o700 });
  await requireMutationSpace(objects, stat.size);
  const temporary = path.join(objects, `.pending-${randomUUID()}`), hash = createHash('sha256'), kind = classifier(stat);
  let output;
  try {
    output = await fs.open(temporary, 'wx', 0o600);
    await readObservation(directory, file, target, stat, async (bytes) => {
      checkExecutionAdmission();
      hash.update(bytes); kind.update(bytes);
      let offset = 0;
      while (offset < bytes.length) offset += (await output.write(bytes, offset, bytes.length - offset)).bytesWritten;
      executionProgress();
    });
    if (await mutationFileStamp(directory, file) !== stamp(stat)) throw changeError('observation_changed');
    await output.sync(); await output.close(); output = null;
    const digest = hash.digest('hex');
    // Objects are immutable. A hard link installs once without replacing an
    // existing reader's inode, even when different observers see the same bytes.
    const installed = await fs.link(temporary, path.join(objects, digest)).then(() => true, (cause) => { if (cause.code !== 'EEXIST') throw cause; return false; });
    // The ledger commit that references this object syncs the directory first.
    markObjectDirectoryPending(objects);
    // Unlinking the temporary name changes the object's link count and so
    // its change time: record the identity only after it is gone.
    if (installed) { await fs.rm(temporary, { force: true }); await recordInstalledObject(objects, digest); }
    return describe(stat, digest, kind.whole);
  } catch (cause) {
    if (['ENOSPC', 'EDQUOT'].includes(cause.code)) throw changeError('storage_unavailable', 503);
    throw cause;
  } finally {
    await output?.close(); await fs.rm(temporary, { force: true });
  }
}

// Content-addressed objects are immutable once written. Verify each object's
// bytes once per file identity, then let views clone it (APFS copy-on-write;
// libuv falls back to a byte copy where cloning is unsupported).
//
// Verified identities also persist in `<root>/verified-objects.v1`, so the
// first view after an app start does not rehash every object (13k files took
// 5.9 s in the 2026-10-24 live QA). An identity includes the inode change
// time, which any write or chmod advances and which no unprivileged process
// can set back, so a matching identity means the bytes are unchanged since
// they were hashed. The file sits inside the ledger root's private trust
// boundary. Kill switch, read per use: DEVRYAN_PERSISTENT_OBJECT_VERIFY=0.
const verifiedObjects = new Map();
const MAX_VERIFIED_OBJECTS = 100_000;
const VERIFIED_OBJECTS_FILE = 'verified-objects.v1';
const VERIFIED_LINE = /^([a-f0-9]{64}) (\d+:\d+:\d+:\d+:\d+)$/;
const persistentVerify = () => process.env.DEVRYAN_PERSISTENT_OBJECT_VERIFY !== '0';
const objectIdentity = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const rememberVerified = (expected, identity) => {
  verifiedObjects.delete(expected); verifiedObjects.set(expected, identity);
  while (verifiedObjects.size > MAX_VERIFIED_OBJECTS) verifiedObjects.delete(verifiedObjects.keys().next().value);
};
// One load per ledger root and process. Unreadable or partial lines are
// ignored: a missing identity only costs a rehash.
const persistedRoots = new Map();
const loadVerifiedObjects = (root) => {
  let pending = persistedRoots.get(root);
  if (!pending) {
    pending = (async () => {
      const file = path.join(root, VERIFIED_OBJECTS_FILE);
      const text = await fs.readFile(file, 'utf8').catch((cause) => { if (cause.code === 'ENOENT') return ''; throw cause; });
      const latest = new Map();
      let lines = 0;
      for (const line of text.split('\n')) {
        const match = VERIFIED_LINE.exec(line);
        if (!match) continue;
        lines += 1; latest.delete(match[1]); latest.set(match[1], match[2]);
      }
      for (const [hash, identity] of latest) if (!verifiedObjects.has(hash)) rememberVerified(hash, identity);
      // Appends repeat an object whose identity changed; compact once the
      // file holds twice as many lines as live objects.
      if (lines > 1_024 && lines > latest.size * 2) {
        const temporary = path.join(root, `.${VERIFIED_OBJECTS_FILE}-${randomUUID()}`);
        try {
          await fs.writeFile(temporary, [...latest].map(([hash, identity]) => `${hash} ${identity}\n`).join(''), { mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
      }
    })().catch(() => { /* Rehashing is always correct. */ });
    persistedRoots.set(root, pending);
  }
  return pending;
};
const persistVerified = (root, expected, identity) => fs.appendFile(path.join(root, VERIFIED_OBJECTS_FILE),
  `${expected} ${identity}\n`, { mode: 0o600 }).catch(() => { /* Rehashing is always correct. */ });
/** Tests only: forget identities verified by this process. */
export const resetVerifiedMutationObjects = () => { verifiedObjects.clear(); persistedRoots.clear(); };

async function verifyMutationObject(file, expected) {
  const root = path.dirname(path.dirname(file));
  if (persistentVerify()) await loadVerifiedObjects(root);
  const stat = await fs.stat(file, { bigint: true });
  const identity = objectIdentity(stat);
  if (verifiedObjects.get(expected) === identity) return;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) { checkExecutionAdmission(); hash.update(chunk); executionProgress(); }
  if (hash.digest('hex') !== expected) throw changeError('invalid_change_record');
  executionStep('object_verify_hashed', 0);
  rememberVerified(expected, identity);
  if (persistentVerify()) await persistVerified(root, expected, identity);
}

// The installer just hashed these bytes, so the new object is verified.
async function recordInstalledObject(objects, digest) {
  if (!persistentVerify()) return;
  const stat = await fs.stat(path.join(objects, digest), { bigint: true }).catch(() => null);
  if (!stat?.isFile()) return;
  const identity = objectIdentity(stat);
  if (verifiedObjects.get(digest) === identity) return;
  rememberVerified(digest, identity);
  await persistVerified(path.dirname(objects), digest, identity);
}

// Materializes files into a disposable view directory this preparation just
// created. Per file it clones the verified object straight into place (about
// four filesystem requests instead of about twelve through the temporary-file
// writer): each directory is created and checked once per preparation, a
// clone never replaces an existing entry, and ancestors are never followed
// through a link. `null` asks the caller to use the general writer (symbolic
// links, and existing entries such as case-only collisions on a
// case-insensitive volume). Returns the new file's bigint lstat.
export function createViewMaterializer(repo, view, { io = (action) => action() } = {}) {
  const directories = new Map([[view, Promise.resolve()]]);
  const ensure = (directory) => {
    let pending = directories.get(directory);
    if (!pending) {
      pending = ensure(path.dirname(directory))
        .then(() => fs.mkdir(directory))
        .catch(async (cause) => {
          if (cause.code !== 'EEXIST') throw cause;
          const stat = await fs.lstat(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw changeError('unsupported_path');
        });
      directories.set(directory, pending);
    }
    return pending;
  };
  return async (file, entry, mode) => {
    if (!safeChangePath(file)) throw changeError('unsupported_path');
    if (!/^[a-f0-9]{64}$/.test(entry?.hash ?? '')) throw changeError('invalid_change_record');
    if (entry.mode === '120000') return null;
    const target = path.join(view, file);
    await ensure(path.dirname(target));
    const object = path.join(repo.root, 'objects', entry.hash);
    try {
      await io(async () => {
        await verifyMutationObject(object, entry.hash);
        checkExecutionAdmission();
        await fs.copyFile(object, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      });
    } catch (cause) {
      if (cause.code === 'EEXIST') return null;
      if (['ENOSPC', 'EDQUOT'].includes(cause.code)) throw changeError('storage_unavailable', 503);
      throw cause;
    }
    await fs.chmod(target, mode);
    executionProgress();
    return fs.lstat(target, { bigint: true });
  };
}

// `durable: false` is for disposable execution views: a crash cancels their
// lease, so a view is never published and needs neither sync nor a space probe.
export async function copyMutationObject(repo, entry, target, mode, { durable = true } = {}) {
  if (!/^[a-f0-9]{64}$/.test(entry.hash ?? '')) throw changeError('invalid_change_record');
  if (!durable && process.env.DEVRYAN_VIEW_CLONE !== '0') {
    const object = path.join(repo.root, 'objects', entry.hash);
    await verifyMutationObject(object, entry.hash);
    const temporary = `${target}.devryan-${randomUUID()}`;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      checkExecutionAdmission();
      await fs.copyFile(object, temporary, constants.COPYFILE_FICLONE);
      await fs.chmod(temporary, mode);
      await fs.rename(temporary, target);
      executionProgress();
    } catch (cause) {
      if (['ENOSPC', 'EDQUOT'].includes(cause.code)) throw changeError('storage_unavailable', 503);
      throw cause;
    } finally { await fs.rm(temporary, { force: true }); }
    return;
  }
  const source = await fs.open(path.join(repo.root, 'objects', entry.hash), 'r');
  const temporary = `${target}.devryan-${randomUUID()}`;
  let output;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (durable) await requireMutationSpace(path.dirname(target), (await source.stat()).size);
    output = await fs.open(temporary, 'wx', mode);
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(128 * 1024);
    for (;;) {
      checkExecutionAdmission();
      const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) offset += (await output.write(chunk, offset, bytesRead - offset)).bytesWritten;
      executionProgress();
    }
    if (hash.digest('hex') !== entry.hash) throw changeError('invalid_change_record');
    await output.chmod(mode); if (durable) await output.sync(); await output.close(); output = null;
    await fs.rename(temporary, target);
  } catch (cause) {
    if (['ENOSPC', 'EDQUOT'].includes(cause.code)) throw changeError('storage_unavailable', 503);
    throw cause;
  } finally {
    await source.close(); await output?.close(); await fs.rm(temporary, { force: true });
  }
}
