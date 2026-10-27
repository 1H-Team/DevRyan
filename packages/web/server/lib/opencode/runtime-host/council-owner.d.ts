import type { NativeManagedDependencies, NativeManagedInvocation } from './managed-task-owner.js';
export interface NativeCouncilMember { readonly providerId: string; readonly modelId: string; readonly variant?: string | null; readonly agent?: string; readonly timeoutMs?: number }
export function createNativeCouncilOwner(options: NativeManagedDependencies & {
  readCouncilMembers(input: {directory: string; sessionID: string; preset: string}): Promise<readonly NativeCouncilMember[]>;
}): (input: NativeManagedInvocation, context?: {signal?: AbortSignal}) => Promise<unknown>;
