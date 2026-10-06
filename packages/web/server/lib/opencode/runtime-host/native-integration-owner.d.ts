import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';
import type {NativeControllerProcess} from './native-process.js';
import type {NativeAdmissionOwner} from './native-admission-owner.js';
import type {NativeIntegrationOperation,NativeIntegrationAuthorizationOptions} from './native-integration-authorization.js';
import type {NativeCredentialOperation} from './native-process-protocol.js';
export interface NativeIntegrationOwnerOptions {
  readonly instanceID:string;readonly snapshot:NativeConfigurationSnapshot;readonly stateDirectory:string;
  readonly controller:()=>Pick<NativeControllerProcess,'instanceID'|'call'|'killAndWaitForExit'|'killAndWaitForTermination'>;
  readonly isReady:()=>boolean;readonly withMutationQueue:<A>(action:()=>A|Promise<A>)=>Promise<A>;
  readonly captureWebAuthorization:NativeIntegrationAuthorizationOptions['captureWebAuthorization'];
  readonly admissionOwner:Pick<NativeAdmissionOwner,'withProviderAttempt'|'withProviderResolution'|'withImageGeneration'>;
  readonly recordDiagnostic?:(input:Readonly<Record<string,unknown>>)=>void;
}
export function createNativeIntegrationOwner(options:NativeIntegrationOwnerOptions):{
  readonly getOpenAiOAuthCoordinator:()=>Pick<ReturnType<typeof import('../openai-oauth-coordinator.js').createOpenAiOAuthCoordinator>,'getBindingAsync'|'getAuthStateAsync'|'access'>;
  readonly handleRpc:(method:string,input:unknown,context?:{readonly signal?:AbortSignal})=>Promise<unknown>;
  readonly withImageGeneration:<A>(invocation:import('./native-admission-owner.js').NativeExecutionAuthorization,action:(owner:{
    readonly access:()=>Promise<import('./native-openai-auth.js').NativeOpenAiImageKey>;readonly recheck:()=>Promise<void>;
  })=>Promise<A>)=>Promise<A>;
  readonly withCallerOperation:<A>(operation:NativeIntegrationOperation,action:()=>Promise<A>)=>Promise<A>;
  readonly credentialOperation:(operation:NativeIntegrationOperation,mutation:NativeCredentialOperation)=>Promise<unknown>;
  readonly readOpenAiAccountSelection:(operation:NativeIntegrationOperation)=>Promise<import('./native-openai-auth.js').NativeOpenAiSelected|undefined>;
  readonly holdOpenAiSelection:(operation:NativeIntegrationOperation)=>Promise<(cleared:boolean)=>void>;
  readonly readOpenAiCredential:(operation:NativeIntegrationOperation,credentialID:string)=>Promise<unknown>;
  readonly readOpenAiSelected:(operation:NativeIntegrationOperation)=>Promise<import('./native-openai-auth.js').NativeOpenAiSelected|undefined>;
  readonly credentialMetadata:(operation:NativeIntegrationOperation)=>Promise<unknown>;
  readonly requestHeaders:()=>Record<string,string>;
  readonly markReady:()=>void;
  /** Close grants immediately; await queue settlement separately from process-exit callbacks. */
  readonly invalidate:()=>Promise<void>;
};
