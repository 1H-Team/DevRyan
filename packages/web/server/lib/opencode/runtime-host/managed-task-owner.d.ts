import type { NativeAdmissionOwner } from './native-admission-owner.js';
export interface NativeManagedInvocation {
  directory: string; sessionID: string; messageID: string; callID: string; tool: 'devryan_task' | 'council_session';
  input: Readonly<Record<string, unknown>>; permit: Parameters<NativeAdmissionOwner['recheckExecution']>[0]['permit'];
  authorization: Parameters<NativeAdmissionOwner['recheckExecution']>[0]['authorization'];
  nativeAttempt?: {readonly traceID: string; readonly spanID: string};
}
export interface NativeManagedDependencies {
  readResultPublication?(input: NativeManagedInvocation, options?: {messageIDs: readonly string[]}): Promise<{messages: readonly {info: {id: string; role: string; sessionID?: string}; parts: readonly unknown[]}[];
    identity: {controllerInstanceID: string; configurationDigest: string; objectiveID: string; cancellationGeneration: number; stepID: string;
      attempt: {traceID: string; spanID: string}; permitSha256: string}}>;
  readToolOutputLimits?(input: NativeManagedInvocation): {max_bytes?: number; max_lines?: number} | Promise<{max_bytes?: number; max_lines?: number}>;
  admissionOwner: Pick<NativeAdmissionOwner, 'recheckExecution' | 'withPermit' | 'withManagedTaskCatalogInvocation'> & Partial<Pick<NativeAdmissionOwner,'withManagedResultRead'>>;
  taskContext: {
    authorizeNativeTaskInvocation(input: NativeManagedInvocation): Promise<{readOnly: boolean; objectiveID?: string}>;
    authorizeNativePlanInvocation(input: NativeManagedInvocation): Promise<void>;
    handleNativePlanRpc(input: Readonly<Record<string, unknown>>, recheck: () => Promise<void>, options?: {maxBytes: number}): Promise<unknown>;
    handleNativeContextRpc(input: Readonly<Record<string, unknown>>, recheck: () => Promise<void>): Promise<unknown>;
  };
  executionHost: {nativeManagedControl(input: {action: 'begin' | 'finish'; invocation: NativeManagedInvocation; token?: string}): Promise<unknown>};
  getManagedRuntime(): {
    handleRpc(input: {method: string; params?: Readonly<Record<string, unknown>>}, context?: {signal?: AbortSignal; authorizeSubmission?: () => Promise<void>}): Promise<unknown>;
    withSubmissionPreparation?<A>(params: Readonly<Record<string, unknown>>, context: {signal?: AbortSignal}, action: () => Promise<A>): Promise<A>;
  };
}
export function createNativeManagedTaskOwner(options: NativeManagedDependencies): (input: NativeManagedInvocation, context?: {signal?: AbortSignal}) => Promise<unknown>;
