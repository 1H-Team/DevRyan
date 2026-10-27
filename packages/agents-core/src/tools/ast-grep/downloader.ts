// DevRyan: ast-grep is the manifest-verified executable bound by the confined
// worker (devryan/owners.ts). It is never downloaded, cached or searched for.
import { requireReviewedAstGrepAsset } from '../../devryan/owners';

export async function ensureAstGrepBinary(): Promise<string> {
  return requireReviewedAstGrepAsset();
}
