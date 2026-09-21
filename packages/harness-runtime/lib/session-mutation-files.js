import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkExecutionAdmission, executionProgress } from './execution-admission.js';
import { changeError } from './session-changes-git.js';
import { verifyAncestors } from './session-changes-snapshot.js';

export const GRANULAR_TEXT_BYTES = 8 * 1024 * 1024;
const stamp = (stat) => stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':') : null;
export async function mutationFileStamp(directory, file) {
  await verifyAncestors(directory, file);
  return stamp(await fs.lstat(path.join(directory, file), { bigint: true }).catch((cause) => {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }));
}

export async function requireMutationSpace(directory, bytes) {
  const space = await fs.statfs(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(bytes) + 1024n * 1024n) throw changeError('storage_unavailable', 503);
}

export async function inspectMutationFile(repo, file, directory = repo.directory) {
  checkExecutionAdmission();
  await verifyAncestors(directory, file);
  const target = path.join(directory, file);
  const stat = await fs.lstat(target, { bigint: true }).catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause; });
  if (!stat) return null;
  if (!stat.isFile() && !stat.isSymbolicLink()) throw changeError('unsupported_file_type');
  const objects = path.join(repo.root, 'objects');
  await fs.mkdir(objects, { recursive: true, mode: 0o700 });
  await requireMutationSpace(objects, stat.size);
  const temporary = path.join(objects, `.pending-${randomUUID()}`), hash = createHash('sha256');
  let input, output, whole = stat.isSymbolicLink() || stat.size > BigInt(GRANULAR_TEXT_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    output = await fs.open(temporary, 'wx', 0o600);
    const accept = async (bytes) => {
      checkExecutionAdmission();
      hash.update(bytes);
      if (!whole) {
        try { if (bytes.includes(0)) whole = true; else decoder.decode(bytes, { stream: true }); }
        catch { whole = true; }
      }
      let offset = 0;
      while (offset < bytes.length) offset += (await output.write(bytes, offset, bytes.length - offset)).bytesWritten;
      executionProgress();
    };
    if (stat.isSymbolicLink()) await accept(Buffer.from(await fs.readlink(target)));
    else {
      input = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (stamp(await input.stat({ bigint: true })) !== stamp(stat)) throw changeError('observation_changed');
      const chunk = Buffer.allocUnsafe(128 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        await accept(chunk.subarray(0, bytesRead));
      }
      if (stamp(await input.stat({ bigint: true })) !== stamp(stat)) throw changeError('observation_changed');
    }
    if (!whole) { try { decoder.decode(); } catch { whole = true; } }
    if (await mutationFileStamp(directory, file) !== stamp(stat)) throw changeError('observation_changed');
    await output.sync(); await output.close(); output = null;
    const digest = hash.digest('hex');
    // Objects are immutable. A hard link installs once without replacing an
    // existing reader's inode, even when different observers see the same bytes.
    await fs.link(temporary, path.join(objects, digest)).catch((cause) => { if (cause.code !== 'EEXIST') throw cause; });
    const objectDirectory = await fs.open(objects, 'r');
    try { await objectDirectory.sync(); } finally { await objectDirectory.close(); }
    const mode = Number(stat.mode);
    return { hash: digest, mode: stat.isSymbolicLink() ? '120000' : mode & 0o111 ? '100755' : '100644',
      ...(stat.isFile() ? { permissions: mode & 0o7777 } : {}), identity: `${stat.dev}:${stat.ino}`,
      observation: stamp(stat), size: Number(stat.size), whole };
  } catch (cause) {
    if (['ENOSPC', 'EDQUOT'].includes(cause.code)) throw changeError('storage_unavailable', 503);
    throw cause;
  } finally {
    await input?.close(); await output?.close(); await fs.rm(temporary, { force: true });
  }
}

export async function copyMutationObject(repo, entry, target, mode) {
  if (!/^[a-f0-9]{64}$/.test(entry.hash ?? '')) throw changeError('invalid_change_record');
  const source = await fs.open(path.join(repo.root, 'objects', entry.hash), 'r');
  const temporary = `${target}.devryan-${randomUUID()}`;
  let output;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await requireMutationSpace(path.dirname(target), (await source.stat()).size);
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
    await output.chmod(mode); await output.sync(); await output.close(); output = null;
    await fs.rename(temporary, target);
  } catch (cause) {
    if (['ENOSPC', 'EDQUOT'].includes(cause.code)) throw changeError('storage_unavailable', 503);
    throw cause;
  } finally {
    await source.close(); await output?.close(); await fs.rm(temporary, { force: true });
  }
}
