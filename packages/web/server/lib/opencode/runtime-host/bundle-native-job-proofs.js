import path from 'node:path';
import {
  MANAGED_NATIVE_JOB_PROOF_DIRECTORY,
  MANAGED_NATIVE_JOB_PROOF_SHARDS,
  decodeManagedNativeJobProofShard,
  managedNativeJobProofShardFile,
} from '../../../../../orchestration-runtime/native-job-proof-store.js';
import { bundleFailure } from './bundle-migration-inventory.js';

/** Fixed shard paths of the released native-job proofs beside a bundle's ledger. */
export const bundleNativeJobProofShardFiles = webDataDirectory => MANAGED_NATIVE_JOB_PROOF_SHARDS.map(shard => ({
  shard, file: path.join(webDataDirectory, 'orchestration', MANAGED_NATIVE_JOB_PROOF_DIRECTORY, managedNativeJobProofShardFile(shard)),
}));

/**
 * Reads every proof shard through the caller's bounded document reader (which
 * carries the Windows owner). Each shard decodes whole with the core codec; a
 * malformed or invalid shard refuses, an absent one is empty. The scheduler
 * resolves a task held by both stores to the main ledger, so callers skip a
 * proof whose task the ledger still lists.
 */
export async function readBundleNativeJobProofs(webDataDirectory, readJSON) {
  const shards = [];
  for (const { shard, file } of bundleNativeJobProofShardFiles(webDataDirectory)) {
    let document;
    try { document = await readJSON(file); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (error instanceof SyntaxError) throw bundleFailure('bundle_native_job_proof_invalid');
      throw error;
    }
    let proofs;
    try { proofs = decodeManagedNativeJobProofShard(document, shard); } catch { throw bundleFailure('bundle_native_job_proof_invalid'); }
    shards.push({ shard, file, document, proofs });
  }
  return shards;
}
