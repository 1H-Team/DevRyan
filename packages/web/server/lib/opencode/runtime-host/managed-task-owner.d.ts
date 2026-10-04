import type { NativeAdmissionOwner } from './native-admission-owner.js';
export interface NativeManagedInvocation {
  directory: string; sessionID: string; messageID: string; callID: string; tool: 'devryan_task' | 'council_session';
  input: Readonly<Record<string, unknown>>; permit: Parameters<NativeAdmissionOwner['recheckExecution']>[0]['permit'];
  authorization: Parameters<NativeAdmissionOwner['recheckExecution']>[0]['authorization'];
}
export interface NativeManagedDependencies {
  admissionOwner: Pick<NativeAdmissionOwner, 'recheckExecution' | 'withPermit'>;
  taskContext: {
    authorizeNativeTaskInvocation(input: NativeManagedInvocation): Promise<{readOnly: boolean; objectiveID?: string}>;
    authorizeNativePlanInvocation(input: NativeManagedInvocation): Promise<void>;
    handleNativePlanRpc(input: Readonly<Record<string, unknown>>, recheck: () => Promise<void>): Promise<unknown>;
    handleNativeContextRpc(input: Readonly<Record<string, unknown>>, recheck: () => Promise<void>): Promise<unknown>;
  };
  executionHost: {nativeManagedControl(input: {action: 'begin' | 'finish'; invocation: NativeManagedInvocation; token?: string}): Promise<unknown>};
  getManagedRuntime(): {handleRpc(input: {method: string; params?: Readonly<Record<string, unknown>>}, context?: {signal?: AbortSignal}): Promise<unknown>};
}
export function createNativeManagedTaskOwner(options: NativeManagedDependencies): (input: NativeManagedInvocation, context?: {signal?: AbortSignal}) => Promise<unknown>;
