import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyNativeBootMigration } from './native-boot-migration.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/clone-boot-'));
  roots.push(root); await fs.mkdir(path.join(root, 'sources')); await fs.mkdir(path.join(root, 'opencode'));
  const write = async (file, value) => { const bytes = Buffer.from(JSON.stringify(value)); await fs.writeFile(path.join(root, file), bytes); return hash(bytes); };
  const databasePath = path.join(root, 'opencode/opencode.db');
  const origin = { bundleID: 'original-A', databasePath: path.join(root, 'not-read-A/opencode/opencode.db') };
  const receipt = { protocol: 'devryan-native-migration/1', requestID: 'import-A', ...origin, status: 'completed', nativeVersion: '2.0.20', marker: 'not-needed',
    sourceInventorySha256: await write('sources/migration.json.source.json', { source: 'A' }),
    verificationSha256: await write('sources/migration.json.verification.json', { verified: true }) };
  const receiptSHA = await write('sources/migration.json', receipt);
  const boot = { bundleID: 'clone-B', databasePath, manifestSha256: 'b'.repeat(64),
    migrationEvidence: { path: path.join(root, 'sources/migration.json'), sha256: receiptSHA } };
  const descriptor = { schema: 1, generation: 2, bundleID: boot.bundleID, sourceBundleID: 'original-A',
    launch: { opencodeDatabasePath: databasePath, artifactManifestSha256: boot.manifestSha256 },
    preparedManifestPath: path.join(root, 'prepared.json'), migrationReceiptPath: boot.migrationEvidence.path };
  const clone = { schema: 1, sourceBundleID: descriptor.sourceBundleID, sourceCredentialSha256: 'c'.repeat(64),
    sourceDescriptorSha256: 'd'.repeat(64), sourcePreparedManifestSha256: 'e'.repeat(64), migrationOrigin: origin,
    compatibility: { protocol: 'devryan-v2-clone/1', sourceBundleID: descriptor.sourceBundleID,
      sourceManifestSha256: 'a'.repeat(64), targetManifestSha256: boot.manifestSha256 } };
  const seal = async () => {
    await write('descriptor.json', descriptor); await write('sources/clone.json', clone);
    const files = ['descriptor.json', 'sources/clone.json', 'sources/migration.json', 'sources/migration.json.source.json', 'sources/migration.json.verification.json'];
    const immutableFiles = await Promise.all(files.map(async file => ({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) })));
    const preparedSHA = await write('prepared.json', { schema: 1, bundleID: boot.bundleID, descriptorSha256: immutableFiles[0].sha256, immutableFiles });
    boot.migrationEvidence.clone = { preparedManifestPath: descriptor.preparedManifestPath, preparedManifestSha256: preparedSHA };
  };
  await seal(); return { root, boot, receipt, descriptor, clone, seal, write };
}

test('sealed clone origin verifies only B files; nonclone still requires its exact receipt identity', async () => {
  const f = await fixture();
  expect(await verifyNativeBootMigration(f.boot)).toEqual(f.receipt);
  const noClone = { ...f.boot, migrationEvidence: { path: f.boot.migrationEvidence.path, sha256: f.boot.migrationEvidence.sha256 } };
  await expect(verifyNativeBootMigration(noClone)).rejects.toThrow('native_migration_evidence_mismatch');
  expect(await verifyNativeBootMigration({ ...noClone, bundleID: f.receipt.bundleID, databasePath: f.receipt.databasePath })).toEqual(f.receipt);
});

test('changed receipt, sidecar and unsealed clone cannot change provenance', async () => {
  const f = await fixture();
  await f.write('sources/clone.json', { ...f.clone, migrationOrigin: { ...f.clone.migrationOrigin, bundleID: 'foreign' } });
  await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_clone_evidence_invalid');
  await f.seal(); await f.write('sources/migration.json', { ...f.receipt, bundleID: 'foreign' });
  await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_migration_evidence_invalid');
  await f.write('sources/migration.json', f.receipt); await f.write('sources/migration.json.source.json', { changed: true });
  await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_clone_evidence_invalid');
});

test('even sealed metadata cannot substitute target database, artifact, source or origin', async () => {
  const f = await fixture();
  f.clone.migrationOrigin = { ...f.clone.migrationOrigin, bundleID: 'foreign' }; await f.seal();
  await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_migration_evidence_mismatch');
  f.clone.migrationOrigin = { bundleID: f.receipt.bundleID, databasePath: f.receipt.databasePath };
  f.clone.compatibility.sourceBundleID = 'another-source'; await f.seal();
  await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_clone_evidence_invalid');
  f.clone.compatibility.sourceBundleID = f.descriptor.sourceBundleID; f.descriptor.launch.opencodeDatabasePath = path.join(f.root, 'other.db'); await f.seal();
  await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_clone_evidence_invalid');
  f.descriptor.launch.opencodeDatabasePath = f.boot.databasePath; await f.seal();
  await expect(verifyNativeBootMigration({ ...f.boot, manifestSha256: 'f'.repeat(64) })).rejects.toThrow('native_clone_evidence_invalid');
});

test('canonical filenames and no-symlink sealed reads refuse aliases', async () => {
  const f = await fixture();
  await expect(verifyNativeBootMigration({ ...f.boot, migrationEvidence: { ...f.boot.migrationEvidence,
    clone: { ...f.boot.migrationEvidence.clone, preparedManifestPath: f.root + '/sources/../prepared.json' } } })).rejects.toThrow('native_clone_evidence_invalid');
  const original = await fs.readFile(path.join(f.root, 'sources/clone.json'));
  await fs.writeFile(path.join(f.root, 'clone-alias.json'), original); await fs.unlink(path.join(f.root, 'sources/clone.json'));
  await fs.symlink(path.join(f.root, 'clone-alias.json'), path.join(f.root, 'sources/clone.json'));
  await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_clone_evidence_invalid');
  await fs.unlink(path.join(f.root,'sources/clone.json'));await fs.writeFile(path.join(f.root,'sources/clone.json'),original);
  await fs.rename(f.boot.migrationEvidence.path,path.join(f.root,'migration-alias.json'));
  await fs.symlink(path.join(f.root,'migration-alias.json'),f.boot.migrationEvidence.path);
  await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_clone_evidence_invalid');
});

test('sealed inventories between the boot-envelope and existing bundle-document limits remain valid', async () => {
  const f = await fixture();
  const sidecar = Buffer.from(JSON.stringify({inventory:'x'.repeat(4 * 1024 * 1024 + 1)}));
  await fs.writeFile(path.join(f.root,'sources/migration.json.source.json'),sidecar);
  f.receipt.sourceInventorySha256=hash(sidecar);
  f.boot.migrationEvidence.sha256=await f.write('sources/migration.json',f.receipt);
  await f.seal();
  expect(await verifyNativeBootMigration(f.boot)).toEqual(f.receipt);
});

test.each(['devryan.bundle.credential-owners/1','devryan.bundle.credential-owners/2'])('sealed boot recognizes exact %s shape without changing its original receipt',async protocol=>{
 const f=await fixture();f.clone.sourceHostOwners={protocol,sha256:'f'.repeat(64),accountDirectories:{}};await f.seal();
 expect(await verifyNativeBootMigration(f.boot)).toEqual(f.receipt);
});
test.each(['foreign','extra','malformed-account'])('sealed host-owner %s evidence remains refused',async kind=>{
 const f=await fixture();f.clone.sourceHostOwners={protocol:'devryan.bundle.credential-owners/2',sha256:'f'.repeat(64),accountDirectories:{}};
 if(kind==='foreign')f.clone.sourceHostOwners.protocol='devryan.bundle.credential-owners/3';
 else if(kind==='extra')f.clone.sourceHostOwners.extra=true;
 else f.clone.sourceHostOwners.accountDirectories={notHash:'f'.repeat(64)};
 await f.seal();await expect(verifyNativeBootMigration(f.boot)).rejects.toThrow('native_clone_evidence_invalid');
});
