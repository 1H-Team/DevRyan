import type { MutationLease, SessionMutationRuntime } from '../../../../../harness-runtime/lib/session-mutations.js';
import type { OperationPermit, OperationRequest, ShellJobRegistration } from './native-admission-contract.js';
import type { ManagedTaskRecord } from '../../../../../orchestration-runtime/index.js';
import type {NativePrimaryContinuationPrompt,NativePromptSelectionReceipt,PrimaryRecoveryExecutionRecord} from '@openchamber/harness-runtime';
export interface NativePrimaryContinuationDispatch {readonly sessionID:string;readonly directory:string;readonly messageID:string}

export type NativeManagedTaskDispatch = { readonly taskId: string; readonly leaseToken: string; readonly directory: string } & (
  { readonly operation: 'create'; readonly parentID: string; readonly parentCallID: string }
  | { readonly operation: 'prompt'; readonly sessionID: string; readonly providerId: string; readonly modelId: string;
      readonly agent: string; readonly variant: string | null });

export interface NativeSessionIdentity { readonly id: string; readonly directory: string; readonly parentID?: string | null; readonly agent?:string; readonly model?:{readonly providerID:string;readonly id:string;readonly variant?:string}; readonly metadata?:Readonly<Record<string,unknown>>; readonly time?:{readonly archived?:number}; readonly revert?:unknown }
export interface NativeCommandPromptAdmission {
  readonly admit:(receipt:NativePromptSelectionReceipt,authorizeWrite:()=>Promise<void>)=>Promise<void>;
  readonly uncertain:(receipt:NativePromptSelectionReceipt)=>Promise<unknown>;
}
export interface NativeAcceptedUserObservation {
  readonly sessionID:string;readonly messageID:string;readonly directory:string;readonly fingerprint:string;
  readonly intent:{readonly source:'prompt'|'command-definition';readonly agent?:string;
    readonly model?:{readonly providerID:string;readonly modelID:string};readonly variant?:string|null;readonly variantPresent:boolean};
  readonly execution?:{readonly agent:string;readonly providerID:string;readonly modelID:string;readonly variant:string|null};
}
export interface NativeExecutionAuthorization {
  readonly permit: OperationPermit;
  readonly authorization: OperationRequest;
  readonly directory: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly callID: string;
  readonly tool: string;
  readonly input?: unknown;
  readonly phase?: 'publication';
  readonly token?: string;
}
export interface NativeRevertOperation {
  readonly directory: string;
  readonly sessionID: string;
  readonly transactionID: string;
  readonly operation: 'session.revert.stage' | 'session.revert.clear';
  readonly messageID?: string;
  readonly partID?: string;
  readonly files?: false;
}
export interface NativeTransactionHolds { readonly directory: string; readonly transactionID: string; readonly sessions: readonly string[] }
export type NativeShellReconciliation = { readonly kind: 'consumed'; readonly messageID: string; readonly assistantMessageID: string }
  | { readonly kind: 'registered' | 'blocked'; readonly messageID: string };
/** Native inbox proof: independent runner admission, or an empty inbox and inactive runner. */
export interface NativeDeferredWakeReceipt {
  readonly kind: 'registered' | 'idle';
  readonly operation: 'execution.wake';
  readonly sessionID: string;
}
export interface NativeAdmissionOwnerOptions {
 readonly getInstanceID?:()=>string|undefined;
  readonly bindNativeRecoveryDispatchInput?: (input: {readonly sessionID:string;readonly messageID:string;readonly itemHash:string})=>void|Promise<void>;
  readonly assertRecoveredInputOperation?:(request:OperationRequest,entry?:Readonly<Record<string,unknown>>)=>object|undefined;
  readonly verifyRecoveredInputPublication?:(input:Readonly<Record<string,unknown>>)=>Promise<readonly {readonly sessionID:string;readonly inboxID:string}[]>;
  readonly withRecoveredPrimaryGrant?:<A>(input:NativePrimaryContinuationDispatch,record:PrimaryRecoveryExecutionRecord,action:(recheck:()=>Promise<void>)=>Promise<A>,originalRecheck:()=>Promise<void>)=>Promise<A>;
  readonly withRecoveredShellGrant?:<A>(input:NativePrimaryContinuationDispatch&{readonly expectedItem?:unknown;readonly shellReceipt?:{readonly token:string;readonly jobID:string;readonly command:string;readonly exitCode:number;readonly itemHash?:string;readonly itemDelivery?:'queue'|'steer'}},authorize:()=>Promise<void>,action:(recheck:()=>Promise<void>)=>Promise<A>)=>Promise<A>;
  readonly runtime: SessionMutationRuntime;
  readonly directory: string;
  /** Stable identity of this owned runtime data bundle; exclusive process ownership is a bootstrap prerequisite. */
  readonly ownerID: string;
  /** Immutable prepared configuration; only its exact native configured commands may derive a prompt. */
  readonly reviewedConfiguration?: Readonly<Record<string, unknown>>;
  /** Current controller snapshot, selected by canonical session directory. */
  readonly getReviewedConfiguration?: (directory: string) => Readonly<Record<string, unknown>> | undefined;
  /** Exact compiled behavior declarations; never selected by request metadata. */
  readonly reviewedBehaviorCommands?:readonly import('./command-derivation.js').ReviewedCommandBehavior[];
  readonly protectedRoots?: readonly string[];
  readonly getSession: (sessionID: string) => Promise<NativeSessionIdentity | undefined>;
  /** Original native map, available only to an internal metadata owner. Never the stripped facade projection. */
  readonly readSessionMetadata?: (input: {readonly sessionID:string;readonly directory:string}) => Promise<{
    readonly id:string;readonly directory:string;readonly metadata:Readonly<Record<string,unknown>>} | null>;
  /** Canonical internal native user record; metadata never comes from the UI projection. */
  readonly readUserMessage?:(input:{directory:string;sessionID:string;messageID:string})=>Promise<{
    readonly id:string;readonly type:'user';readonly sessionID:string;readonly directory:string;readonly metadata:Readonly<Record<string,unknown>>} | null>;
  readonly authorizeOperation: (request: OperationRequest & { readonly parentAuthorization?: OperationRequest }, session?: NativeSessionIdentity) => Promise<void>;
  /** Capture the original web principal here. The returned closure reloads its grants on every native use. */
  readonly captureTitleHelperAuthorization?:(session:NativeSessionIdentity)=>Promise<()=>Promise<void>>;
  readonly captureWebAuthorization?: (request: { readonly operation:string;readonly sessionID?:string;readonly directory:string }, session?:NativeSessionIdentity)=>Promise<()=>Promise<void>>;
  /** Capture the original primary owner only within the initial private Web command scope. */
  readonly captureCommandPromptAdmission?:(input:{readonly sessionID:string;readonly directory:string})=>Promise<NativeCommandPromptAdmission>;
  /** Content-free sealed committed observation only; never creates execution authority. */
  readonly observeAcceptedUser?:(input:NativeAcceptedUserObservation)=>Promise<void>;
  readonly observeAcceptedUserGap?:(input:{readonly code:'native_observation_gap';readonly phase:'accepted';
    readonly sessionID:string;readonly messageID:string;readonly directory:string})=>Promise<void>;
  readonly withSessionLock: <A>(sessionID: string, action: () => Promise<A>) => Promise<A>;
  readonly bindShellJob?: (input: ShellJobRegistration) => Promise<MutationLease>;
  readonly getShellJobReceipt?: (input: { readonly directory: string; readonly sessionID: string; readonly jobID: string }) => Promise<{
    readonly lease: MutationLease; readonly receipt: { readonly terminated: boolean; readonly confined: boolean; readonly exitCode: number; readonly cancelled: boolean } }>;
  readonly onContinuation?: (input: { readonly sessionID: string; readonly operation: string; readonly directory?: string;
    readonly jobID?: string; readonly messageID?: string; readonly userMessageID?: string; readonly assistantMessageID?: string;
    readonly callID?: string; readonly permit?: OperationPermit }) => Promise<void | NativeShellReconciliation | NativeDeferredWakeReceipt>;
  readonly awaitReady?: () => Promise<void>;
  /** Constructor-only proof from the current durable scheduler and its process owner. Never exposed through RPC. */
  readonly verifyManagedTaskDispatch?: (input: NativeManagedTaskDispatch) => Promise<ManagedTaskRecord>;
  readonly verifyPrimaryContinuationDispatch?: (input: NativePrimaryContinuationDispatch) => Promise<{
    record:PrimaryRecoveryExecutionRecord;prompt:NativePrimaryContinuationPrompt;recheck:()=>Promise<void>}>;
  readonly verifyPrimaryRecoveryDispatch?: (input: NativePrimaryContinuationDispatch) => Promise<{
    record:PrimaryRecoveryExecutionRecord;prompt:NonNullable<PrimaryRecoveryExecutionRecord['recoveryPrompt']>;recheck:()=>Promise<void>}>;
}
export interface NativeAdmissionOwner {
 readonly withRetentionOperation:<A>(input:{directory:string;sessionID:string;action:'archive'|'delete';at:number;members:readonly import('./native-retention-quiet.js').NativeRetentionMember[];authorize:(members:readonly import('./native-retention-quiet.js').NativeRetentionMember[])=>Promise<void>},action:(permit:OperationPermit)=>Promise<A>)=>Promise<A>;
 readonly withHelperTitleOperation:<A>(input:import("./native-helper-contract.js").NativeHelperTitleInput,action:(permit:OperationPermit)=>Promise<A>)=>Promise<A>;
 readonly withHelperOperation:<A>(input:import("./native-helper-contract.js").NativeHelperInput,action:(permit:OperationPermit)=>Promise<A>)=>Promise<A>;
 readonly assertHelperOperation:(input:unknown,permit:OperationPermit)=>Promise<null>;
  readonly withRecoveredInputOperation:<A>(input:NativePrimaryContinuationDispatch&{payloadHash:string;enqueuedSeq:number;action:'resume'|'discard';recheck:()=>Promise<void>},action:(permit:OperationPermit)=>Promise<A>)=>Promise<A>;
  readonly captureRemovalAuthorization: (sessionID: string) => Promise<{session: NativeSessionIdentity; reauthorize: () => Promise<void>; drain: () => Promise<void>;quietHold?:{id:string;revision:number;retentionInstanceID:string};transferQuietHold?:(intentID:string)=>void}>;
  readonly withRemovalOperation: <A>(input: {directory: string; intentID: string; sessionID: string}, action: (permit: OperationPermit) => Promise<A>) => Promise<A>;
  /** Private Node requester scope; payloads are normalized before issuing transport headers. */
  readonly withWebOperation:<A>(spec:{readonly operation:string;readonly method:string;readonly path:string;readonly body?:unknown;readonly directory?:string},action:()=>Promise<A>)=>Promise<A>;
  /** Constructor-only replacement fence. Caller must first prove old controller exit and await every owned supervisor settlement/publication recovery, then await this barrier before starting its replacement. New owner calls/ACKs close immediately; admitted ledger ACKs fully settle before epoch rotation. ACK failures remain visible to their original callers. Durable ledger/hold identity is preserved. */
  readonly invalidateController: () => Promise<void>;
  /** Constructor-only canonical native Step evidence; deliberately absent from RPC. Optional IDs are an ordered, trusted native-sequence batch ending at userMessageID. */
  readonly acknowledgeStartedContinuation: (input: { readonly sessionID: string; readonly userMessageID: string;
    readonly assistantMessageID: string; readonly consumedUserMessageIDs?: readonly string[] }) => Promise<void>;
  /** Constructor-only startup reconciliation of retained receipt-bound shell intents; honors durable holds. */
  readonly recoverShellContinuations: (input: { readonly directory: string }) => Promise<void>;
  readonly handleRpc: (method: string, input?: unknown) => Promise<unknown>;
  readonly requestHeaders: () => Readonly<Record<string, string>>;
  readonly withAcceptedOperation: <A>(accepted: { readonly sessionID: string; readonly messageID: string; readonly fingerprint: string;
    readonly metadata: Readonly<Record<string, unknown>>; readonly request?: unknown;readonly intent?:Readonly<Record<string,unknown>> }, action: () => Promise<A>) => Promise<A>;
  /** Constructor-only preselection span for the trusted command adapter; exact HTTP selection effects only, no prompt or inbox authority. */
  readonly withCommandSelection: <A>(input: { readonly sessionID: string }, action: () => Promise<A>) => Promise<A>;
  readonly withManagedTaskDispatch: <A>(input: NativeManagedTaskDispatch, action: () => Promise<A>) => Promise<A>;
  /** Private exact TODO metadata derivative; caller already owns withPermit's session lock. */
  readonly withNativeTodoWrite:<A>(input:{invocation:NativeExecutionAuthorization;metadata:Readonly<Record<string,unknown>>},action:()=>Promise<A>)=>Promise<A>;
  readonly captureContextAuthorization:(input:{permit:OperationPermit;directory:string;sessionID:string;phase:'compaction'})=>Promise<()=>Promise<void>>;
  readonly captureCursorAuthorization:(input:{readonly directory:string;readonly sessionID:string;readonly userMessageID:string;readonly assistantMessageID:string;
    readonly agent:string;readonly modelID:string;readonly variant?:string})=>Promise<{readonly accepted:Readonly<Record<string,unknown>>;readonly revision:number;readonly recheck:()=>Promise<void>}>;
  /** Read-only original session hook scope; does not derive mutation or continuation authority. */
  readonly captureSessionHookAuthorization:(input:{permit:OperationPermit;directory:string;sessionID:string;phase:'prompt'|'context'|'compaction'|'retry'|'model.request';messageID?:string})=>Promise<()=>Promise<void>>;
  readonly captureToolHookAuthorization:(input:{readonly permit:OperationPermit;readonly directory:string;readonly sessionID:string;
    readonly messageID:string;readonly callID:string;readonly toolID:string;readonly phase:'execute.before'})=>Promise<()=>Promise<void>>;
  readonly captureAcceptedCommandAuthorization:(input:{readonly permit:OperationPermit;readonly directory:string;readonly sessionID:string;
    readonly messageID:string;readonly name:string;readonly arguments:string})=>Promise<()=>Promise<void>>;
  readonly captureInterviewAuthorization:(input:{readonly permit:OperationPermit;readonly directory:string;readonly sessionID:string;readonly messageID:string;readonly name:'interview';readonly arguments:string})=>Promise<{readonly authorizationID:string;readonly recheck:()=>Promise<void>;readonly signal:AbortSignal}>;
  readonly withInterviewAction:<A>(input:{readonly authorizationID:string;readonly directory:string;readonly sessionID:string;readonly messageID:string;readonly kind:'rename'|'notify'|'continue';readonly text:string},action:(input:import('./native-process-protocol.js').NativeInterviewAction&{readonly permit:OperationPermit})=>Promise<A>)=>Promise<A>;
  readonly captureCommandAuthorization:(input:import('./native-slim-commands.js').NativeSlimCommandInput&{readonly permit:OperationPermit;readonly derivation:string})=>Promise<()=>Promise<void>>;
  readonly withPrimaryContinuationDispatch: <A>(input:NativePrimaryContinuationDispatch,action:()=>Promise<A>)=>Promise<A>;
  readonly withPrimaryRecoveryDispatch: <A>(input:NativePrimaryContinuationDispatch,action:()=>Promise<A>)=>Promise<A>;
  readonly withPrimaryContinuationOperation: <A>(input:NativePrimaryContinuationDispatch,action:(permit:OperationPermit)=>Promise<A>)=>Promise<A>;
  readonly updateAcceptedOperation: (input: { readonly metadata: Readonly<Record<string, unknown>>; readonly request: unknown }) => void;
  readonly recheckExecution: (input: NativeExecutionAuthorization) => Promise<void>;
  /** Constructor-only image request retains its exact live supervised writer lease. */
  readonly withImageGeneration:<A>(invocation:NativeExecutionAuthorization,action:(recheck:()=>Promise<void>)=>Promise<A>)=>Promise<A>;
  readonly beginWebfetchSecondary:(input:{readonly permit:OperationPermit;readonly directory:string;readonly sessionID:string;readonly messageID:string;readonly callID:string;readonly model:{readonly providerID:string;readonly modelID:string;readonly variant?:string};readonly prompt:string})=>Promise<OperationPermit>;
  readonly endWebfetchSecondary:(permit:OperationPermit)=>Promise<null>;
  /** Physical provider hooks retain a real session operation across async credential access. */
  readonly withProviderAttempt: <A>(input: { readonly directory: string; readonly sessionID: string;
    readonly kind: 'primary' | 'title' | 'compaction' | 'generate'; readonly permit: OperationPermit }, action: (recheck: () => Promise<void>) => Promise<A>) => Promise<A>;
  /** Pre-request credential resolution retains the admitted runner or exact secondary call. */
  readonly withProviderResolution: <A>(input: { readonly directory: string; readonly sessionID: string;
    readonly permit: OperationPermit }, action: (recheck: () => Promise<void>) => Promise<A>) => Promise<A>;
  readonly withPermit: <A>(input: NativeExecutionAuthorization, action: () => Promise<A>) => Promise<A>;
  /** Private coordinator capability. This issuer is deliberately absent from handleRpc. */
  readonly withRevertOperation: <A>(input: NativeRevertOperation, action: () => Promise<A>) => Promise<A>;
  readonly releaseTransactionHolds: (input: NativeTransactionHolds) => Promise<void>;
  readonly recoverTransactionHolds: (input: { readonly directory: string }) => Promise<void>;
  /** Refuses outstanding continuation ACKs or replacement; await invalidateController before disposal. */
  readonly dispose: () => void;
}
export function createNativeAdmissionOwner(options: NativeAdmissionOwnerOptions): NativeAdmissionOwner;
