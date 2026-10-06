import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import type { ProjectMapping } from './bundle-migration-inventory.js';
import type { VerifiedBundleContinuation } from './bundle-owned-continuations.js';
export interface BundleHarnessRef { readonly directory: string; readonly ref: string; readonly oid: string }
export interface BundleHarnessInventory {readonly refs:readonly BundleHarnessRef[];readonly sessionReferences:readonly string[];readonly messageReferences:readonly string[]}
export interface BundleHarnessFileOperations {readJSON(file:string):Promise<unknown>;saveJSON(file:string,value:unknown):Promise<string>;readEnvelope(file:string):Promise<Buffer>;deleteFile(file:string):Promise<void>;renameDirectory(source:string,target:string):Promise<void>;deferObjectDurability(directory:string):Promise<void>}
export interface BundleHarnessOptions {
  readonly windowsOwner?:WindowsPrivateFileOwner;readonly windowsLedgerOwner?:WindowsPrivateFileOwner;
  readonly gitRunner?:{git:typeof import('../../../../../harness-runtime/lib/session-changes-git.js').git;gitTokens:typeof import('../../../../../harness-runtime/lib/session-changes-git.js').gitTokens;gitRecords:typeof import('../../../../../harness-runtime/lib/session-changes-git.js').gitRecords};
  readonly nativeFiles?:BundleHarnessFileOperations;
  readonly runWindowsInspection?:(options:Omit<BundleHarnessOptions,'windowsOwner'|'windowsLedgerOwner'|'gitRunner'|'nativeFiles'|'runWindowsInspection'>)=>Promise<BundleHarnessInventory>;
  readonly projectMap?: readonly ProjectMapping[]; readonly relocate?: boolean; readonly checkpointID?: string;
  readonly sessionIDs?: readonly string[]; readonly messageIDs?: readonly string[]; readonly sourceWebDataDirectory?: string;
  readonly preservedRefs?: { readonly checkpointID: string; readonly refs: readonly BundleHarnessRef[] };
  readonly verifiedContinuations?: readonly VerifiedBundleContinuation[];
}
export function inspectBundleHarness(webDataDirectory:string,options?:BundleHarnessOptions):Promise<BundleHarnessInventory>;
