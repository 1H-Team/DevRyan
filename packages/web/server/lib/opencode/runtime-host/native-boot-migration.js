import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NATIVE_PROCESS_LIMITS, parseNativeMigrationReceipt } from './native-process-protocol.js';
import {BUNDLE_DOCUMENT_MAX_BYTES} from './bundle-document-limits.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => new Error('native_clone_evidence_invalid');
async function readCanonical(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maxBytes || await fs.realpath(file) !== file) throw fail();
  const bytes = await fs.readFile(file);
  if (bytes.length > maxBytes) throw fail();
  return bytes;
}

/** The selected bundle verifier has already checked these immutable files.
 * The controller independently binds their pinned bytes to this B launch. */
async function cloneOrigin(boot) {
  const proof = boot.migrationEvidence.clone;
  const root = path.dirname(path.dirname(boot.migrationEvidence.path));
  if (boot.migrationEvidence.path !== path.join(root, 'sources/migration.json')
    || proof.preparedManifestPath !== path.join(root, 'prepared.json')
    || boot.databasePath !== path.join(root, 'opencode/opencode.db')) throw fail();
  const preparedBytes = await readCanonical(proof.preparedManifestPath, BUNDLE_DOCUMENT_MAX_BYTES);
  if (hash(preparedBytes) !== proof.preparedManifestSha256) throw fail();
  const prepared = JSON.parse(preparedBytes.toString('utf8'));
  if (!record(prepared) || prepared.schema !== 1 || prepared.bundleID !== boot.bundleID || !digest(prepared.descriptorSha256)
    || !Array.isArray(prepared.immutableFiles)) throw fail();
  const rows = new Map();
  for (const row of prepared.immutableFiles) {
    if (!exact(row, ['path', 'sha256']) || typeof row.path !== 'string' || !digest(row.sha256) || rows.has(row.path)) throw fail();
    rows.set(row.path, row.sha256);
  }
  const readSealed = async file => {
    const bytes = await readCanonical(path.join(root, file), BUNDLE_DOCUMENT_MAX_BYTES);
    if (!rows.has(file) || hash(bytes) !== rows.get(file)) throw fail();
    return JSON.parse(bytes.toString('utf8'));
  };
  if (rows.get('descriptor.json') !== prepared.descriptorSha256 || rows.get('sources/migration.json') !== boot.migrationEvidence.sha256) throw fail();
  const descriptor = await readSealed('descriptor.json');
  if (!record(descriptor) || descriptor.schema !== 1 || descriptor.generation !== 2 || descriptor.bundleID !== boot.bundleID
    || typeof descriptor.sourceBundleID !== 'string' || !descriptor.sourceBundleID || !record(descriptor.launch)
    || descriptor.launch.opencodeDatabasePath !== boot.databasePath || descriptor.launch.artifactManifestSha256 !== boot.manifestSha256
    || descriptor.preparedManifestPath !== proof.preparedManifestPath || descriptor.migrationReceiptPath !== boot.migrationEvidence.path) throw fail();
  const clone = await readSealed('sources/clone.json');
  if (!exact(clone, ['schema', 'sourceBundleID', 'compatibility', 'sourceCredentialSha256', 'sourceDescriptorSha256', 'sourcePreparedManifestSha256', 'migrationOrigin',
      ...(Object.hasOwn(clone,'sourceHostOwners')?['sourceHostOwners']:[])])
    || clone.schema !== 1 || clone.sourceBundleID !== descriptor.sourceBundleID
    || ![clone.sourceCredentialSha256, clone.sourceDescriptorSha256, clone.sourcePreparedManifestSha256].every(digest)
    || !exact(clone.compatibility, ['protocol', 'sourceBundleID', 'sourceManifestSha256', 'targetManifestSha256'])
    || clone.compatibility.protocol !== 'devryan-v2-clone/1' || clone.compatibility.sourceBundleID !== descriptor.sourceBundleID
    || !digest(clone.compatibility.sourceManifestSha256) || clone.compatibility.targetManifestSha256 !== boot.manifestSha256
    || !exact(clone.migrationOrigin, ['bundleID', 'databasePath']) || typeof clone.migrationOrigin.bundleID !== 'string' || !clone.migrationOrigin.bundleID
    || typeof clone.migrationOrigin.databasePath !== 'string' || !path.isAbsolute(clone.migrationOrigin.databasePath)) throw fail();
  if(clone.sourceHostOwners!==undefined){
    const owners=clone.sourceHostOwners;
    if(!exact(owners,['protocol','sha256','accountDirectories'])||!['devryan.bundle.credential-owners/1','devryan.bundle.credential-owners/2'].includes(owners.protocol)||!digest(owners.sha256)
      ||!owners.accountDirectories||typeof owners.accountDirectories!=='object'||Array.isArray(owners.accountDirectories)
      ||Object.keys(owners.accountDirectories).length>64||Object.entries(owners.accountDirectories).some(([id,sha])=>!digest(id)||!digest(sha)))throw fail();
  }
  for (const suffix of ['.source.json', '.verification.json']) {
    const file = 'sources/migration.json' + suffix;
    const bytes = await readCanonical(path.join(root, file), BUNDLE_DOCUMENT_MAX_BYTES);
    if (!rows.has(file) || hash(bytes) !== rows.get(file)) throw fail();
  }
  return clone.migrationOrigin;
}

/** Original controller receipt validation, shared with the host composition tests. */
export async function verifyNativeBootMigration(boot) {
  const bytes = await readCanonical(boot.migrationEvidence.path, NATIVE_PROCESS_LIMITS.messageBytes);
  if (bytes.length > NATIVE_PROCESS_LIMITS.messageBytes || hash(bytes) !== boot.migrationEvidence.sha256) throw new Error('native_migration_evidence_invalid');
  const migration = parseNativeMigrationReceipt(JSON.parse(bytes.toString('utf8')));
  const origin = boot.migrationEvidence.clone ? await cloneOrigin(boot) : boot;
  if (migration.bundleID !== origin.bundleID || migration.databasePath !== origin.databasePath) throw new Error('native_migration_evidence_mismatch');
  for (const [suffix, digest] of [['.source.json', migration.sourceInventorySha256], ['.verification.json', migration.verificationSha256]]) {
    if (hash(await fs.readFile(boot.migrationEvidence.path + suffix)) !== digest) throw new Error('native_migration_inventory_invalid');
  }
  return migration;
}
