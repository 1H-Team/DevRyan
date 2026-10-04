import type { ProjectMapping } from './bundle-migration-inventory.js';
import type { VerifiedBundleContinuation } from './bundle-owned-continuations.js';
export interface BundleHarnessRef { readonly directory: string; readonly ref: string; readonly oid: string }
export function inspectBundleHarness(webDataDirectory: string, options?: {
  readonly projectMap?: readonly ProjectMapping[]; readonly relocate?: boolean; readonly checkpointID?: string;
  readonly sessionIDs?: readonly string[]; readonly messageIDs?: readonly string[]; readonly sourceWebDataDirectory?: string;
  readonly preservedRefs?: { readonly checkpointID: string; readonly refs: readonly BundleHarnessRef[] };
  readonly verifiedContinuations?: readonly VerifiedBundleContinuation[];
}): Promise<{ readonly refs: readonly BundleHarnessRef[]; readonly sessionReferences: readonly string[]; readonly messageReferences: readonly string[] }>;
