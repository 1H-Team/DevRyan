import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkExecutionAdmission, executionProgress } from './execution-admission.js';
import { changeError } from './session-changes-git.js';
import { hasDirectoryAncestors } from './session-changes-snapshot.js';
import { markObjectDirectoryPending, markObjectIfUnsynced } from './object-durability.js';

export const GRANULAR_TEXT_BYTES = 8 * 1024 * 1024;
const stamp = (stat) => stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':') : null;
/** Stamp of an lstat result the caller already holds (bigint). */
export const mutationStatStamp = stamp;
const absent = (cause) => { if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return null; throw cause; };
export async function mutationFileStamp(directory, file) {
  if (!await hasDirectoryAncestors(directory, file)) return null;
  return stamp(await fs.lstat(path.join(directory, file), { bigint: true }).catch(absent));
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

export async function inspectMutationFile(repo, file, directory = repo.directory) {
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
    await fs.link(temporary, path.join(objects, digest)).catch((cause) => { if (cause.code !== 'EEXIST') throw cause; });
    // The ledger commit that references this object syncs the directory first.
    markObjectDirectoryPending(objects);
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
const verifiedObjects = new Map();
const MAX_VERIFIED_OBJECTS = 100_000;
async function verifyMutationObject(file, expected) {
  const stat = await fs.stat(file, { bigint: true });
  const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  if (verifiedObjects.get(expected) === identity) return;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) { checkExecutionAdmission(); hash.update(chunk); executionProgress(); }
  if (hash.digest('hex') !== expected) throw changeError('invalid_change_record');
  verifiedObjects.delete(expected); verifiedObjects.set(expected, identity);
  while (verifiedObjects.size > MAX_VERIFIED_OBJECTS) verifiedObjects.delete(verifiedObjects.keys().next().value);
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
