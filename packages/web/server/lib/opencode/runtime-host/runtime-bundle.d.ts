import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import type { MigrationRequest, MigrationReceipt, NativeGlobalRoots } from './native-process-protocol.js';
import type { ProjectMapping } from './bundle-migration-inventory.js';
export interface RuntimeBundleLaunch {
  readonly controllerBinary: string; readonly writerBinary: string;
  readonly artifactManifestPath: string; readonly artifactManifestSha256: string;
  readonly opencodeDatabasePath: string; readonly webDataDirectory: string;
  readonly webConfigDirectory: string; readonly opencodeConfigDirectory: string;
  readonly global: NativeGlobalRoots;
  readonly reviewedNativeConfigPath: string; readonly reviewedPluginManifestPath: string;
}
export interface RuntimeBundleCheckpoint {
  readonly checkpointID: string; readonly ownerID: string; readonly generation: 1 | 2;
  readonly databasePath: string; readonly webDataDirectory: string;
  readonly webConfigDirectory: string; readonly opencodeConfigDirectory: string; readonly settledAt: number;
}
export interface RuntimeBundleCheckpointScope {readonly assertHeld:()=>Promise<void>;readonly settlement?:import('./bundle-rollback-intent.js').RollbackSettlement}
export interface RuntimeBundleDescriptor {
  readonly schema: 1; readonly bundleID: string; readonly generation: 2; readonly createdAt: number;
  readonly sourceBundleID?: string; readonly checkpoint: RuntimeBundleCheckpoint;
  readonly launch: RuntimeBundleLaunch; readonly projectMap: readonly ProjectMapping[];
  readonly preparedManifestPath: string; readonly migrationReceiptPath?: string;
}
export interface LegacyRuntimeImportSource {
  readonly opencodeDatabasePath:string; readonly webDataDirectory:string; readonly webConfigDirectory:string;
  readonly opencodeConfigDirectory:string; readonly global:{readonly home:string};
}
export type RuntimeBundleSource = { readonly kind: 'legacy'; readonly launch: LegacyRuntimeImportSource } | { readonly kind: 'bundle'; readonly bundleID: string };
export interface RuntimeBundleArtifacts {
  readonly controllerBinary: string; readonly writerBinary: string;
  readonly artifactManifestPath: string; readonly artifactManifestSha256: string;
  readonly reviewedNativeConfigPath: string; readonly reviewedPluginManifestPath: string;
}
export interface PrepareRuntimeBundle {
  readonly bundleID: string; readonly generation: 2; readonly source: RuntimeBundleSource;
  readonly projectMap: readonly ProjectMapping[];
  readonly auxiliary: MigrationRequest['auxiliary']; readonly launchArtifacts: RuntimeBundleArtifacts;
}
export interface RuntimeBundleSelection {
  readonly schema: 1; readonly revision: number; readonly selectedBundleID: string;
  readonly previousBundleID: string | null; readonly transition: 'activate' | 'rollback'; readonly reconciliationRequired: boolean;
  readonly preparedManifestSha256: string;
}
export interface RuntimeBundleVerification { readonly descriptor: RuntimeBundleDescriptor; readonly phase: 'prepared' | 'resume'; readonly integrity: 'verified'; readonly admission: 'held' }
export interface RuntimeBundleStoreOptions {
  readonly controlRoot: string;
  readonly windowsOwner?:WindowsPrivateFileOwner;
  readonly windowsLedgerOwner?:WindowsPrivateFileOwner;
  readonly windowsLauncher?:string;
  /** Private native owner installs the reconstructed epoch fence before launching/opening the controller. */
  readonly allowRecoveredInputStartup?:boolean;
  /** Host-owned admission close, native/OS/ACK settlement and matching store flush span. Never supplied by RPC. */
  readonly withQuiescedSource: <A>(source: RuntimeBundleSource, action: (checkpoint: RuntimeBundleCheckpoint,scope?:RuntimeBundleCheckpointScope) => Promise<A>) => Promise<A>;
  readonly runMigration: (request: MigrationRequest) => Promise<MigrationReceipt>;
  /** Constructor-owned verification result; new V2 clones require its compiled capability. Void remains valid only for non-clone fixture paths. */
  readonly verifyArtifacts?: (input: { readonly generation: 2; readonly launch: RuntimeBundleArtifacts }) => Promise<void | { readonly manifest: { readonly compiledContracts?: readonly string[] } }>;
  readonly verifyV2Compatibility?: (input:{readonly source:RuntimeBundleDescriptor;readonly artifacts:RuntimeBundleArtifacts})=>Promise<{readonly status:'compatible';readonly binding:{readonly protocol:'devryan-v2-clone/1';readonly sourceBundleID:string;readonly sourceManifestSha256:string;readonly targetManifestSha256:string}}|{readonly status:'blocked'}>;
  /** Captured/drained by the original credential owner before source shutdown;
   * private snapshots never enter bundle manifests, only their exact hashes. */
  readonly captureCredentials?: (input:{readonly descriptor:RuntimeBundleDescriptor;readonly checkpoint:RuntimeBundleCheckpoint;readonly assertHeld:()=>Promise<void>})=>Promise<Extract<import('./native-bundle-credential-process.js').NativeBundleCredentialResult,{status:'captured'}>>;
  readonly reconcileRollback?: (input: { readonly candidate: RuntimeBundleDescriptor; readonly target: RuntimeBundleDescriptor;readonly credentialBinding:import('./native-bundle-credentials.js').NativeBundleCredentialBinding;readonly assertHeld:()=>Promise<void> }) => Promise<{ readonly status: 'reconciled';readonly credentialReceipt:Extract<import('./native-bundle-credential-process.js').NativeBundleCredentialResult,{status:'projected'}> } | { readonly status: 'blocked'; readonly reason: string }>;
  readonly readProcessIdentity?:(pid:number)=>{readonly pid:number;readonly startIdentity:string}|null;
  readonly now?: () => number;
}
export function createRuntimeBundleStore(options: RuntimeBundleStoreOptions): {
  prepare(input: PrepareRuntimeBundle): Promise<RuntimeBundleDescriptor>;
  verify(input: { readonly bundleID: string; readonly phase: 'prepared' | 'resume' }): Promise<RuntimeBundleVerification>;
  resume(input:{readonly expectedRevision:number}):Promise<RuntimeBundleSelection>;
  readSelected(): Promise<{ readonly selection: RuntimeBundleSelection; readonly descriptor: RuntimeBundleDescriptor } | null>;
  /** Lifecycle stops/recomposes all owners; this does not open admission. */
  select(input: { readonly bundleID: string; readonly expectedRevision: number }): Promise<RuntimeBundleSelection>;
  /** Static incompatibility keeps B active. A checkpointed partial projection is held for Resume B recovery. */
  rollback(input: { readonly targetBundleID: string; readonly expectedRevision: number }): Promise<{ readonly selection: RuntimeBundleSelection; readonly admission: 'held'; readonly reason: string | null }>;
};
export function readRuntimeBundleDescriptor(controlRoot: string, bundleID: string, options?:Pick<RuntimeBundleStoreOptions,'windowsOwner'>): Promise<RuntimeBundleDescriptor>;
