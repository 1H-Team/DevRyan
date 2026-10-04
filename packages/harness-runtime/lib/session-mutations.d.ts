export interface NativeRemovalMember { id: string; parentID: string | null; directory: string; generation: number }
export interface NativeRemovalDisposition { sessionID: string; inboxIDs: string[]; pendingIDs: string[] }
export interface NativeRemovalIntent {
  quiet?: boolean;
  id: string; directory: string; rootSessionID: string; ownerID: string;
  state: 'preparing' | 'committed' | 'completed'; members: NativeRemovalMember[];
  removed: string[]; dispositions: NativeRemovalDisposition[];
}
export interface NativeAdmissionState {
  revision: number;
  held: boolean;
  reverting: boolean;
  holds: Array<{ id: string; ownerID: string; sessionID: string; transactionID?: string }>;
}
export interface MutationScope {
  directory: string;
  sessionID: string;
  userMessageID: string;
  messageID: string;
  callID: string;
  parentID?: string;
  parentGeneration?: number;
  parentCallID?: string;
  executionFingerprint?: string;
  publicationPolicy?: 'context-images' | 'interview-document';
  /** Constructor-sealed relative Markdown target for interview-document only. */
  publicationPath?: string;
  kind?: 'control' | 'process';
  ownerID?: string;
}
export interface MutationFile { path: string; status: 'added' | 'modified' | 'deleted' }
export interface MutationPublication { operationID: string; sequence: number; files: MutationFile[]; outcome?: 'partial'; conflicts?: Array<{ path: string; source?: string }>;
  /** Dependency-input paths the call replaced in its view; never published. */
  ignoredInputs?: string[] }
export interface MutationLease {
  token: string;
  scope: Pick<MutationScope, 'sessionID' | 'userMessageID' | 'messageID' | 'callID'>;
  directory: string;
  projectDirectory: string;
  auxiliaryDirectory: string;
  workingDirectory: string;
  vcs: boolean;
  origins: Record<string, number>;
  generation: number;
  baseSequence: number;
  promptSequence: number;
  viewDirectory: string;
  state: 'preparing' | 'ready' | 'published' | 'cancelled';
  parentCallID: string | null;
  executionFingerprint?: string;
  publicationPolicy?: 'context-images' | 'interview-document';
  publicationPath?: string;
  executionKind?: 'control' | 'process';
  preparation?: 'none';
  reservedAt?: number;
  snapshotRef?: string;
  /** Dependency inputs linked read-only into the view (relative paths), classified from the project at preparation. */
  inputs?: string[];
  ownerID?: string;
  result?: MutationPublication;
  cleanupPending?: boolean;
  cleaned?: boolean;
  nativeShellJob?: { jobID: string; command: string; notificationID?: string; itemHash?:string;itemDelivery?:'queue'|'steer'; deliveredID?: string; continuedID?: string; continuedAssistantID?: string };
}
export interface MutationTarget { id: string; targetMessageID: string; callID?: string }
export interface MutationRevertResult { files: MutationFile[]; sessions: MutationTarget[]; redoAvailable: boolean; outcome?: 'partial';
  /** `ignored_input`: the path is inside a dependency input and was left untouched. */
  conflicts?: Array<{ path: string; code?: 'ignored_input' }> }
export interface MutationBoundary {
  id: string;
  revert: { messageID: string; partID?: string; fileRestore: false } | null;
}
export interface MutationTransaction {
  id: string;
  kind?: 'files';
  rootSessionID: string;
  boundarySequence: number;
  state: 'prepared' | 'committed' | 'cancelled';
  phase: 'prepared' | 'stopped' | 'conversation' | 'files' | 'restoring' | 'committed' | 'cancelled';
  scope?: 'tree' | 'session';
  targets: MutationTarget[];
  members: string[];
  redo: boolean;
  boundaries?: MutationBoundary[];
  result?: MutationRevertResult;
}
export interface MutationTransactionReference { directory: string; transactionID: string }
export interface SessionMutationRuntime {
  beginNativeRemoval(input: { directory: string; rootSessionID: string; ownerID: string; quietHold?: {id:string;revision:number;retentionInstanceID:string} }): Promise<NativeRemovalIntent>;
  abandonQuietNativeRemoval(input:{directory:string;intentID:string;ownerID:string}):Promise<void>;
  nativeRetentionHolds(input:{directory:string;ownerID:string}):Promise<Array<{id:string;sessionID:string;revision:number;retentionInstanceID:string}>>;
  commitNativeRemoval(input: { directory: string; intentID: string; ownerID: string; members: Array<Omit<NativeRemovalMember, 'generation'>>; beforeCommit?: () => Promise<void> }): Promise<NativeRemovalIntent>;
  prepareNativeRemovalMembers(input: { directory: string; intentID: string; ownerID: string; members: Array<Omit<NativeRemovalMember, 'generation'>> }): Promise<NativeRemovalIntent>;
  nativeRemoval(input: { directory: string; intentID: string }): Promise<NativeRemovalIntent | undefined>;
  nativeRemovals(input: { directory: string }): Promise<NativeRemovalIntent[]>;
  stageNativeRemovalMember(input: { directory: string; intentID: string; ownerID: string } & NativeRemovalDisposition): Promise<NativeRemovalIntent>;
  acknowledgeNativeRemoval(input: { directory: string; intentID: string; ownerID: string } & NativeRemovalDisposition): Promise<NativeRemovalIntent>;
  completeNativeRemoval(input: { directory: string; intentID: string; ownerID: string }): Promise<NativeRemovalIntent>;
  projectDirectories(): Promise<string[]>;
  projectDirectory(input: { directory: string }): Promise<string>;
  assertAdmission(input: { directory: string; sessionID: string }): Promise<{ admitted: true }>;
  registerNativeSession(input: { directory: string; sessionID: string; parentID?: string | null }): Promise<NativeAdmissionState>;
  nativeAdmissionState(input: { directory: string; sessionID: string }): Promise<NativeAdmissionState>;
  holdNativeAdmission(input: { directory: string; sessionID: string; ownerID: string;retentionInstanceID?:string }): Promise<{ id: string; ownerID: string; revision: number;retentionInstanceID?:string }>;
  releaseNativeAdmission(input: { directory: string; sessionID: string; ownerID: string; holdID: string; expectedRevision: number }): Promise<NativeAdmissionState>;
  deferNativeContinuation(input: { directory: string; sessionID: string; operation: string }): Promise<void>;
  nativeContinuations(input: { directory: string; sessionID: string }): Promise<string[]>;
  /** Only receipt-bound shell wake intents, from this repository's existing ledger. */
  nativeShellContinuations(input: { directory: string }): Promise<Array<{ sessionID: string; operation: string }>>;
  nativeTransactionHolds(input: { directory: string; ownerID: string }): Promise<Array<{ transactionID: string; sessions: string[] }>>;
  bindNativeShellJob(input: { directory: string; token: string; jobID: string; command: string; sessionID: string; messageID: string; callID: string }): Promise<MutationLease>;
  nativeShellJob(input: { directory: string; sessionID: string; jobID: string }): Promise<MutationLease>;
  bindNativeShellNotification(input: { directory: string; sessionID: string; jobID: string; notificationID: string; itemHash?:string;itemDelivery?:'queue'|'steer' }): Promise<void>;
  acknowledgeNativeShellCompletion(input: { directory: string; sessionID: string; jobID: string; notificationID: string }): Promise<void>;
  acknowledgeNativeContinuation(input: { directory: string; sessionID: string; operation: string; userMessageID?: string; assistantMessageID?: string; expectedRevision?: number }): Promise<void>;
  registerPrompt(input: Pick<MutationScope, 'directory' | 'sessionID' | 'userMessageID' | 'parentID' | 'parentGeneration'>): Promise<{ sequence: number }>;
  registerChild(input: { directory: string; sessionID: string; parentID: string; parentCallID: string }): Promise<{ parentGeneration: number }>;
  begin(input: MutationScope): Promise<MutationLease>;
  reserve(input: MutationScope): Promise<MutationLease>;
  prepare(lease: MutationLease): Promise<MutationLease>;
  claimLease(input: { directory: string; token: string; kind: 'control' | 'process' }): Promise<MutationLease>;
  aliasCalls(input: { directory: string; token: string; calls: string[] }): Promise<void>;
  executionReceipt(input: { directory: string; token: string }): Promise<MutationScope & { source: 'confined-execution'; complete: true;
    files: Array<{ path: string; before: { byteStream: AsyncIterable<Uint8Array>; sha256: string; mode: string } | null; after: { byteStream: AsyncIterable<Uint8Array>; sha256: string; mode: string } | null }> }>;
  finish(input: { directory: string; token: string; renames?: Array<{ from: string; to: string }> }): Promise<MutationPublication>;
  cleanupLease(input: { directory: string; token: string }): Promise<boolean>;
  prepareRevert(input: { directory: string; sessionID: string; messageID: string; scope?: 'tree' | 'session' }): Promise<MutationTransaction>;
  prepareRedo(input: { directory: string; sessionID: string }): Promise<MutationTransaction>;
  prepareFileRestore(input: { directory: string; sessionID: string; revision: string; redo?: boolean;
    calls: Array<{ sessionID: string; callID: string; messageID?: string }> }): Promise<MutationTransaction>;
  settleRevert(input: MutationTransactionReference & { commit: boolean }): Promise<MutationRevertResult>;
  transaction(input: MutationTransactionReference): Promise<MutationTransaction | null>;
  updateTransaction(input: MutationTransactionReference & {
    expectedPhase: MutationTransaction['phase']; phase: MutationTransaction['phase']; boundaries?: MutationBoundary[];
  }): Promise<MutationTransaction>;
  pendingTransactions(input: { directory: string }): Promise<MutationTransaction[]>;
  /** Read-only: whether the ledger owns this conversation, or any project transaction awaits recovery. Never creates a ledger. */
  capturedSessionState(input: { directory: string; sessionID: string }): Promise<{ captured: boolean; pending: boolean; generation?: number }>;
  /** Compare-and-swap restoration of unowned content under the publication lock; mismatched paths are conflicts. */
  restoreForeign(input: { directory: string; files: Array<{ path: string; expected: { mode: string; bytes: Uint8Array } | null; target: { mode: string; bytes: Uint8Array } | null }> }):
    Promise<{ files: Array<{ path: string; status: 'unchanged' | 'added' | 'modified' | 'deleted' }>; conflicts: Array<{ path: string }> }>;
  leaseForCall(input: Pick<MutationScope, 'directory' | 'sessionID' | 'callID'>): Promise<MutationLease | null>;
  executionOutcomes(input: {directory:string;sessionID:string;calls:readonly {callID:string;messageID:string}[]}): Promise<{sessionID:string;messageID:string;callID:string;outcome:'finished'|'never_started'|'uncertain'}[]>;
  cancelLease(input: { directory: string; token: string }): Promise<void>;
  cancelUnstartedCall(input: { directory: string; sessionID: string; messageID: string; callID: string; token?: string }): Promise<void>;
  activeLeases(input: { directory: string; sessions?: string[] }): Promise<MutationLease[]>;
  pendingCleanup(input: { directory: string }): Promise<MutationLease[]>;
  drain(): Promise<PromiseSettledResult<unknown>[]>;
}
export function createSessionMutationRuntime(options: {
  directory: string;
  onChange?(input: MutationPublication & { directory: string }): void | Promise<void>;
  onMaterialize?(row: { path: string; before: unknown; after: unknown }): void | Promise<void>;
  /** Background failures (ledger maintenance, input classification); codes only. */
  onDiagnostic?(record: { phase: string; state: 'failed'; code: string }): void;
}): SessionMutationRuntime;
