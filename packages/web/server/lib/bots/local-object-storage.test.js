import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BOT_OBJECT_BUCKET } from './blob-store.js';
import { botObjectFileName, createLocalBotObjectStorage } from './local-object-storage.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const temporary = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-objects-'));
  directories.push(directory);
  return path.join(directory, 'objects');
};
const NAME = 'objects/0b5f7c1e-5d0a-4f4e-9a3b-2c1d0e9f8a7b.bin';

describe('local Bot object storage', () => {
  it('stores ciphertext privately with exclusive creation and bounded reads', async () => {
    const directory = await temporary();
    const storage = await createLocalBotObjectStorage({ directory });
    const bytes = Buffer.from('ciphertext bytes');

    await storage.storageUpload(BOT_OBJECT_BUCKET, NAME, bytes, { maximumBytes: 1024 });
    const file = path.join(directory, botObjectFileName(NAME));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    await expect(storage.storageDownload(BOT_OBJECT_BUCKET, NAME, { maximumBytes: 1024 })).resolves.toEqual(bytes);
    await expect(storage.storageUpload(BOT_OBJECT_BUCKET, NAME, bytes)).rejects.toMatchObject({
      code: 'bot_object_storage_conflict', status: 409,
    });
    await expect(storage.storageDownload(BOT_OBJECT_BUCKET, NAME, { maximumBytes: 4 })).rejects.toMatchObject({
      code: 'supabase_response_too_large',
    });
    expect(await storage.listObjectFiles()).toEqual([botObjectFileName(NAME)]);
  });

  it('rejects traversal, foreign buckets, symlinks and oversized uploads', async () => {
    const directory = await temporary();
    const storage = await createLocalBotObjectStorage({ directory });
    for (const name of ['objects/../x.bin', 'objects/not-a-uuid.bin', '/etc/passwd', 'objects/0b5f7c1e-5d0a-4f4e-9a3b-2c1d0e9f8a7b.txt']) {
      await expect(storage.storageUpload(BOT_OBJECT_BUCKET, name, Buffer.from('x'))).rejects.toMatchObject({
        code: 'bot_object_storage_name_invalid',
      });
    }
    await expect(storage.storageUpload('other-bucket', NAME, Buffer.from('x'))).rejects.toMatchObject({
      code: 'bot_object_storage_name_invalid',
    });
    await expect(storage.storageUpload(BOT_OBJECT_BUCKET, NAME, Buffer.alloc(8), { maximumBytes: 4 })).rejects.toMatchObject({
      code: 'bot_object_storage_too_large',
    });
    const outside = path.join(path.dirname(directory), 'outside.bin');
    await fs.writeFile(outside, 'secret');
    await fs.symlink(outside, path.join(directory, botObjectFileName(NAME)));
    await expect(storage.storageDownload(BOT_OBJECT_BUCKET, NAME)).rejects.toMatchObject({
      code: 'bot_object_storage_unavailable',
    });
  });

  it('reports missing objects as 404 and deletes idempotently', async () => {
    const directory = await temporary();
    const storage = await createLocalBotObjectStorage({ directory });
    await expect(storage.storageDownload(BOT_OBJECT_BUCKET, NAME)).rejects.toMatchObject({
      code: 'bot_object_storage_missing', status: 404,
    });
    await storage.storageUpload(BOT_OBJECT_BUCKET, NAME, Buffer.from('x'));
    await expect(storage.storageDelete(BOT_OBJECT_BUCKET, [NAME])).resolves.toEqual([{ name: NAME }]);
    await expect(storage.storageDelete(BOT_OBJECT_BUCKET, [NAME])).resolves.toEqual([]);
  });

  it('refuses writes while the maintenance fence is closed but keeps reads', async () => {
    const directory = await temporary();
    let fenced = false;
    const storage = await createLocalBotObjectStorage({
      directory,
      assertWritable: () => {
        if (fenced) throw Object.assign(new Error('maintenance'), { code: 'bots_maintenance' });
      },
    });
    await storage.storageUpload(BOT_OBJECT_BUCKET, NAME, Buffer.from('x'));
    fenced = true;
    await expect(storage.storageUpload(BOT_OBJECT_BUCKET, NAME.replace('0b5f', '1b5f'), Buffer.from('y')))
      .rejects.toMatchObject({ code: 'bots_maintenance' });
    await expect(storage.storageDelete(BOT_OBJECT_BUCKET, [NAME])).rejects.toMatchObject({ code: 'bots_maintenance' });
    await expect(storage.storageDownload(BOT_OBJECT_BUCKET, NAME)).resolves.toEqual(Buffer.from('x'));
  });
});
