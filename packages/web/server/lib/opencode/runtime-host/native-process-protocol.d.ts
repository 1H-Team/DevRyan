import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';
import type { NativeOpenAiSelected } from './native-openai-auth.js';
import type { Credential } from '@opencode/core/credential';
import type { NativeProviderCatalogBinding } from './native-provider-runtime-owner.js';
export const NATIVE_PROCESS_PROTOCOL: 1;
export const NATIVE_PROCESS_LIMITS: Readonly<{bootBytes:number;messageBytes:number;recordBytes:number;inFlight:number}>;
export interface NativeGlobalRoots { readonly home:string;readonly config:string;readonly data:string;readonly state:string;readonly cache:string;readonly bin:string;readonly log:string;readonly repos:string;readonly tmp:string }
export interface NativeLocationRoots { readonly directory:string;readonly readRoots:readonly string[];readonly protectedRoots:readonly string[] }
export interface NativeCatalogSelection {
 readonly source:{readonly kind:'model'|'agent'|'backup'|'command'|'councillor'|'slim-route'|'slim-fallback'|'requirement';readonly id?:string;readonly index?:number};
 readonly providerID:string;readonly modelID:string;readonly variant:string|null;
}
export interface NativeCatalogAvailability {readonly selections:readonly (NativeCatalogSelection & {readonly directory:string;readonly status:'available'|'unavailable'|'unknown';readonly reason:null|'provider_missing'|'model_missing'|'variant_missing'|'catalog_unavailable'})[]}
export interface NativeCatalogRequirements { readonly selections?:readonly NativeCatalogSelection[];readonly agents:readonly string[];readonly plugins:readonly string[];readonly tools:readonly string[];readonly models:readonly {readonly providerID:string;readonly id:string;readonly variant?:string}[] }
export interface NativeCursorCatalog { readonly id:'cursor-acp';readonly models:readonly {readonly id:string;readonly variants:readonly string[]}[] }
export interface NativeReviewedPlugin { readonly id:string;readonly manifestDigest:string;readonly capabilities:readonly ('read'|'write'|'process'|'network'|'managed-task'|'control'|'provider')[] }
export interface NativeSetupCredentialAck {readonly status:'applied'|'already-applied'|'absent';readonly count:number;readonly sha256:string|null}
export interface NativeProcessBoot {readonly setupCredentialSeed?:{readonly sha256:string;readonly count:number}|null; readonly protocol:1;readonly type:'boot';readonly bundleID:string;readonly instanceID:string;readonly buildId:string;readonly manifestSha256:string;readonly databasePath:string;readonly globals:NativeGlobalRoots;readonly directory:string;readonly locations:readonly NativeLocationRoots[];readonly bridge:{readonly url:string;readonly token:string};readonly httpToken:string;readonly configuration:unknown;readonly configurationSnapshot?:NativeConfigurationSnapshot;readonly reviewedPlugins:readonly NativeReviewedPlugin[];readonly migrationEvidence:{readonly path:string;readonly sha256:string;readonly clone?:{readonly preparedManifestPath:string;readonly preparedManifestSha256:string}};readonly catalogRequirements:NativeCatalogRequirements;readonly cursorCatalog?:NativeCursorCatalog;readonly recoveredSessionIDs?:readonly string[] }
export interface NativeWirePermit { readonly token:string;readonly sessionID?:string;readonly revision:number }
export type NativeCredentialOperation =
  {readonly operation:'create';readonly input:Omit<Parameters<Credential.Interface['create']>[0],'value'> & {readonly value:{readonly type:'key';readonly key:string}}} |
  {readonly operation:'update';readonly id:Credential.ID;readonly updates:{readonly label:string}} |
  {readonly operation:'activate'|'remove';readonly id:Credential.ID};
export type NativeInterviewAction = {readonly kind:'rename';readonly body:{readonly sessionID:string;readonly title:string}}
  |{readonly kind:'notify';readonly body:{readonly sessionID:string;readonly id:string;readonly text:string;readonly resume:false}}
  |{readonly kind:'continue';readonly body:{readonly sessionID:string;readonly id:string;readonly text:string}};
export type NativeProcessCommand = {readonly protocol:1;readonly id:string} & (
  {readonly action:'open'|'open-recovery'|'close-startup'|'quiesce'|'close'} |
  {readonly action:'hold'|'release';readonly sessionID:string} |
  {readonly action:'wake-owned'|'wake-deferred-owned';readonly sessionID:string;readonly permit:NativeWirePermit} |
  {readonly action:'acquire-retention-owned';readonly sessionID:string;readonly permit:NativeWirePermit} |
  {readonly action:'archive-retention-owned';readonly sessionID:string;readonly permit:NativeWirePermit;readonly at:number} |
  {readonly action:'queued-primary-idle-owned';readonly sessionID:string;readonly messageID?:string;readonly permit:NativeWirePermit} |
  {readonly action:'inspect-removal-owned';readonly sessionID:string;readonly permit:NativeWirePermit} |
  {readonly action:'remove-leaf-owned';readonly intentID:string;readonly sessionID:string;readonly permit:NativeWirePermit} |
  {readonly action:'credential-commit-owned';readonly callID:string;readonly controllerInstanceID:string;readonly bindingFingerprint:string} |
  {readonly action:'credential-operation-owned';readonly directory:string;readonly controllerInstanceID:string;readonly requestAuthorization:string;readonly mutation:NativeCredentialOperation} |
  {readonly action:'credential-metadata-owned';readonly directory:string;readonly controllerInstanceID:string;readonly integrationID:string} |
  {readonly action:'claude-lifecycle-read-owned';readonly controllerInstanceID:string} |
  {readonly action:'claude-lifecycle-transition-owned';readonly controllerInstanceID:string;readonly expectedRevision:number;readonly operation:import('./native-claude-lifecycle.js').ClaudeLifecycleOperation} |
  ({readonly action:'provider-catalog-selection-owned'} & NativeProviderCatalogBinding) |
  {readonly action:'openai-read-credential-owned';readonly directory:string;readonly controllerInstanceID:string;readonly credentialID:string} |
  {readonly action:'openai-read-selected-owned';readonly directory:string;readonly controllerInstanceID:string} |
  {readonly action:'openai-cas-selected-owned';readonly directory:string;readonly controllerInstanceID:string;readonly expected:NativeOpenAiSelected;readonly next:Credential.OAuth} |
  {readonly action:'reconcile-shell-owned'|'reconcile-primary-owned';readonly sessionID:string;readonly messageID:string;readonly permit:NativeWirePermit} |
  {readonly action:'cancel-recovered-input-owned';readonly sessionID:string;readonly messageID:string;readonly payloadHash:string;readonly enqueuedSeq:number;readonly cancellationReceiptVersion:1;readonly permit:NativeWirePermit} |
  ({readonly action:'interview-action-owned';readonly sessionID:string;readonly permit:NativeWirePermit}&NativeInterviewAction) |
  ({readonly action:'cursor-record-owned'}&import('./native-cursor-owner.js').NativeCursorRecord) |
  ({readonly action:'cursor-settle-owned'}&import('./native-cursor-owner.js').NativeCursorSettlement) |
  ({readonly action:'cursor-key-owned'}&import('./native-cursor-owner.js').NativeCursorSettlement) |
  ({readonly action:'cursor-readonly-key-owned'}&import('./native-cursor-owner.js').NativeCursorReadOnlyKey) |
  {readonly action:'recover-shell-owned';readonly sessionID:string;readonly jobID:string});
export type NativeProcessReply = {readonly protocol:1;readonly type:'bound';readonly setupCredentialSeed?:NativeSetupCredentialAck;readonly bundleID:string;readonly instanceID:string;readonly url:string;readonly port:number;readonly buildId:string;readonly catalog:{readonly asserted:boolean;readonly missing?:NativeCatalogRequirements;readonly availability?:NativeCatalogAvailability};readonly migration:{readonly v1:'completed'|'not-needed'}} |
  {readonly protocol:1;readonly id:string;readonly ok:true;readonly result?:unknown} |
  {readonly protocol:1;readonly id:string;readonly ok:false;readonly error:{readonly code:string;readonly status:number;readonly message:string}};
export function parseNativeBoot(value:unknown):NativeProcessBoot;
export function parseNativeCommand(value:unknown):NativeProcessCommand;
export function parseNativeReply(value:unknown):NativeProcessReply;
export function encodeNativeProcessMessage(value:unknown):string;
export interface MigrationRequest {readonly protocol:'devryan-native-migration/1';readonly requestID:string;readonly bundleID:string;readonly candidateDatabasePath:string;readonly isolatedRoot:string;readonly receiptPath:string;readonly auxiliary:{readonly kind:'absent'}|{readonly kind:'copy';readonly databasePath:string;readonly sha256:string};readonly projectMap:readonly {readonly sourceDirectory:string;readonly targetDirectory:string;readonly mode:'identity'|'synthetic-copy'}[]}
export interface MigrationReceipt {readonly protocol:'devryan-native-migration/1';readonly requestID:string;readonly bundleID:string;readonly databasePath:string;readonly status:'completed';readonly nativeVersion:'2.0.20'|'2.0.24';readonly marker:'completed'|'not-needed';readonly sourceInventorySha256:string;readonly verificationSha256:string}
export function parseNativeMigrationRequest(value:unknown):MigrationRequest;
export function parseNativeMigrationReceipt(value:unknown):MigrationReceipt;

export interface NativeAssetRequest {readonly protocol:1;readonly type:'verify-assets';readonly globals:NativeGlobalRoots;readonly verificationRoot:string}
export function parseNativeAssetRequest(value:unknown):NativeAssetRequest;

export const NATIVE_HARNESS_LIMITS:Readonly<{requestBytes:number;resultBytes:number}>;
export interface NativeHarnessRequest {
 readonly protocol:'devryan-native-harness-relocation/1';readonly requestID:string;readonly webDataDirectory:string;readonly sourceWebDataDirectory:string;
 readonly checkpointID:string;readonly projectMap:readonly import('./bundle-migration-inventory.js').ProjectMapping[];readonly relocate:boolean;
 readonly sessionIDs?:readonly string[];readonly messageIDs?:readonly string[];
 readonly preservedRefs?:{readonly checkpointID:string;readonly refs:readonly import('./bundle-harness-integrity.js').BundleHarnessRef[]};
 readonly verifiedContinuations?:readonly import('./bundle-owned-continuations.js').VerifiedBundleContinuation[];
}
export interface NativeHarnessResult {readonly protocol:'devryan-native-harness-relocation/1';readonly requestID:string;readonly status:'relocated'|'inspected';readonly harness:import('./bundle-harness-integrity.js').BundleHarnessInventory}
export function parseNativeHarnessRequest(value:unknown):NativeHarnessRequest;
export function parseNativeHarnessResult(value:unknown,request:NativeHarnessRequest):NativeHarnessResult;
