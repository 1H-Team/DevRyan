import type { ManagedTaskRecord, ManagedTaskResultEnvelope, ManagedResultReference, ManagedMetadataReference, CompactResultHeader } from '@devryan/orchestration-runtime';
import type { NativeResultDeliveryDiagnostic } from './native-result-delivery.js';
export interface NativeManagedScope { readonly directory: string; readonly rootSessionId: string; readonly resultContractVersion?: 1 | 2 }
export interface NativeManagedPublicationIdentity {
  readonly controllerInstanceID: string; readonly configurationDigest: string; readonly objectiveID: string; readonly cancellationGeneration: number;
  readonly stepID: string; readonly attempt: {readonly traceID: string; readonly spanID: string}; readonly permitSha256: string;
}
export interface NativeManagedResult {
  readonly task: Partial<ManagedTaskRecord> & Pick<ManagedTaskRecord, 'taskId' | 'rootSessionId' | 'directory' | 'status'>;
  readonly resultEnvelope?: Partial<ManagedTaskResultEnvelope> & Pick<ManagedTaskResultEnvelope, 'envelopeId' | 'taskId' | 'rootSessionId' | 'directory' | 'status' | 'action'>;
  readonly resultReference?: ManagedResultReference;
  readonly metadataReference?: ManagedMetadataReference;
  readonly resultContractVersion?: 1|2;
  readonly resultHeader?: CompactResultHeader;
  readonly capabilities?: { readonly policies?: { readonly compactResults?: boolean } };
}
export function validateNativeManagedResult(result: unknown, scope: NativeManagedScope, taskID: string): NativeManagedResult;
export function createNativeManagedResultCollection(options?: {onDelivery?: (event: NativeResultDeliveryDiagnostic) => void}): {
  publicationMessageIDs(scope: NativeManagedScope, taskIDs: readonly string[]): string[];
  collect(result: unknown, scope: NativeManagedScope, taskID: string, reset?: boolean): void;
  stagePublication(scope: NativeManagedScope, taskIDs: readonly string[], invocation: {messageID: string; callID: string; input: unknown}, identity: NativeManagedPublicationIdentity, output: unknown): void;
  assertPublished(scope: NativeManagedScope, taskID: string, snapshot: {identity: NativeManagedPublicationIdentity; messages: readonly {info: {id: string; role: string; sessionID?: string}; parts: readonly unknown[]}[]}, review?: boolean): void;
  next(scope: NativeManagedScope, taskID: string, cursor: string): { envelopeID: string; status: string; detailRequired: boolean; reference?: ManagedResultReference; complete: boolean };
  acceptPage(scope: NativeManagedScope, taskID: string, cursor: string, result: unknown): void;
  acceptPublishedPages(scope: NativeManagedScope, reads: readonly {taskID: string; cursor: string; result: unknown}[], invocation: {messageID: string; callID: string; input: unknown}, identity: NativeManagedPublicationIdentity, output: unknown): void;
  assertDisposition(scope: NativeManagedScope, taskID: string, action: 'collect' | 'continue' | 'retry' | 'resume' | 'abandon', current: unknown): void;
  dispose(scope: NativeManagedScope, taskID: string): void;
  /** Whether a collected completed result had its whole report and metadata delivered; the caller judges cleanliness. */
  canAutoContinue(scope: NativeManagedScope, taskID: string): boolean;
  /** Marks such a result for continue on a later Step; false when it needs an explicit disposition. */
  markAutoContinue(scope: NativeManagedScope, taskID: string): boolean;
  autoContinuePending(scope: NativeManagedScope): string[];
  autoContinueFailed(scope: NativeManagedScope, taskID: string, limit: number): void;
};
