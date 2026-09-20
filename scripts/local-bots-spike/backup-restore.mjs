import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBotBlobStore } from '../../packages/web/server/lib/bots/blob-store.js';
import { createEncryptedFileStorage } from './encrypted-files.mjs';
import { command, localDatabase, sql, workspace } from './fixtures.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const snapshot = path.join(workspace, 'snapshots', randomUUID());
await mkdir(snapshot, { recursive: true, mode: 0o700 });
const objectDirectory = path.join(snapshot, 'objects');
await mkdir(objectDirectory, { mode: 0o700 });
const compose = path.join(workspace, 'compose.json');
const manifest = { version: 1, usable: false, objects: [], restoreVerified: false };

// This owned fixture has no executor/background writer. Stop its sole HTTP
// writer while taking one consistent database/object inventory. Production
// integration must drain admitted work and fence all writers before this step.
command('docker', ['compose', '-f', compose, 'stop', 'rest']);
try {
  const inventory = JSON.parse(sql(localDatabase,
    "select coalesce(json_agg(row_to_json(o)), '[]') from public.bot_objects o where deleted_at is null;"));
  const tables = JSON.parse(sql(localDatabase, "select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and (tablename='bots' or tablename like 'bot_%');"));
  const fingerprintQuery = (table) => {
    assert.match(table, /^[a-z_]+$/);
    return `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') from public.${table} t;`;
  };
  manifest.tableSha256 = Object.fromEntries(tables.map((table) => [table, hash(sql(localDatabase, fingerprintQuery(table)))]));
  const bytesNeeded = inventory.reduce((total, row) => total + Number(row.ciphertext_size), 0);
  const free = await statfs(snapshot, { bigint: true });
  assert(free.bavail * free.bsize > BigInt(bytesNeeded + 64 * 1024 * 1024), 'Insufficient snapshot disk space');
  const dump = execFileSync('docker', ['exec', '--user', 'postgres', localDatabase, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '-Fc'],
    { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  await writeFile(path.join(snapshot, 'database.dump'), dump, { mode: 0o600 });
  manifest.databaseSha256 = hash(dump);
  for (const object of inventory) {
    const name = path.basename(object.storage_object_name);
    assert.match(object.storage_object_name, /^objects\/[a-f0-9-]+\.bin$/);
    const source = path.join(workspace, 'objects', name);
    const destination = path.join(objectDirectory, name);
    await copyFile(source, destination);
    const bytes = await readFile(destination);
    assert.equal(bytes.length, Number(object.ciphertext_size));
    assert.equal(hash(bytes), object.ciphertext_hash);
    manifest.objects.push({ id: object.id, name, sha256: hash(bytes), bytes: bytes.length });
  }
  manifest.migrations = JSON.parse(await readFile(path.join(workspace, 'migration-manifest.json'), 'utf8'));
  await writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  // A new, empty logical database is the restore destination. Never overwrite
  // the source, an existing database or an installed-app container/volume.
  const destinationDatabase = `spike_restore_${randomUUID().replaceAll('-', '')}`;
  command('docker', ['exec', '--user', 'postgres', localDatabase, 'createdb', '-U', 'postgres', '--template=template0', destinationDatabase]);
  execFileSync('docker', ['exec', '--user', 'postgres', '-i', localDatabase, 'pg_restore', '-U', 'postgres', '--exit-on-error', '-d', destinationDatabase],
    { input: dump, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const restoredSql = (input) => command('docker', ['exec', '--user', 'postgres', '-i', localDatabase, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', destinationDatabase], { input });
  const restored = JSON.parse(restoredSql("select coalesce(json_agg(row_to_json(o)), '[]') from public.bot_objects o where deleted_at is null;"));
  assert.deepEqual(restored, inventory);
  for (const table of tables) assert.equal(hash(restoredSql(fingerprintQuery(table))), manifest.tableSha256[table], `Restored ${table} differs from the snapshot`);
  const fixture = JSON.parse(await readFile(path.join(workspace, 'object-recovery-fixture.json'), 'utf8'));
  const row = restored.find((entry) => entry.id === fixture.object.id);
  assert(row, 'Snapshot is missing the encrypted recovery fixture');
  const storage = await createEncryptedFileStorage(objectDirectory);
  const store = { get: async () => row, storage: { download: storage.storageDownload } };
  const makeBlobStore = (key) => createBotBlobStore({ store, authorization: {}, encryption: { getKey: async () => Buffer.from(key, 'base64') } });
  assert.deepEqual((await makeBlobStore(fixture.key).downloadAuthorized({ botId: fixture.botId, objectId: row.id })).bytes,
    Buffer.from(fixture.cleartext, 'base64'));
  // Losing the key or damaging one byte fails closed; neither is a reason to
  // reset the original database or replace it with an empty store.
  await assert.rejects(makeBlobStore(Buffer.alloc(32).toString('base64')).downloadAuthorized({ botId: fixture.botId, objectId: row.id }));
  const objectPath = path.join(objectDirectory, path.basename(row.storage_object_name));
  const original = await readFile(objectPath);
  const corrupt = Buffer.from(original); corrupt[0] ^= 1;
  await writeFile(objectPath, corrupt);
  await assert.rejects(makeBlobStore(fixture.key).downloadAuthorized({ botId: fixture.botId, objectId: row.id }), { code: 'bot_object_integrity_failed' });
  await writeFile(objectPath, original);
  assert.equal(hash(await readFile(objectPath)), row.ciphertext_hash);
  manifest.usable = true;
  manifest.restoreVerified = true;
  manifest.restoreDatabase = destinationDatabase;
  await writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(path.join(workspace, 'backup-restore-result.json'), JSON.stringify({ snapshot, ...manifest }, null, 2));
  console.log('PASS: consistent snapshot, fresh database restore, byte-identical encrypted objects, usable key recovery, wrong-key and corruption rejection');
} finally {
  command('docker', ['compose', '-f', compose, 'start', 'rest']);
}
