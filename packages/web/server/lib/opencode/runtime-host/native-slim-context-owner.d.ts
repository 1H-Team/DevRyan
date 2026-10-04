import type * as ReviewedSlim from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import type {createManagedTaskScheduler} from '@openchamber/orchestration-runtime';
import type {PrimaryRecoveryHost} from '@openchamber/harness-runtime';
import type {OperationPermit} from './native-admission-contract.js';
export interface NativeSlimContextInput {readonly permit:OperationPermit;readonly directory:string;readonly sessionID:string;readonly phase:'context';readonly messages:readonly unknown[]}
export interface NativeSlimRetryInput {readonly permit:OperationPermit;readonly attempt?:import('./native-observation.js').NativeAttemptIdentity;readonly directory:string;readonly sessionID:string;readonly phase:'retry';readonly event:{readonly sessionID:string;readonly agent:string;readonly model:{readonly providerID:string;readonly id:string};readonly error:unknown;readonly attempt:number;readonly decision:import('@opencode/plugin/effect/session').SessionRetryDecision}}
export function createNativeSlimContextOwner(options:{
 readonly admissionOwner:{readonly captureSessionHookAuthorization:(input:NativeSlimContextInput|NativeSlimRetryInput)=>Promise<()=>Promise<void>>};
 readonly openCodeClient:{readonly sessions:{
  readonly get:(sessionID:string,options:{directory:string})=>Promise<unknown>;
  readonly message:(sessionID:string,messageID:string,options:{directory:string;signal?:AbortSignal;timeoutMs:number;maxResponseBytes:number})=>Promise<unknown>;
  readonly messages:(sessionID:string,page:{limit:number;before?:string},options:{directory:string;signal?:AbortSignal;timeoutMs:number;maxResponseBytes:number})=>Promise<{readonly records:readonly unknown[];readonly cursor?:string}>;
 }};
 readonly primaryRuntime:Pick<PrimaryRecoveryHost,'readRecord'|'reserveNativeFallback'|'captureNativeRecoveryDispatch'|'helloNative'>;
 readonly getInstanceID?:()=>string|undefined;
 readonly getManagedRuntime:()=>Promise<Pick<ReturnType<typeof createManagedTaskScheduler>,'withNativePromptContext'>>|Pick<ReturnType<typeof createManagedTaskScheduler>,'withNativePromptContext'>;
 readonly originals:Pick<typeof ReviewedSlim,'createReviewedSlimTaskBoardRenderer'|'formatReviewedSlimTaskBoard'|'isReviewedSlimFailoverError'|'selectReviewedSlimFallback'>;
 readonly locations:readonly {readonly directory:string;readonly activeRegistrationIDs?:readonly string[];readonly compatibility?:{readonly slim?:Readonly<Record<string,unknown>>}}[];
}):{readonly transformMessages:(input:NativeSlimContextInput,context?:{signal?:AbortSignal})=>Promise<{messages:unknown[];presentationInsertions:readonly {readonly index:number;readonly baseKey:string}[]}>;readonly retry:(input:NativeSlimRetryInput,context?:{signal?:AbortSignal})=>Promise<{decision:import('@opencode/plugin/effect/session').SessionRetryDecision}>;readonly clearSession:(sessionID:string)=>void};
