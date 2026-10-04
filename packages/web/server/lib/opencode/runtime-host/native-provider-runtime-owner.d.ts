import type {CursorSdkRuntime} from '@openchamber/cursor-sdk-runtime';
import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';
import type {RegistrationOrigin} from './registration-origin.js';
import type {NativeProviderProcess,NativeProviderProcessOptions,NativeProviderExit} from './native-provider-process.js';
import type {NativeAdmissionOwner} from './native-admission-owner.js';
import type {NativeMeridianProfile,NativeProviderCredentialRequest,NativeProviderCredentialResult} from './native-provider-worker-protocol.js';
import type {ReviewedClaudeCredentialModule} from './reviewed-claude-host-credentials.js';
export interface NativeClaudeCredentialOptions {readonly profiles?:readonly NativeMeridianProfile[];readonly oauthTokenExpiries?:Readonly<Record<string,number>>;readonly asset?:{readonly path:string;readonly sha256:string};readonly policy?:'renew'|'access-only';readonly lifecycle?:import('./native-claude-lifecycle.js').ClaudeLifecycleClient;readonly loadModule?:()=>Promise<ReviewedClaudeCredentialModule>;readonly backend?:{readonly execFile?:(file:string,args:readonly string[],options:object)=>Promise<{stdout:string}>;readonly fetch?:typeof fetch}}
export function migrateNativeClaudeLegacyFences(options:NativeClaudeCredentialOptions&{readonly profiles:readonly NativeMeridianProfile[];readonly home:string;readonly lifecycle:import('./native-claude-lifecycle.js').ClaudeLifecycleClient},context:{readonly recheck:()=>Promise<void>;readonly signal?:AbortSignal}):Promise<{readonly observed:number;readonly adopted:number}>;
export function createNativeClaudeCredentialOwner(options:NativeClaudeCredentialOptions&{readonly profiles:readonly NativeMeridianProfile[];readonly home:string;readonly withMutationQueue:<A>(action:()=>Promise<A>)=>Promise<A>;readonly now?:()=>number}):<A=NativeProviderCredentialResult>(input:Pick<NativeProviderCredentialRequest,'profileID'|'purpose'|'failedFingerprint'>,context:{readonly recheck:()=>Promise<void>;readonly signal?:AbortSignal;readonly retried:Set<string>;readonly readOnly?:boolean},consume?:(value:NativeProviderCredentialResult)=>Promise<A>)=>Promise<A>;
export interface NativeProviderCatalogBinding {readonly directory:string;readonly controllerInstanceID:string;readonly integrationID:'github-copilot';readonly acquisitionID:string;readonly configurationDigest:string;readonly origin:{readonly id:string;readonly manifestDigest:string}}
export interface NativeProviderAttempt {readonly directory:string;readonly controllerInstanceID:string;readonly sessionID:string;readonly kind:'primary'|'title'|'compaction'|'generate';readonly permit:{readonly token:string;readonly sessionID?:string;readonly revision:number};readonly signal?:AbortSignal}
export interface NativeMeridianAttemptBinding {readonly attemptID:string;readonly directory:string;readonly controllerInstanceID:string;readonly sessionID:string}
export interface NativeMeridianAttempt extends NativeMeridianAttemptBinding {readonly origin:string;readonly authorization:string}
export interface NativeCatalogController {readonly instanceID:string;readonly call:(input:{readonly action:'provider-catalog-selection-owned'}&NativeProviderCatalogBinding)=>Promise<unknown>}
export interface NativeProviderRuntimeOptions {readonly instanceID:string;readonly snapshot:NativeConfigurationSnapshot;readonly registrationOrigin:RegistrationOrigin;readonly controller:()=>NativeCatalogController;readonly isReady:()=>boolean;readonly withMutationQueue:<A>(action:()=>Promise<A>)=>Promise<A>;readonly admissionOwner:Pick<NativeAdmissionOwner,'withProviderAttempt'>;readonly cursor?:CursorSdkRuntime;readonly meridian?:NativeProviderProcessOptions;readonly prepareMeridianProfiles?:(context:{readonly recheck:()=>Promise<void>;readonly signal:AbortSignal})=>Promise<readonly NativeMeridianProfile[]>;readonly claudeCredentials?:NativeClaudeCredentialOptions;readonly claudeSupported?:boolean;readonly fetchImpl?:typeof fetch}
export function createNativeProviderRuntimeOwner(options:NativeProviderRuntimeOptions):{
 readonly inspectClaude:(input:{readonly directory:string;readonly kind:'status'|'quota'},context:{readonly recheck:()=>Promise<void>;readonly signal?:AbortSignal})=>Promise<object>;
 readonly catalog:(input:NativeProviderCatalogBinding,context?:{readonly signal?:AbortSignal})=>Promise<readonly unknown[]|null>;
 readonly handleRpc:(method:string,input:unknown,context?:{readonly signal?:AbortSignal})=>Promise<unknown>;
 readonly withMeridian:<A>(input:NativeProviderAttempt,action:(input:{readonly origin:string;readonly health:'healthy'|'degraded';readonly instanceID:string;readonly authorization:string;readonly authorizeAttempt:NativeProviderProcess['authorizeAttempt'];readonly releaseAttempt:NativeProviderProcess['releaseAttempt']})=>Promise<A>)=>Promise<A>;
 readonly beginMeridian:(input:Omit<NativeProviderAttempt,'signal'>,context?:{readonly signal?:AbortSignal})=>Promise<NativeMeridianAttempt>;
 readonly assertMeridian:(input:NativeMeridianAttemptBinding)=>Promise<void>;
 readonly endMeridian:(input:NativeMeridianAttemptBinding)=>Promise<null>;
 readonly cursorPrompt:(input:NativeProviderAttempt,body:Record<string,unknown>)=>ReturnType<CursorSdkRuntime['handlePromptAsync']>;
 readonly abortCursor:(sessionID:string)=>ReturnType<CursorSdkRuntime['abortAndWait']>;
 readonly close:()=>Promise<NativeProviderExit|undefined>;
};

export function runNativeClaudeCredentialCommand(file:string,args:readonly string[],options:{readonly signal?:AbortSignal;readonly timeout?:number}):Promise<{stdout:string}>;
