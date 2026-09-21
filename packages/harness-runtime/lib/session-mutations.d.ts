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
  kind?: 'control' | 'process';
  ownerID?: string;
}
export interface MutationFile { path: string; status: 'added' | 'modified' | 'deleted' }
export interface MutationPublication { operationID: string; sequence: number; files: MutationFile[]; outcome?: 'partial'; conflicts?: Array<{ path: string; source?: string }> }
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
  executionKind?: 'control' | 'process';
  preparation?: 'none';
  reservedAt?: number;
  snapshotRef?: string;
  ownerID?: string;
  result?: MutationPublication;
  cleanupPending?: boolean;
  cleaned?: boolean;
}
export interface MutationTarget { id: string; targetMessageID: string; callID?: string }
export interface MutationRevertResult { files: MutationFile[]; sessions: MutationTarget[]; redoAvailable: boolean }
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
  projectDirectories(): Promise<string[]>;
  projectDirectory(input: { directory: string }): Promise<string>;
  assertAdmission(input: { directory: string; sessionID: string }): Promise<{ admitted: true }>;
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
  leaseForCall(input: Pick<MutationScope, 'directory' | 'sessionID' | 'callID'>): Promise<MutationLease | null>;
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
}): SessionMutationRuntime;
