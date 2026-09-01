export interface HarnessPaths {
  harnessDir: string;
  commandDeadlineDir: string;
  worktreeOpsDir: string;
  journalDir: string;
  evidenceDir: string;
}

export function createHarnessPaths(options: { rootDir: string }): HarnessPaths;

export interface CommandDeadlineFingerprint {
  sessionID: string;
  messageID: string;
  partID: string;
  callID: string;
  tool: 'bash' | 'shell';
}

export interface CommandDeadlineRecord {
  version: 1;
  fingerprint: CommandDeadlineFingerprint;
  directory: string;
  startedAt: number;
  deadlineAt: number;
  phase: 'active' | 'recovering' | 'unresolved';
  abortRequestedAt: number | null;
}

export interface CommandDeadlineRecoveryStatus {
  activeCount: number;
  recoveredCount: number;
  unresolvedCount: number;
  lastOutcome: 'recovered' | 'cleared' | 'unresolved' | null;
  lastError: string | null;
  updatedAt: number | null;
}

export const DEFAULT_COMMAND_TIMEOUT_MS: 240000;
export const MAX_COMMAND_TIMEOUT_MS: 3600000;
export const COMMAND_DEADLINE_GRACE_MS: 30000;
export const COMMAND_ABORT_CONFIRMATION_MS: 10000;

export function validateCommandDeadlineRecord(value: unknown): CommandDeadlineRecord;

export interface CommandDeadlineController {
  initialize(): Promise<void>;
  observe(payload: unknown, directory?: string | null): Promise<boolean>;
  reconcile(): Promise<void>;
  getStatus(): CommandDeadlineRecoveryStatus;
  drain(): Promise<void>;
}

export function createCommandDeadlineController(options: {
  store: RecordStore<CommandDeadlineRecord>;
  fetchMessage(input: CommandDeadlineFingerprint & { directory: string }): Promise<unknown>;
  abortSession(input: { sessionID: string; directory: string }): Promise<unknown>;
  publishPart?(input: { record: CommandDeadlineRecord; part: unknown }): unknown;
  listActiveSessions?(input: { directory: string }): Promise<Array<string | { sessionID?: string; sessionId?: string }>>;
  restartManagedRuntime?(input: { sessionID: string; directory: string }): Promise<unknown>;
  isExternalRuntime?(): boolean | Promise<boolean>;
  recordIncident?(incident: Record<string, unknown>): unknown;
  sanitizeError?(error: string): string;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  wait?: (milliseconds: number) => Promise<void>;
  graceMs?: number;
  confirmationMs?: number;
  confirmationPollMs?: number;
}): CommandDeadlineController;

export interface PromptAdmissionBlock {
  name: string;
  code: string;
  error: string;
  retryAfterSeconds: number;
}

export interface PromptAdmissionController {
  markReady(): void;
  beginDrain(): void;
  acquireHold(
    name: string,
    block?: Partial<Omit<PromptAdmissionBlock, 'name'>>,
  ): () => boolean;
  isReady(): boolean;
  isAccepting(): boolean;
  getBlock(): PromptAdmissionBlock | null;
}

export function createPromptAdmissionController(): PromptAdmissionController;

export function cleanupStaleAtomicFiles(
  filePath: string,
  options?: { staleAfterMs?: number; now?: () => number; fs?: unknown },
): Promise<number>;

export function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options?: {
    mode?: number;
    directoryMode?: number;
    encoding?: BufferEncoding;
    staleTmpAgeMs?: number;
    now?: () => number;
    randomId?: () => string;
    fs?: unknown;
  },
): Promise<void>;

export function withCrossProcessFileLock<T>(
  lockPath: string,
  callback: () => Promise<T> | T,
  options?: {
    timeoutMs?: number;
    retryMs?: number;
    malformedStaleMs?: number;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
    randomToken?: () => string;
    isProcessAlive?: (pid: number) => boolean;
    fs?: unknown;
  },
): Promise<T>;

export function readJsonGuarded<T = unknown>(
  filePath: string,
  options?: {
    maxBytes?: number;
    validate?: (value: unknown) => T;
    quarantineDir?: string;
    onQuarantine?: (input: { filePath: string; quarantinedPath: string; error: unknown }) => void;
    now?: () => number;
    randomId?: () => string;
    fs?: unknown;
  },
): Promise<T | null>;

export interface RecordStore<TRecord> {
  directory: string;
  initialize(): Promise<void>;
  readRecord(key: string): Promise<TRecord | null>;
  writeRecord(key: string, record: TRecord): Promise<TRecord>;
  deleteRecord(key: string): Promise<void>;
  listRecords(): Promise<Array<{ key: string; record: TRecord }>>;
  reconcile(
    reconciler: (record: TRecord, key: string) => Promise<TRecord | null | undefined> | TRecord | null | undefined,
  ): Promise<Array<{ key: string; action: string; record?: TRecord }>>;
  drain(): Promise<void>;
  getDiagnostics(): {
    directory: string;
    initialized: boolean;
    pendingWrites: number;
    quarantineCount: number;
  };
}

export function createRecordStore<TRecord>(options: {
  directory: string;
  version?: number;
  validateRecord?: (record: unknown, key: string) => TRecord;
  maxReadBytes?: number;
  logger?: Pick<Console, 'warn'>;
  fs?: unknown;
}): RecordStore<TRecord>;

export type TurnLifecycleEventType =
  | 'turn_started'
  | 'assistant_message_started'
  | 'tool_completed'
  | 'turn_completed'
  | 'turn_aborted'
  | 'turn_failed'
  | 'session_idle';

export interface TurnLifecycleEvent {
  type: TurnLifecycleEventType;
  turnID: string | null;
  sessionID: string | null;
  userMessageID: string | null;
  assistantMessageID: string | null;
  directory: string | null;
  at: number;
  [key: string]: unknown;
}

export interface LifecycleTracker {
  processEvent(payload: unknown): void;
  recordPromptAccepted(input: {
    sessionID?: string;
    sessionId?: string;
    messageID?: string;
    messageId?: string;
    directory?: string;
  }): unknown;
  subscribe(listener: (event: TurnLifecycleEvent) => void): () => void;
  getActiveTurn(sessionID: string): Record<string, unknown> | null;
}

export function createLifecycleTracker(options?: {
  clock?: () => number;
  onTurnEvent?: (event: TurnLifecycleEvent) => void;
  maxRetainedTurns?: number;
  maxCompletedTools?: number;
}): LifecycleTracker;

export interface PostCheckoutHookResult {
  presence: boolean;
  exitStatus: number;
  durationMs: number;
}

export interface PostCheckoutHookRunner {
  run(directory: string): Promise<PostCheckoutHookResult>;
}

export function createPostCheckoutHookRunner(options?: {
  gitBinary?: string;
  getGitBinary?: () => string;
  getEnv?: (directory: string) => Promise<NodeJS.ProcessEnv> | NodeJS.ProcessEnv;
  hookTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  maxFailureExcerptBytes?: number;
  now?: () => number;
}): PostCheckoutHookRunner;

export type WorktreeBootstrapStage =
  | 'prepare_remote'
  | 'create_worktree'
  | 'sync_project_metadata'
  | 'populate_worktree'
  | 'run_post_checkout_hook'
  | 'configure_upstream'
  | 'run_project_setup'
  | 'run_requested_setup'
  | 'complete';

export type WorktreeBootstrapStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'ready_with_warnings'
  | 'failed'
  | 'needs_attention'
  | 'removed'
  | 'not_applicable';

export interface WorktreeBootstrapReceipt {
  version: 3;
  ownerId: string;
  operationId: string | null;
  idempotencyKey: string | null;
  fingerprint: string | null;
  directory: string;
  stage: WorktreeBootstrapStage;
  status: WorktreeBootstrapStatus;
  stages: Partial<Record<WorktreeBootstrapStage, {
    status: 'queued' | 'running' | 'completed' | 'warning' | 'failed' | 'needs_attention' | 'skipped';
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    output?: unknown;
  }>>;
  attempt: number;
  tombstone: boolean;
  supersededAt?: number | null;
  warnings: Array<{ stage: WorktreeBootstrapStage; message: string; at: number }>;
  error: string | null;
  metadata: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: number | null;
  updatedAt: number;
}

export function validateWorktreeBootstrapReceipt(value: unknown): WorktreeBootstrapReceipt;

export interface WorktreeBootstrapRuntime {
  initialize(): Promise<void>;
  beginOperation(input: {
    idempotencyKey?: string;
    fingerprint?: string;
    request?: unknown;
    operationId?: string;
    directory: string;
    ownerId?: string;
    metadata?: Record<string, unknown>;
    result?: Record<string, unknown>;
    supersedeTerminal?: boolean;
  }): Promise<{ receipt: WorktreeBootstrapReceipt; replay: boolean }>;
  executeStage(
    operationId: string,
    stage: WorktreeBootstrapStage,
    effect?: (receipt: WorktreeBootstrapReceipt) => Promise<unknown> | unknown,
    options?: { skip?: boolean; failure?: 'warning' | 'failed' | 'needs_attention' },
  ): Promise<WorktreeBootstrapReceipt>;
  updateMetadata(operationId: string, patch: Record<string, unknown>): Promise<WorktreeBootstrapReceipt>;
  setResult(operationId: string, result: Record<string, unknown>): Promise<WorktreeBootstrapReceipt>;
  queue(operationId: string): Promise<WorktreeBootstrapReceipt>;
  complete(operationId: string): Promise<WorktreeBootstrapReceipt>;
  retry(operationId: string): Promise<WorktreeBootstrapReceipt>;
  fail(
    operationId: string,
    error: unknown,
    status?: 'failed' | 'needs_attention',
  ): Promise<WorktreeBootstrapReceipt>;
  markRemoved(directory: string): Promise<WorktreeBootstrapReceipt | null>;
  runDirectoryMaintenance<Result>(directory: string, effect: () => Promise<Result> | Result): Promise<Result>;
  getReceipt(operationId: string): Promise<WorktreeBootstrapReceipt>;
  getByIdempotency(idempotencyKey: string): Promise<WorktreeBootstrapReceipt | null>;
  getByDirectory(directory: string): Promise<WorktreeBootstrapReceipt>;
  listActive(): Promise<WorktreeBootstrapReceipt[]>;
  reconcileOnStartup(): Promise<string[]>;
  prune(): Promise<number>;
  drain(): Promise<void>;
  fingerprint(value: unknown): string;
}

export function createWorktreeBootstrapRuntime(options: {
  store: RecordStore<WorktreeBootstrapReceipt>;
  effects?: Partial<Record<WorktreeBootstrapStage, (receipt: WorktreeBootstrapReceipt) => Promise<unknown> | unknown>> & {
    now?: () => number;
    worktreeExists?: (directory: string) => Promise<boolean> | boolean;
  };
  retentionMs?: number;
  maxOperations?: number;
  onTransition?: (receipt: WorktreeBootstrapReceipt) => void;
}): WorktreeBootstrapRuntime;

export interface DiagnosticSanitizer {
  sanitizeRecord(record: unknown): Record<string, unknown>;
  sanitizeText(value: string): string;
  sanitizeExportValue(value: unknown): unknown;
  addKnownSecret(value: string): void;
  addPathMapping(path: string, placeholder: string): void;
  addWorktreeRoot(path: string): void;
  recordFailure(): void;
  getReport(): Record<string, unknown>;
}

export function createDiagnosticSanitizer(options?: {
  knownSecrets?: string[];
  homeDir?: string;
  dataDir?: string;
  worktreeRoots?: string[];
  pathMappings?: Array<{ path: string; placeholder: string }>;
}): DiagnosticSanitizer;

export type ContextModeRecoveryState =
  | 'healthy'
  | 'draining'
  | 'restarting'
  | 'external_action_required';

export interface ContextModeRecoveryStatus {
  state: ContextModeRecoveryState;
  incidentId: string | null;
  detectedAt: number | null;
  updatedAt: number;
  recoveredAt: number | null;
  occurrenceCount: number;
  restartAttempts: number;
  lastRestartError: string | null;
  outcome: 'recovered' | 'external_action_required' | null;
  guidance: string | null;
  transitions: Array<{ state: ContextModeRecoveryState; at: number; error?: string }>;
}

export interface DiagnosticsStatus {
  enabled: true;
  directory: string;
  diskBytes: number;
  maxBytes: number;
  segmentCount: number;
  sessionCount: number;
  queuedRecords: number;
  writtenRecords: number;
  gapRecords: number;
  lastError: string | null;
  contextModeRecovery?: ContextModeRecoveryStatus | null;
  commandDeadlineRecovery?: CommandDeadlineRecoveryStatus | null;
}

export interface JournalSessionManifest {
  version: 1;
  sessionID: string | null;
  parentID: string | null;
  title: string | null;
  directory: string | null;
  runtime: string;
  firstAt: number;
  lastAt: number;
  recordCounts: Record<string, number>;
  eventCounts: Record<string, number>;
  errorCount: number;
  gapCount: number;
  trimmedDeltas: number;
  coalescedParts: number;
  coalescedSessionUpdates: number;
  models: string[];
  chunkCount: number;
  bytes: number;
  rebuilt: boolean;
}

export interface DiagnosticJournal {
  initialize(): Promise<void>;
  enqueue(record: unknown): boolean;
  flush(options?: { rotate?: boolean }): Promise<void>;
  close(): Promise<void>;
  drain(options?: { rotate?: boolean }): Promise<void>;
  prune(): Promise<void>;
  listSegmentPaths(): Promise<string[]>;
  iterateRecords(options?: { segmentPaths?: string[] }): AsyncIterable<Record<string, unknown>>;
  readRecords(): Promise<Record<string, unknown>[]>;
  readBlob(relativePath: string): Promise<string>;
  listSessionManifests(): Promise<JournalSessionManifest[]>;
  getStatus(): Promise<DiagnosticsStatus>;
  clear(options?: { since?: number }): Promise<DiagnosticsStatus>;
}

export function createDiagnosticJournal(options: {
  directory: string;
  sanitizer: DiagnosticSanitizer;
  runtime?: string;
  maxQueue?: number;
  maxSegmentBytes?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  blobThresholdBytes?: number;
  maxOpenWriters?: number;
  trim?: boolean;
  trimDebounceMs?: number;
  trimMaxEntries?: number;
  trimMaxBytes?: number;
  now?: () => number;
  fs?: unknown;
  createReadStream?: (path: string, options?: unknown) => NodeJS.ReadableStream;
}): DiagnosticJournal;

export function resolveRecordSessionID(record: unknown): string;

export function resolveSessionRelation(record: unknown): {
  sessionID: string;
  parentID: string;
} | null;

export interface JournalTrimStats {
  trimmedDeltas: number;
  coalescedParts: number;
  coalescedSessionUpdates: number;
}

export function createJournalTrimmer(options?: {
  now?: () => number;
  onFlush?: (records: Record<string, unknown>[]) => void;
  debounceMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}): {
  admit(record: Record<string, unknown>): Record<string, unknown>[];
  flushAll(): Record<string, unknown>[];
  flushSession(sessionID: string): Record<string, unknown>[];
  stats(): Record<string, JournalTrimStats>;
  reset(): void;
};

export interface DiagnosticsExportScope {
  scope: 'runtime' | 'task';
  sessionID?: string;
  directory?: string;
}

export interface DiagnosticsExportBundle {
  fileName: string;
  manifest: Record<string, unknown>;
  redactionReport: Record<string, unknown>;
  files: Array<{
    name: string;
    data?: string;
    openStream?: () => NodeJS.ReadableStream;
  }>;
}

export function createDiagnosticsExport(options: {
  journal: DiagnosticJournal;
  sanitizer?: DiagnosticSanitizer;
  scope: DiagnosticsExportScope;
  receipts?: WorktreeBootstrapReceipt[];
  evidence?: EvidenceRecord[];
  now?: () => number;
}): Promise<DiagnosticsExportBundle>;

export function writeDiagnosticsZip(
  bundle: DiagnosticsExportBundle,
  options: {
    createArchive: () => {
      addBuffer(data: Buffer, name: string, options?: unknown): void;
      addReadStream(stream: NodeJS.ReadableStream, name: string, options?: unknown): void;
      end(): void;
    };
  },
): Promise<unknown>;

export interface EvidenceCapture {
  phase: 'before' | 'after';
  directory: string;
  ref: string;
  commit: string;
  tree: string;
  head: string | null;
  parent: string | null;
  contended: boolean;
  reusedTree?: boolean;
  createdAt: number;
}

export interface EvidenceGitRuntime {
  captureBefore(input: {
    directory: string;
    sessionID: string;
    turnID: string;
    signal?: AbortSignal;
  }): Promise<EvidenceCapture>;
  captureAfter(input: {
    directory: string;
    sessionID: string;
    turnID: string;
    beforeCommit: string;
    beforeTree?: string;
    beforeHead?: string | null;
    signal?: AbortSignal;
  }): Promise<EvidenceCapture>;
  diffSummary(input: {
    directory: string;
    beforeCommit: string;
    afterCommit: string;
    signal?: AbortSignal;
  }): Promise<string>;
  diffFile(input: {
    directory: string;
    beforeCommit: string;
    afterCommit: string;
    file: string;
    beforeFile?: string;
    signal?: AbortSignal;
  }): Promise<string>;
  fileMetadata(input: {
    directory: string;
    beforeCommit: string;
    afterCommit: string;
    file: string;
    beforeFile?: string;
    signal?: AbortSignal;
  }): Promise<{
    size: number;
    beforeSize: number | null;
    afterSize: number | null;
    sha256: string;
    gitBlob: string;
    source: 'before' | 'after';
  }>;
  deleteRef(input: { directory: string; ref: string; signal?: AbortSignal }): Promise<void>;
}

export function createEvidenceGitRuntime(options: {
  directory: string;
  timeoutMs?: number;
  now?: () => number;
  fs?: unknown;
  exec?: (input: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
}): EvidenceGitRuntime;

export interface EvidenceRecord {
  version: 1;
  checkpointID: string;
  directory: string;
  projectDirectory: string;
  sessionID: string;
  turnID: string;
  userMessageID: string | null;
  status: 'capturing_before' | 'capturing_after' | 'complete' | 'gap';
  before: EvidenceCapture | null;
  after: EvidenceCapture | null;
  contended: boolean;
  gapReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export function validateEvidenceRecord(value: unknown): EvidenceRecord;

export interface EvidenceLedger {
  initialize(): Promise<void>;
  begin(input: Partial<EvidenceRecord> & {
    directory: string;
    sessionID: string;
    turnID: string;
  }): Promise<EvidenceRecord>;
  setBefore(checkpointID: string, capture: EvidenceCapture): Promise<EvidenceRecord>;
  settle(checkpointID: string, capture: EvidenceCapture): Promise<EvidenceRecord>;
  markGap(checkpointID: string, reason: string): Promise<EvidenceRecord>;
  get(checkpointID: string): Promise<EvidenceRecord | null>;
  listBySession(input?: {
    sessionID?: string;
    directory?: string;
    userMessageID?: string;
  }): Promise<EvidenceRecord[]>;
  clearDirectory(directory: string): Promise<number>;
  clearProject(projectDirectory: string): Promise<number>;
  deleteSession(sessionID: string): Promise<number>;
  reconcile(reconciler: (record: EvidenceRecord) => Promise<void> | void): Promise<void>;
  prune(): Promise<number>;
  drain(): Promise<void>;
}

export function createEvidenceLedger(options: {
  store: RecordStore<EvidenceRecord>;
  now?: () => number;
  retentionMs?: number;
  maxTurnsPerRepository?: number;
  onTransition?: (record: EvidenceRecord) => void;
  deleteRef?: (input: { directory: string; ref: string }) => Promise<void>;
}): EvidenceLedger;

export interface TurnEvidenceRuntime {
  initialize(): Promise<void>;
  processLifecycleEvent(event: TurnLifecycleEvent): void;
  listBySession(input?: {
    sessionID?: string;
    directory?: string;
    userMessageID?: string;
  }): Promise<EvidenceRecord[]>;
  listPublicBySession(input?: {
    sessionID?: string;
    directory?: string;
    userMessageID?: string;
  }): Promise<Array<{
    checkpointID: string;
    directory: string;
    sessionID: string;
    turnID: string;
    userMessageID: string | null;
    status: EvidenceRecord['status'];
    contended: boolean;
    gapReason: string | null;
    createdAt: number;
    updatedAt: number;
  }>>;
  getDiff(checkpointID: string, file?: string): Promise<Record<string, unknown>>;
  clearDirectory(directory: string): Promise<number>;
  clearProject(projectDirectory: string): Promise<number>;
  deleteSession(sessionID: string): Promise<number>;
  beginDrain(): void;
  drain(): Promise<void>;
}

export function createTurnEvidenceRuntime(options: {
  ledger: EvidenceLedger;
  git: EvidenceGitRuntime;
  isEnabled(directory: string): Promise<boolean> | boolean;
  resolveProjectDirectory?(directory: string): Promise<string> | string;
  resolveSessionState?(record: EvidenceRecord): Promise<'busy' | 'running' | 'idle' | 'unknown'>;
  onGap?(input: Record<string, unknown>): void;
}): TurnEvidenceRuntime;

export function parseEvidenceNumstat(raw: string): Array<{
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}>;

export function toPublicEvidenceRecord(record: EvidenceRecord): Record<string, unknown>;
export type PrimaryRecoveryState = 'observing' | 'stopping' | 'reconciling' | 'recovery_reserved' | 'recovering' | 'completed' | 'needs_attention' | 'cancelled' | 'superseded';
export interface PrimaryRecoverySnapshot {
  schemaVersion: 1;
  mode: 'off' | 'observe' | 'enforce';
  supported: boolean;
  enforced: boolean;
  progressTimeoutMs: number | false;
  stopConfirmed?: boolean;
  record: null | {
    sessionID: string; anchorID: string; failedID: string | null; recoveryID: string | null;
    state: PrimaryRecoveryState; revision: number; attemptCount: number; maxAttempts: 1;
    readOnly: boolean; providerID: string; modelID: string; agent: string; variant: string | null;
    reason: string | null; updatedAt: number;
  };
}
export interface PrimaryRecoveryController {
  initialize(): Promise<void>;
  drain(): Promise<void>;
  observe(payload: unknown): void;
  reconcile(): Promise<void>;
  getSnapshot(sessionID: string): Promise<PrimaryRecoverySnapshot>;
  control(sessionID: string, action: string, expectedRevision?: number): Promise<PrimaryRecoverySnapshot>;
  plugin(input: Record<string, unknown>): Promise<unknown>;
}
export interface PrimaryRecoveryHost extends PrimaryRecoveryController {
  handleRequest(method: string, path: string, body: unknown, context?: { owner?: string | null }): Promise<null | { status: number; body: unknown }>;
}
export interface PrimaryRecoveryHostOptions {
  dataDirectory: string;
  mode?: 'off' | 'observe' | 'enforce';
  progressTimeoutMs?: number | false;
  buildOpenCodeUrl(pathname: string): string | URL;
  getOpenCodeAuthHeaders?(): Record<string, string>;
  isManaged(): boolean;
  authorize(record: { owner: string | null; sessionID: string; directory: string }): Promise<boolean>;
  managedBarrier(sessionID: string): Promise<unknown>;
  cancelDescendants?(sessionID: string): Promise<void>;
  publishEvent?(event: unknown, options?: { directory: string }): void | Promise<void>;
  recordIncident?(incident: { event: string; sessionID?: string; messageID?: string; [key: string]: unknown }): void;
  fetchImpl?: typeof fetch;
}
export function createPrimaryRecoveryHost(options: PrimaryRecoveryHostOptions): PrimaryRecoveryHost;
export function createPrimaryRecoveryManagedAdapter(rpc: (request: { method: string; params: Record<string, unknown> }) => Promise<unknown>): Pick<PrimaryRecoveryHostOptions, 'managedBarrier' | 'cancelDescendants'>;
export const PROVIDER_RECOVERY_POLICY_VERSION: 1;
export const PROVIDER_PROGRESS_TIMEOUT_MS: number;
export const RECOVERY_READ_TOOLS: readonly string[];
export const RECOVERY_CONTINUATION: string;
export function classifyPrimaryTransportError(error: unknown, runtimeVersion: string): null | { kind: string; source: string };
export interface PrimaryRecoveryExecutionRecord {
  sessionID: string; directory: string; anchorID: string; providerID: string; modelID: string;
  agent: string; variant: string | null; tools: Record<string, boolean>; owner: string | null;
  recoveryID: string | null; failedID: string | null; state: PrimaryRecoveryState; attemptCount: number;
  revision: number; guardedIDs: string[]; createdAt: number; updatedAt: number;
}
export function createPrimaryRecoveryController(options: {
  directory: string; mode?: 'off' | 'observe' | 'enforce'; progressTimeoutMs?: number | false;
  isManaged(): boolean;
  authorize(record: PrimaryRecoveryExecutionRecord): Promise<boolean>;
  observeTurn(record: PrimaryRecoveryExecutionRecord, options?: { signal: AbortSignal }): Promise<unknown>;
  abortSession(record: PrimaryRecoveryExecutionRecord): Promise<unknown>;
  promptSession(record: PrimaryRecoveryExecutionRecord, body: unknown): Promise<unknown>;
  publishEvent?: PrimaryRecoveryHostOptions['publishEvent'];
  recordIncident?: PrimaryRecoveryHostOptions['recordIncident'];
  now?(): number; wait?(ms: number): Promise<void>; pollMs?: number; settlementMs?: number;
  createMessageID?(): string;
  getToolPolicy?(record: PrimaryRecoveryExecutionRecord): Promise<{ toolIDs: string[]; allowedReadTools: string[] }>;
}): PrimaryRecoveryController & {
  admit(input: { sessionID: string; directory: string; primary: boolean; owner?: string | null; body: unknown }): Promise<unknown>;
  readRecord(sessionID: string): Promise<PrimaryRecoveryExecutionRecord | null>;
};
