import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { BOT_OBJECT_BUCKET } from './blob-store.js';

// Local ciphertext storage for Bot objects. Encryption, AAD, size and integrity
// remain owned by the blob store; this layer receives and returns ciphertext
// only, under opaque object names, with exclusive creation, private modes,
// bounded reads, no symlink traversal and fsync before success.

const OBJECT_NAME_PATTERN = /^objects\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.bin$/i;
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

export class BotObjectStorageError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'BotObjectStorageError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

const fail = (message, code, status = 500) => {
  throw new BotObjectStorageError(message, code, status);
};

export const botObjectFileName = (objectName) => {
  const match = typeof objectName === 'string' ? OBJECT_NAME_PATTERN.exec(objectName) : null;
  if (!match) fail('Bot object identity is invalid', 'bot_object_storage_name_invalid', 400);
  return `${match[1].toLowerCase()}.bin`;
};

const boundedSize = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OBJECT_BYTES) {
    fail('Bot object size limit is invalid', 'bot_object_storage_limit_invalid', 400);
  }
  return value;
};

const syncDirectory = async (directory, fsPromises) => {
  let handle;
  try {
    handle = await fsPromises.open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    await handle.sync();
  } catch {
    // Some filesystems do not permit directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export async function createLocalBotObjectStorage({
  directory,
  fsPromises = fs,
  assertWritable = () => {},
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    fail('Bot object storage requires an absolute directory', 'bot_object_storage_invalid');
  }
  if (typeof assertWritable !== 'function') {
    fail('Bot object storage write fence is invalid', 'bot_object_storage_invalid');
  }
  const root = path.resolve(directory);
  await fsPromises.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fsPromises.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('Bot object storage must be a real directory', 'bot_object_storage_invalid');
  }
  if ((info.mode & 0o077) !== 0) await fsPromises.chmod(root, 0o700);

  const target = (bucket, objectName) => {
    if (bucket !== BOT_OBJECT_BUCKET) fail('Bot object bucket is invalid', 'bot_object_storage_name_invalid', 400);
    return path.join(root, botObjectFileName(objectName));
  };

  return Object.freeze({
    directory: root,
    async storageUpload(bucket, objectName, bytes, { maximumBytes = MAX_OBJECT_BYTES } = {}) {
      assertWritable('object_upload');
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
      if (body.byteLength < 1 || body.byteLength > boundedSize(maximumBytes)) {
        fail('Bot object upload is too large', 'bot_object_storage_too_large', 413);
      }
      const file = target(bucket, objectName);
      let handle;
      try {
        handle = await fsPromises.open(
          file,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
          0o600,
        );
      } catch (error) {
        if (error?.code === 'EEXIST') fail('Bot object already exists', 'bot_object_storage_conflict', 409);
        fail('Bot object storage is unavailable', 'bot_object_storage_unavailable', 503);
      }
      try {
        await handle.writeFile(body);
        await handle.sync();
      } catch {
        await handle.close().catch(() => undefined);
        handle = null;
        await fsPromises.unlink(file).catch(() => undefined);
        fail('Bot object storage write failed', 'bot_object_storage_unavailable', 503);
      } finally {
        await handle?.close().catch(() => undefined);
      }
      await syncDirectory(root, fsPromises);
      return Object.freeze({ Key: `${bucket}/${objectName}` });
    },
    async storageDownload(bucket, objectName, { maximumBytes = MAX_OBJECT_BYTES } = {}) {
      const maximum = boundedSize(maximumBytes);
      let handle;
      try {
        handle = await fsPromises.open(target(bucket, objectName), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      } catch (error) {
        if (error instanceof BotObjectStorageError) throw error;
        if (error?.code === 'ENOENT') fail('Bot object was not found', 'bot_object_storage_missing', 404);
        fail('Bot object storage is unavailable', 'bot_object_storage_unavailable', 503);
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) fail('Bot object file is invalid', 'bot_object_storage_invalid', 502);
        if (stat.size > maximum) fail('Bot object response is too large', 'supabase_response_too_large', 502);
        const buffer = Buffer.alloc(maximum + 1);
        let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (total > maximum) fail('Bot object response is too large', 'supabase_response_too_large', 502);
        return buffer.subarray(0, total);
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async storageDelete(bucket, objectNames) {
      assertWritable('object_delete');
      if (!Array.isArray(objectNames) || objectNames.length < 1 || objectNames.length > 100) {
        fail('Bot object delete list is invalid', 'bot_object_storage_name_invalid', 400);
      }
      const files = objectNames.map((objectName) => target(bucket, objectName));
      const deleted = [];
      for (const [index, file] of files.entries()) {
        try {
          await fsPromises.unlink(file);
          deleted.push({ name: objectNames[index] });
        } catch (error) {
          if (error?.code !== 'ENOENT') fail('Bot object delete failed', 'bot_object_storage_unavailable', 503);
        }
      }
      if (deleted.length > 0) await syncDirectory(root, fsPromises);
      return deleted;
    },
    // Opaque names of every stored ciphertext file (backup and orphan checks).
    async listObjectFiles() {
      const names = [];
      for (const entry of await fsPromises.readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && /^[0-9a-f-]{36}\.bin$/.test(entry.name)) names.push(entry.name);
      }
      return names.sort();
    },
  });
}
