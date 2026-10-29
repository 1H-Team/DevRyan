import type {WindowsPrivateFileOwner} from './windows-private-files.js';
import type {RebootRecoveryProof} from './session-reboot-recovery.js';
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
  holds: Array<{ id: string; ownerID: string; sessionID: string; transactionID?: string; removalID?: string }>;
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
  /** Process leases only: no private view copy; the publication is always empty. */
  preparation?: 'read-only';
  ownerID?: string;
  /** The managed task attempt the run belongs to (managed children only). */
  attempt?: MutationLeaseAttempt;
}
/** `none`: between attempts; `unknown`: the orchestrator was not ready. */
export type MutationLeaseAttempt = { taskId: string; leaseToken: string } | { state: 'none' | 'unknown' };
export interface ReviewedToolEffectInput { tool: string; origin: { kind: 'native' | 'plugin'; id: string; manifestDigest: string; capabilities: readonly string[] };
  reviewedOrigin: { kind: 'native' | 'plugin'; id: string; manifestDigest: string; capabilities: readonly string[] } }
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
  /** The ledger's count of file-changing commits when the view was copied (viewFreshness). */
  fileEpoch?: number;
  promptSequence: number;
  viewDirectory: string;
  state: 'preparing' | 'ready' | 'published' | 'cancelled';
  parentCallID: string | null;
  executionFingerprint?: string;
  publicationPolicy?: 'context-images' | 'interview-document';
  publicationPath?: string;
  executionKind?: 'control' | 'process';
  /** `none`: control lease. `read-only`: process lease run from the live project under a read-only profile. */
  preparation?: 'none' | 'read-only';
  reservedAt?: number;
  snapshotRef?: string;
  /** Dependency inputs linked read-only into the view (relative paths), classified from the project at preparation. */
  inputs?: string[];
  ownerID?: string;
  attempt?: MutationLeaseAttempt;
  result?: MutationPublication;
  cleanupPending?: boolean;
  cleaned?: boolean;
  /** A user Stop, or the orchestrator after the run's task attempt settled, ended this run; its shell completion does not restart the conversation. */
  stoppedBy?: 'operator' | 'task_settled';
  /** Terminal uncertain outcome. Its private view and historical Git pin remain evidence. */
  rebootRecovery?: RebootRecoveryProof;
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
  /** Constructor only: sourceOID is supplied by full selected-bundle verification. Holds remain fenced. */
  recoverNativeRemovalOwnership(input: { directory: string; ownerID: string; checkpointID: string; sourceOID: string; sourceOwnerID?: string }): Promise<number>;
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
  /** Constructor recovery only, after prior process settlement and verified bundle ownership. */
  recoverNativeTransientHolds(input: { directory: string; ownerID: string }): Promise<number>;
  deferNativeContinuation(input: { directory: string; sessionID: string; operation: string }): Promise<void>;
  nativeContinuations(input: { directory: string; sessionID: string }): Promise<string[]>;
  /** Only receipt-bound shell wake intents, from this repository's existing ledger. */
  nativeShellContinuations(input: { directory: string }): Promise<Array<{ sessionID: string; operation: string }>>;
  nativeExecutionContinuations(input: { directory: string }): Promise<string[]>;
  nativeTransactionHolds(input: { directory: string; ownerID: string }): Promise<Array<{ transactionID: string; sessions: string[] }>>;
  bindNativeShellJob(input: { directory: string; token: string; jobID: string; command: string; sessionID: string; messageID: string; callID: string }): Promise<MutationLease>;
  nativeShellJob(input: { directory: string; sessionID: string; jobID: string }): Promise<MutationLease>;
  bindNativeShellNotification(input: { directory: string; sessionID: string; jobID: string; notificationID: string; itemHash?:string;itemDelivery?:'queue'|'steer' }): Promise<void>;
  acknowledgeNativeShellCompletion(input: { directory: string; sessionID: string; jobID: string; notificationID: string }): Promise<void>;
  acknowledgeNativeContinuation(input: { directory: string; sessionID: string; operation: string; userMessageID?: string; assistantMessageID?: string; expectedRevision?: number }): Promise<void>;
  registerPrompt(input: Pick<MutationScope, 'directory' | 'sessionID' | 'userMessageID' | 'parentID' | 'parentGeneration'> & { proof?: boolean; fingerprint?: string; candidateHash?: string }): Promise<{ sequence: number }>;
  reservePromptBoundary(input: Pick<MutationScope, 'directory' | 'sessionID' | 'userMessageID' | 'parentID' | 'parentGeneration'> & { fingerprint: string; candidateHash: string }): Promise<{ sequence: number }>;
  pendingPromptBoundary(input: Pick<MutationScope, 'directory' | 'sessionID' | 'userMessageID'>): Promise<{ sessionID: string; messageID: string; sequence: number; provisional: true; fingerprint: string; candidateHash: string } | null>;
  registerChild(input: { directory: string; sessionID: string; parentID: string; parentCallID: string }): Promise<{ parentGeneration: number }>;
  /** Background standby view for a session's first confined call (a child that may write). */
  prewarmView(input: { directory: string; sessionID: string }): Promise<{ prepared: number } | { skipped: string }>;
  begin(input: MutationScope): Promise<MutationLease>;
  reserve(input: MutationScope): Promise<MutationLease>;
  prepare(lease: MutationLease): Promise<MutationLease>;
  claimLease(input: { directory: string; token: string; kind: 'control' | 'process'; reattach?: true }): Promise<MutationLease>;
  aliasCalls(input: { directory: string; token: string; calls: string[] }): Promise<void>;
  executionReceipt(input: { directory: string; token: string }): Promise<MutationScope & { source: 'confined-execution'; complete: true;
    files: Array<{ path: string; before: { byteStream: AsyncIterable<Uint8Array>; sha256: string; mode: string } | null; after: { byteStream: AsyncIterable<Uint8Array>; sha256: string; mode: string } | null }> }>;
  finish(input: { directory: string; token: string; renames?: Array<{ from: string; to: string }>; effect?: ReviewedToolEffectInput }): Promise<MutationPublication>;
  cleanupLease(input: { directory: string; token: string }): Promise<boolean>;
  prepareRevert(input: { directory: string; sessionID: string; messageID: string; scope?: 'tree' | 'session' }): Promise<MutationTransaction>;
  prepareRedo(input: { directory: string; sessionID: string }): Promise<MutationTransaction>;
  previewFileRestore(input: { directory: string; sessionID: string; revision: string; redo?: boolean;
    calls: Array<{ sessionID: string; callID: string; messageID: string }> }): Promise<{ version: 1; digest: string }>;
  prepareFileRestore(input: { directory: string; sessionID: string; revision: string; redo?: boolean;
    calls: Array<{ sessionID: string; callID: string; messageID: string }>; proof: { version: 1; digest: string } }): Promise<MutationTransaction>;
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
  executionOutcomes(input: {directory:string;sessionID:string;calls:readonly {callID:string;messageID:string;tool?:string}[]}): Promise<{sessionID:string;messageID:string;callID:string;outcome:'finished'|'never_started'|'uncertain';effect?:'read-only';coveredBy?:string}[]>;
  /** `stoppedBy` records that a user Stop (`operator`) or a settled task attempt (`task_settled`) ended the run. */
  cancelLease(input: { directory: string; token: string; stoppedBy?: 'operator' | 'task_settled' }): Promise<void>;
  cancelUnstartedCall(input: { directory: string; sessionID: string; messageID: string; callID: string; token?: string; requireAbsent?: true;
    /** Constructor-only owner fence, checked under the ledger lock and atomic commit. */
    guard?: { readonly assertCurrent: () => void; readonly admissionRevision: number } }): Promise<void>;
  activeLeases(input: { directory: string; sessions?: string[] }): Promise<MutationLease[]>;
  /** Read-only: whether a running lease's view still matches the project (`stale` once a later commit changed project files). */
  viewFreshness(input: { directory: string; token: string }): Promise<{ state: 'fresh' | 'stale' | 'unknown'; behind?: number }>;
  pendingCleanup(input: { directory: string }): Promise<MutationLease[]>;
  drain(): Promise<PromiseSettledResult<unknown>[]>;
}
export function createSessionMutationRuntime(options: {
  directory: string;
  windowsOwner?:WindowsPrivateFileOwner;
  windowsLauncher?:string;
  /** Ledger store Git I/O (default: the package's own runners). Tests count processes and commits through it. */
  gitRunner?: {
    git(cwd: string, args: string[], options?: Record<string, unknown>): Promise<Buffer>;
    gitTokens(cwd: string, args: string[], options?: Record<string, unknown>): AsyncIterable<string>;
    gitRecords(cwd: string, args: string[], rows: AsyncIterable<{ key: string; oid: string; size: number }> | Iterable<{ key: string; oid: string; size: number }>):
      AsyncIterable<{ key: string; oid: string; value: unknown }>;
    /** Optional long-lived object reader; without it every read is its own process. */
    readObject?(cwd: string, args: string[], name: string, options?: { check?: boolean }): Promise<{ oid: string; type: string; size: number; data?: Buffer } | null>;
  };
  /** Rows per install transaction (defaults 128 and, for a first build, 1024). Tests shrink them. */
  batching?: { install?: number; initialInstall?: number };
  /** Document complexity guard bounds (positive integers, each warning at most its ceiling). */
  complexity?: { warnEntries?: number; warnBytes?: number; ceilingEntries?: number; ceilingBytes?: number };
  onChange?(input: MutationPublication & { directory: string }): void | Promise<void>;
  onMaterialize?(row: { path: string; before: unknown; after: unknown }): void | Promise<void>;
  /** Background failures (ledger maintenance, input classification); codes only. A failed Git
   * step adds its subcommand and a bounded failure class (`timeout`, `lock`, `corrupt`, `no_space`, `signal`, `exit_<code>`). */
  onDiagnostic?(record: { phase: string; state: 'failed' | 'completed'; code?: string; elapsedMs?: number; slow?: boolean; action?: string; sessionID?: string; steps?: string; reason?: string; command?: string; failure?: string }): void;
  /** Every owner-lock acquisition (observer only): queue and lock wait from the call, then hold time
   * (transaction and commit). `operation` is the outermost runtime method, or the install pass.
   * `snapshotMiss`: why a snapshot-first read fell back to this lock. */
  onLockTiming?(timing: { operation: string; sessionID?: string; snapshotMiss?: 'absent' | 'materialization' | 'meta' | 'write' | 'error'; queueMs: number; waitMs: number; holdMs: number; wrote: boolean; failed: boolean }): void;
}): SessionMutationRuntime;
