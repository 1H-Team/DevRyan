import type { CredentialMutationBinding } from './credential-mutation-contract.js';
export type NativeIntegrationBinding = {
  readonly directory: string; readonly controllerInstanceID: string; readonly integrationID: string;
  readonly acquisitionID: string; readonly configurationDigest: string;
} & ({readonly kind:'mcp';readonly server:string;readonly methodID:string}
  | {readonly kind:'openai';readonly methodID?:'chatgpt-browser'|'chatgpt-headless'}
  | {readonly kind:'cursor';readonly methodID?:never}
  | {readonly kind:'provider';readonly integrationID:'xai'|'opencode'|'opencode-go';readonly methodID?:'device'});
export interface NativeIntegrationOperation {
  readonly kind:'mcp'|'openai'|'cursor'|'provider';readonly directory:string;readonly configurationDigest:string;
  readonly server?:string;readonly integrationID?:string;readonly operation:string;
  readonly method:'GET'|'POST'|'PATCH'|'DELETE';readonly path:string;readonly body?:unknown;
  readonly methodID?:string;readonly attemptID?:string;readonly credentialID?:string;
  readonly valueType?:'key'|'oauth';readonly expectedFingerprint?:string;readonly requestedFingerprint?:string;
}
export interface NativeIntegrationAuthorizationOptions {
  readonly controllerIdentity:()=>string|undefined;
  readonly verifyBinding:(binding:NativeIntegrationBinding)=>Promise<void>;
  readonly captureWebAuthorization:(operation:NativeIntegrationOperation)=>Promise<()=>Promise<void>|void>;
  readonly authorizeConfiguredConnection:(binding:NativeIntegrationBinding)=>Promise<void>;
  readonly limit?:number;
}
export function createNativeIntegrationAuthorization(options:NativeIntegrationAuthorizationOptions):{
  withCallerOperation<A>(operation:NativeIntegrationOperation,action:()=>Promise<A>):Promise<A>;
  requestHeaders():Record<string,string>;
  capture(input:{binding:NativeIntegrationBinding | (NativeIntegrationBinding & CredentialMutationBinding);operation:'oauth'|'connection'|'mutation'|'remove';requestAuthorization?:string}):Promise<{authorizationID:string}>;
  reauthorize(input:{authorizationID:string;binding:NativeIntegrationBinding}):Promise<void>;
  resolveMutation(input:{authorizationID:string;binding:CredentialMutationBinding}):Promise<{reauthorize:()=>Promise<void>|void}>;
  authorizeControl(input:{binding:NativeIntegrationBinding;operation:string;requestAuthorization?:string}):Promise<void>;
  close():void;
};
