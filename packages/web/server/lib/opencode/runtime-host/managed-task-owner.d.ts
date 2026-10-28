import type { NativeAdmissionOwner } from './native-admission-owner.js';
import type { NativeResultDeliveryDiagnostic } from './native-result-delivery.js';
import { REQUIRED_CHECK_CORRECTION, type ManagedTaskRecord } from '@devryan/orchestration-runtime';
export interface NativeManagedInvocation {
  directory: string; sessionID: string; messageID: string; callID: string; tool: 'devryan_task' | 'devryan_plan_read' | 'council_session';
  input: Readonly<Record<string, unknown>>; permit: Parameters<NativeAdmissionOwner['recheckExecution']>[0]['permit'];
  authorization: Parameters<NativeAdmissionOwner['recheckExecution']>[0]['authorization'];
  nativeAttempt?: {readonly traceID: string; readonly spanID: string};
}
export interface NativeManagedDependencies {
  onResultDelivery?(event: NativeResultDeliveryDiagnostic): void;
  readResultPublication?(input: NativeManagedInvocation, options?: {messageIDs: readonly string[]}): Promise<{messages: readonly {info: {id: string; role: string; sessionID?: string}; parts: readonly unknown[]}[];
    identity: {controllerInstanceID: string; configurationDigest: string; objectiveID: string; cancellationGeneration: number; stepID: string;
      attempt: {traceID: string; spanID: string}; permitSha256: string}}>;
  /** Session-idle review: root-Orchestrator authority, idle status, and the canonical messages up to the primary record's latest completed step. */
  readIdleReview?(input: {sessionID: string; directory: string; messageIDs: readonly string[]}): Promise<{messages: readonly {info: {id: string; role: string; sessionID?: string}; parts: readonly unknown[]}[];
    identity: {controllerInstanceID: string; configurationDigest: string; objectiveID: string; cancellationGeneration: number; stepID: string}}>;
  /** Serializes the idle acknowledgement with prompt admission for that session. */
  withIdleSession?<A>(scope: {sessionID: string; directory: string}, action: () => Promise<A>): Promise<A>;
  /** Budget for each start phase (preparation, permit-held commit); defaults to 25 s. */
  startPhaseTimeoutMs?: number;
  readToolOutputLimits?(input: NativeManagedInvocation): {max_bytes?: number; max_lines?: number} | Promise<{max_bytes?: number; max_lines?: number}>;
  admissionOwner: Pick<NativeAdmissionOwner, 'recheckExecution' | 'withPermit' | 'withManagedTaskCatalogInvocation'> & Partial<Pick<NativeAdmissionOwner,'withManagedResultRead'>>;
  taskContext: {
    captureApprovedPlan(input:NativeManagedInvocation,selection:unknown,recheck:()=>Promise<void>):Promise<import('@devryan/orchestration-runtime').ApprovedPlanRef>;
    authorizeNativeTaskInvocation(input: NativeManagedInvocation): Promise<{readOnly: boolean; objectiveID?: string}>;
    authorizeNativeCheckCorrectionTask?(input: NativeManagedInvocation, task: ManagedTaskRecord): Promise<void>;
    authorizeNativePlanInvocation(input: NativeManagedInvocation): Promise<void>;
    handleNativePlanRpc(input: Readonly<Record<string, unknown>>, recheck: () => Promise<void>, options?: {maxBytes: number}): Promise<unknown>;
    handleNativeContextRpc(input: Readonly<Record<string, unknown>>, recheck: () => Promise<void>): Promise<unknown>;
  };
  executionHost: {nativeManagedControl(input: {action: 'begin'; invocation: NativeManagedInvocation}): Promise<{lease: {token: string}; reattached?: true}>;
    nativeManagedControl(input: {action: 'finish'; invocation: NativeManagedInvocation; token: string}): Promise<unknown>};
  getManagedRuntime(): {
    handleRpc(input: {method: string; params?: Readonly<Record<string, unknown>>}, context?: {signal?: AbortSignal; authorizeSubmission?: () => Promise<void>;
      dispatchObjectiveId?: string | null; [REQUIRED_CHECK_CORRECTION]?: { rootSessionId: string; directory: string; objectiveId: string;
        recheck(): Promise<void>; verifyTaskObjective(task: ManagedTaskRecord): Promise<void> } }): Promise<unknown>;
    withSubmissionPreparation?<A>(params: Readonly<Record<string, unknown>>, context: {signal?: AbortSignal}, action: () => Promise<A>): Promise<A>;
  };
}
export interface NativeManagedTaskOwner {
  (input: NativeManagedInvocation, context?: {signal?: AbortSignal}): Promise<unknown>;
  /** Continues wait_any's clean results after a later completed Step; returns the committed receipts. */
  settleIdle(scope: {sessionID: string; directory: string}): Promise<{taskId: string; envelopeId: string; action: 'continue'}[]>;
}
export function createNativeManagedTaskOwner(options: NativeManagedDependencies): NativeManagedTaskOwner;
