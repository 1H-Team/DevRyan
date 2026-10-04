import type {SessionEvent} from '@opencode/schema/session-event';
import type {PrimaryRecoveryHost} from '@openchamber/harness-runtime';
import type {OperationPermit} from './native-admission-contract.js';
import type {NativeAdmissionOwner} from './native-admission-owner.js';
import type {NativeAttemptIdentity} from './native-observation.js';

/** Exact original private permit token, hashed only at the Node owner boundary. */
export function nativeStepPermitSha256(permit:Pick<OperationPermit,'token'>):string;
export function createNativePrimaryStepOwner(options:{
 readonly instanceID:string;
 readonly getInstanceID?:()=>string|undefined;
 /** Verified selected native artifact supports the finite Stop disposition. */
 readonly allowStopHandoff?:boolean;
 readonly admissionOwner:Pick<NativeAdmissionOwner,'handleRpc'|'acknowledgeStartedContinuation'>;
 readonly openCodeClient:{readonly sessions:{
  readonly get:(sessionID:string)=>Promise<unknown>;
  readonly message:(sessionID:string,messageID:string,options:{directory:string})=>Promise<unknown>;
 }};
 readonly primaryRuntime:Pick<PrimaryRecoveryHost,'readRecord'|'helloNative'|'plugin'|'adoptOwnedNativeContinuation'>;
}):{
 (input:{readonly permit:OperationPermit;readonly event:typeof SessionEvent.Step.Started.Type;readonly attempt?:NativeAttemptIdentity|null}):Promise<{tracked:boolean;stop?:{readonly sessionID:string;readonly assistantMessageID:string}}>;
 readonly external:(scope:{readonly sessionID:string;readonly userMessageID:string;readonly assistantMessageID:string;readonly agent:string;readonly modelID:string},recheck:()=>Promise<void>)=>Promise<{tracked:boolean}>;
};
