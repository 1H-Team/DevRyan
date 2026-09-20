import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createEncryptedFileStorage } from './encrypted-files.mjs';

const bucket = 'devryan-bot-objects';
const name = 'objects/aa000000-0000-4000-8000-000000000001.bin';
const maximumBytes = 32;
async function fixture(t) {
  const base = path.resolve(import.meta.dirname, '../../.cache');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'encrypted-file-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await createEncryptedFileStorage(directory) };
}

test('ciphertext survives reopening with private permissions and cannot be overwritten', async (t) => {
  const { directory, store } = await fixture(t);
  const bytes = Buffer.from('fixture ciphertext');
  await store.storageUpload(bucket, name, bytes, { maximumBytes });
  const reopened = await createEncryptedFileStorage(directory);
  assert.deepEqual(await reopened.storageDownload(bucket, name, { maximumBytes }), bytes);
  assert.equal((await stat(path.join(directory, path.basename(name)))).mode & 0o777, 0o600);
  await assert.rejects(store.storageUpload(bucket, name, Buffer.from('overwrite'), { maximumBytes }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(path.join(directory, path.basename(name))), bytes);
});

test('encrypted storage rejects traversal, other buckets and symlinks', async (t) => {
  const { directory, store } = await fixture(t);
  for (const invalid of ['../outside', 'objects/../../outside', 'objects/a.bin', '/etc/passwd']) {
    await assert.rejects(store.storageDownload(bucket, invalid, { maximumBytes }));
  }
  await assert.rejects(store.storageUpload('public', name, Buffer.from('bytes'), { maximumBytes }));
  const target = path.join(directory, 'target');
  await writeFile(target, 'preserved');
  await symlink(target, path.join(directory, path.basename(name)));
  await assert.rejects(store.storageDownload(bucket, name, { maximumBytes }));
  await assert.rejects(store.storageUpload(bucket, name, Buffer.from('bytes'), { maximumBytes }));
  assert.equal(await readFile(target, 'utf8'), 'preserved');
});

test('ciphertext reads and writes enforce caller size bounds', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.storageUpload(bucket, name, Buffer.alloc(33), { maximumBytes }));
  await store.storageUpload(bucket, name, Buffer.alloc(20), { maximumBytes });
  await assert.rejects(store.storageDownload(bucket, name, { maximumBytes: 10 }));
  await assert.rejects(store.storageDownload(bucket, name, { maximumBytes: Infinity }));
  await store.storageDelete(bucket, [name]);
  await store.storageDelete(bucket, [name]);
  await assert.rejects(store.storageDownload(bucket, name, { maximumBytes }), { code: 'ENOENT' });
});
