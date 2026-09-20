import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

// Spike adapter only: encryption, AAD, size and integrity checks remain owned by
// the existing Bot blob store. This layer receives ciphertext, never cleartext.
export async function createEncryptedFileStorage(directory) {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw new Error('Encrypted object directory must be private and must not be a symlink');
  }
  const filename = (bucket, name) => {
    if (bucket !== 'devryan-bot-objects'
      || !/^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/i.test(name)) {
      throw new Error('Invalid encrypted object identity');
    }
    return path.join(root, name.slice('objects/'.length));
  };
  const bound = (value) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > 25 * 1024 * 1024) throw new Error('Invalid object size bound');
    return value;
  };
  return Object.freeze({
    async storageUpload(bucket, name, bytes, { maximumBytes } = {}) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > bound(maximumBytes)) throw new Error('Invalid ciphertext size');
      const target = filename(bucket, name);
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      catch (error) { await unlink(target).catch(() => {}); throw error; }
      finally { await file.close(); }
      const parent = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    },
    async storageDownload(bucket, name, { maximumBytes } = {}) {
      const maximum = bound(maximumBytes);
      const file = await open(filename(bucket, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid ciphertext file');
        const buffer = Buffer.alloc(maximum + 1);
        let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (total > maximum) throw new Error('Ciphertext exceeds size bound');
        return buffer.subarray(0, total);
      } finally { await file.close(); }
    },
    async storageDelete(bucket, names) {
      if (!Array.isArray(names)) throw new Error('Object identities required');
      const targets = names.map((name) => filename(bucket, name));
      for (const target of targets) {
        await unlink(target).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    },
  });
}
