import type { ManagedTaskRecord, ManagedTaskResultEnvelope, ManagedResultReference, CompactResultHeader } from '@openchamber/orchestration-runtime';
export interface NativeManagedScope { readonly directory: string; readonly rootSessionId: string }
export interface NativeManagedResult {
  readonly task: Partial<ManagedTaskRecord> & Pick<ManagedTaskRecord, 'taskId' | 'rootSessionId' | 'directory' | 'status'>;
  readonly resultEnvelope?: Partial<ManagedTaskResultEnvelope> & Pick<ManagedTaskResultEnvelope, 'envelopeId' | 'taskId' | 'rootSessionId' | 'directory' | 'status' | 'action'>;
  readonly resultReference?: ManagedResultReference;
  readonly resultHeader?: CompactResultHeader;
  readonly capabilities?: { readonly policies?: { readonly compactResults?: boolean } };
}
export function validateNativeManagedResult(result: unknown, scope: NativeManagedScope, taskID: string): NativeManagedResult;
export function createNativeManagedResultCollection(): {
  collect(result: unknown, scope: NativeManagedScope, taskID: string): void;
  next(scope: NativeManagedScope, taskID: string, cursor: string): { envelopeID: string; status: string; detailRequired: boolean; reference?: ManagedResultReference; complete: boolean };
  acceptPage(scope: NativeManagedScope, taskID: string, cursor: string, result: unknown): void;
  assertDisposition(scope: NativeManagedScope, taskID: string, action: 'continue' | 'retry' | 'resume' | 'abandon', current: unknown): void;
  dispose(scope: NativeManagedScope, taskID: string): void;
};
