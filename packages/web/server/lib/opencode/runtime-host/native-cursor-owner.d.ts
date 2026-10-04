import type {NativeAdmissionOwner} from './native-admission-owner.js';
import type {NativeWirePermit} from './native-process-protocol.js';
import type {SessionMutationRuntime,MutationLease} from '../../../../../harness-runtime/lib/session-mutations.js';
import type {NativeCursorRecovery} from './native-cursor-recovery.js';
export interface NativeCursorScope {readonly controllerInstanceID?:string;readonly directory:string;readonly sessionID:string;readonly userMessageID:string;
 readonly assistantMessageID:string;readonly agent:string;readonly modelID:string;readonly variant?:string}
export interface NativeCursorRecord extends NativeCursorScope {readonly controllerInstanceID:string;readonly permit:NativeWirePermit&{readonly sessionID:string};
 readonly accepted:Readonly<Record<string,unknown>>;readonly record:{readonly info:Readonly<Record<string,unknown>>;readonly parts:readonly Readonly<Record<string,unknown>>[]}}
export interface NativeCursorRecordAuthorization extends NativeCursorScope {readonly controllerInstanceID:string;readonly permit:NativeWirePermit&{readonly sessionID:string};readonly recordFingerprint:string}
export type NativeCursorSettlement=Omit<NativeCursorRecordAuthorization,'recordFingerprint'>;
export interface NativeCursorReadOnlyScope {readonly kind:'title'|'text'|'catalog'|'verify';readonly directory:string;readonly sessionID?:string}
export interface NativeCursorReadOnlyKey extends NativeCursorReadOnlyScope {readonly controllerInstanceID:string;readonly permit:NativeWirePermit}
export function createNativeCursorOwner(options:{readonly instanceID:string;readonly admissionOwner:Pick<NativeAdmissionOwner,'captureCursorAuthorization'>;
 readonly runtime:Pick<SessionMutationRuntime,'leaseForCall'|'capturedSessionState'>;
 readonly controller:()=>{readonly instanceID:string;readonly hasExited?:()=>boolean;readonly call:(command:({readonly action:'cursor-record-owned'}&NativeCursorRecord)|({readonly action:'cursor-settle-owned'|'cursor-key-owned'}&NativeCursorSettlement)|({readonly action:'cursor-readonly-key-owned'}&NativeCursorReadOnlyKey))=>Promise<unknown>};
 readonly isReady:()=>boolean;readonly abortAndWait:(sessionID:string)=>Promise<unknown>;
 readonly onStarted:(scope:NativeCursorScope,recheck:()=>Promise<void>)=>Promise<unknown>;
 readonly recovery?:NativeCursorRecovery;
}):{
 readonly ownedPrompt:(scope:NativeCursorScope)=>Promise<{readonly run:<A>(action:()=>Promise<A>)=>Promise<A>;readonly close:()=>Promise<void>}>;
 readonly withExecution:<A extends {readonly lease:MutationLease;readonly result:Promise<unknown>;readonly cancel?:()=>unknown}>(input:{readonly directory:string;readonly sessionID:string;readonly messageID:string;readonly assistantMessageID:string},action:()=>Promise<A>)=>Promise<A>;
 readonly persist:(input:{readonly sessionID:string;readonly directory:string;readonly record:NativeCursorRecord['record']})=>Promise<unknown>;
 readonly assertRecord:(input:NativeCursorRecordAuthorization)=>Promise<null>;
 readonly assertKey:(input:NativeCursorSettlement)=>Promise<null>;
 readonly resolveApiKey:(input:({readonly kind:'prompt'}&NativeCursorScope)|NativeCursorReadOnlyScope)=>Promise<string>;
 readonly assertReadOnlyKey:(input:NativeCursorReadOnlyKey)=>Promise<null>;
 readonly withReadOnly:<A>(scope:NativeCursorReadOnlyScope,captured:{readonly revision:number;readonly recheck:()=>Promise<void>},action:()=>Promise<A>)=>Promise<A>;
 readonly beforeReadOnlyExecution:()=>Promise<void>;
 readonly withReadOnlyExecution:<A extends {readonly result:Promise<{readonly terminated:boolean;readonly confined:boolean}>;readonly cancel:()=>unknown}>(action:()=>Promise<A>)=>Promise<A>;
 readonly assertSettlement:(input:NativeCursorSettlement)=>Promise<null>;
 readonly recover:(input:{readonly directory:string})=>Promise<void>;
 readonly close:()=>Promise<void>;
};
