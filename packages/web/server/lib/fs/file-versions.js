import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const writes = new Map();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':');
const stale = () => Object.assign(new Error('File changed on disk. Reload it before saving.'), { code: 'FILE_VERSION_CONFLICT', status: 409 });

export async function readVersionedFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw Object.assign(new Error('Specified path is not a file'), { status: 400 });
    const bytes = await handle.readFile();
    if (stamp(before) !== stamp(await handle.stat({ bigint: true }))) throw stale();
    let complete = !bytes.includes(0);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { complete = false; }
    return { bytes, version: digest(bytes), complete, stamp: stamp(before), mode: Number(before.mode) & 0o7777 };
  } finally { await handle.close(); }
}

export async function writeVersionedFile(file, content, expectedVersion) {
  const key = path.resolve(file), previous = writes.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const bytes = Buffer.from(content, 'utf8');
    if (expectedVersion === undefined) { await fs.writeFile(file, bytes); return digest(bytes); }
    if (!/^[a-f0-9]{64}$/.test(expectedVersion)) throw stale();
    const current = await readVersionedFile(file).catch((cause) => { if (cause.code === 'ENOENT') throw stale(); throw cause; });
    if (current.version !== expectedVersion || !current.complete) throw stale();
    if (current.bytes.equals(bytes)) return current.version;
    const temporary = path.join(path.dirname(file), `.devryan-save-${randomUUID()}`);
    let output;
    try {
      output = await fs.open(temporary, 'wx', current.mode);
      await output.writeFile(bytes); await output.chmod(current.mode); await output.sync();
      await output.close(); output = null;
      const latest = await readVersionedFile(file);
      if (latest.version !== expectedVersion || latest.stamp !== current.stamp) throw stale();
      await fs.rename(temporary, file);
      const parent = await fs.open(path.dirname(file), 'r');
      try { await parent.sync(); } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
      } finally { await parent.close(); }
      return digest(bytes);
    } finally { await output?.close(); await fs.rm(temporary, { force: true }); }
  });
  writes.set(key, write);
  try { return await write; } finally { if (writes.get(key) === write) writes.delete(key); }
}
