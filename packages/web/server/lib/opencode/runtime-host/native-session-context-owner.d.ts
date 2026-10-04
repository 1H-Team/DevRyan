import type {PrimaryRecoveryHost,NativePrimaryContinuationPrompt} from '@openchamber/harness-runtime';
import type {OperationPermit} from './native-admission-contract.js';
import type {NativeManagedInvocation,NativeManagedDependencies} from './managed-task-owner.js';
export const SESSION_CONTEXT_PLUGIN_ID:'devryan.harness-context';
export interface NativeTodo {readonly id:string;readonly content:string;readonly status:'pending'|'in_progress'|'completed'|'cancelled';readonly priority:'high'|'medium'|'low'}
export function validateNativeTodos(input:unknown):NativeTodo[];
export interface NativeTodoInvocation extends Omit<NativeManagedInvocation,'tool'> {readonly tool:'todoread'|'todowrite'}
export interface NativeContextInvocation {readonly permit:OperationPermit;readonly directory:string;readonly sessionID:string;readonly phase:'context'|'compaction'}
export function createNativeSessionContextOwner(options:{
 readonly admissionOwner:NativeManagedDependencies['admissionOwner'];
 readonly taskContext:{readonly authorizeNativeTodoInvocation:(input:NativeTodoInvocation)=>Promise<void>;readonly compactionAnchor:(input:{sessionID:string;directory:string})=>Promise<{available:boolean;reason?:string;text?:string}>};
 readonly openCodeClient:{readonly sessions:{readonly get:(sessionID:string,options:{directory:string})=>Promise<unknown>;readonly message:(sessionID:string,messageID:string,options:{directory:string})=>Promise<unknown>;readonly status:(input:{directory:string})=>Promise<unknown>}};
 readonly primaryRuntime?:Pick<PrimaryRecoveryHost,'readRecord'|'plugin'|'recordRejection'|'helloNative'|'reserveNativeContinuation'|'pendingNativeContinuations'|'captureNativeContinuationDispatch'>;readonly instanceID?:string;readonly getInstanceID?:()=>string|undefined;
 readonly isHeld?:(scope:{sessionID:string;directory:string;messageID:string})=>Promise<boolean>;
 readonly deliverContinuation?:(input:{scope:{sessionID:string;directory:string;messageID:string};prompt:NativePrimaryContinuationPrompt},recheck:()=>Promise<void>)=>Promise<void>;
 readonly readSessionMetadata?:(scope:{sessionID:string;directory:string})=>Promise<{id:string;directory:string;metadata:Record<string,unknown>}>;
 readonly writeTodos:(input:{sessionID:string;directory:string;todos:readonly NativeTodo[];invocation:NativeTodoInvocation},recheck:()=>Promise<void>)=>Promise<unknown>;
 readonly authorizeContext:(input:NativeContextInvocation)=>Promise<()=>Promise<void>>;
}):{readonly continueTodos:(input:{sessionID:string;directory:string})=>Promise<{continued:boolean;messageID?:string;reason?:string}>;readonly recoverContinuations:(input:{directory:string})=>Promise<void>;readonly tool:(input:NativeTodoInvocation,context?:{signal?:AbortSignal})=>Promise<unknown>;readonly observeTool:(input:Omit<NativeManagedInvocation,'tool'> & {readonly tool:string;readonly phase:'tool_before'|'tool_after'|'rejected';readonly rejection?:{fingerprint:string;reason:string}},context?:{signal?:AbortSignal})=>Promise<unknown>;readonly context:(input:NativeContextInvocation,context?:{signal?:AbortSignal})=>Promise<unknown>};
