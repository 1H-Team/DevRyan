export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ProviderToolCatalogEntry {
  id: string;
  description?: string;
  parameters?: JsonValue;
  [key: string]: unknown;
}

export function deriveXaiDuplicateToolOverrides(
  catalog: ProviderToolCatalogEntry[] | unknown,
): Record<string, false> | null;
export function isManagedModelAvailableInCatalog(
  payload: unknown,
  providerId: unknown,
  modelId: unknown,
): boolean | null;
export function isXaiProviderID(providerID: unknown): boolean;
export function listXaiModelIds(providerPayload: unknown): string[];
export function createXaiToolCatalogCache(options?: {
  now?: () => number;
  maxAgeMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}): {
  remember(input: {
    directory?: string | null;
    providerID: string;
    modelID: string;
    catalog: ProviderToolCatalogEntry[];
  }): Record<string, false> | null;
  get(input: {
    directory?: string | null;
    providerID: string;
    modelID: string;
  }): Record<string, false> | null;
  clear(): void;
};

export type ManagedTaskStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'interrupted';

export type ManagedTaskTerminalStatus = Extract<ManagedTaskStatus, 'completed' | 'failed' | 'aborted' | 'interrupted'>;
export type ManagedTaskMode = 'builder' | 'orchestrator';
export type ManagedTaskExecutionKind = 'start' | 'retry' | 'resume' | 'recover_in_place' | 'retry_in_place';
export type ManagedTaskResultAction = 'continue' | 'resume' | 'retry' | 'recover_in_place' | 'retry_in_place' | 'abandon';
export type ManagedTaskFailureKind =
  | 'provider_usage_limit'
  | 'provider_prompt_rejected'
  | 'model_unavailable'
  | 'deadline_exceeded'
  | null;
export type ProviderTransportFailureKind =
  | 'request_timeout'
  | 'response_header_timeout'
  | 'stream_idle_timeout'
  | 'connection_failure'
  | 'provider_queue_timeout';

export interface ManagedTaskCanonicalRef {
  type: string;
  id: string;
  [key: string]: JsonValue;
}

export interface ManagedTaskRecord {
  owner: 'devryan';
  taskId: string;
  idempotencyKey: string;
  rootSessionId: string;
  dispatchGroupId: string | null;
  dispatchCallId: string | null;
  parentTaskId: string | null;
  childSessionId: string | null;
  directory: string;
  sequence: number;
  mode: ManagedTaskMode;
  readOnly: boolean;
  providerId: string;
  modelId: string;
  agent: string;
  variant: string | null;
  label: string;
  prompt: string;
  status: ManagedTaskStatus;
  attempt: number;
  priorTaskId: string | null;
  executionKind: ManagedTaskExecutionKind;
  leaseToken: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  timeoutAt: number | null;
  failureReason: string | null;
  partial: boolean;
  recoverablePreview: string;
  canonicalRefs: ManagedTaskCanonicalRef[];
}

export function isManagedTaskAgentRetryAvailable(task: ManagedTaskRecord): boolean;

export type ManagedTaskEventRecord = Omit<ManagedTaskRecord,
  'prompt' | 'idempotencyKey' | 'dispatchGroupId' | 'readOnly' | 'leaseToken'> & {
    dispatchGrouped: boolean;
    failureKind: ManagedTaskFailureKind;
    agentRetryAvailable: boolean;
  };

export interface ManagedTaskResultEnvelope {
  owner: 'devryan';
  envelopeId: string;
  taskId: string;
  rootSessionId: string;
  parentTaskId: string | null;
  childSessionId: string | null;
  directory: string;
  sequence: number;
  status: ManagedTaskTerminalStatus;
  partial: boolean;
  failureReason: string | null;
  attempt: number;
  priorTaskId: string | null;
  executionKind: ManagedTaskExecutionKind;
  recoverablePreview: string;
  canonicalRefs: ManagedTaskCanonicalRef[];
  resumable: boolean;
  createdAt: number;
  acknowledgedAt: number | null;
  action: ManagedTaskResultAction | null;
  followUpTaskId: string | null;
}

export type ManagedResultMode = 'eager' | 'reference';

export interface ManagedResultReference {
  taskId: string;
  envelopeId: string;
  totalBytes: number;
  text: string;
  returnedBytes: number;
  nextCursor: string | null;
  complete: boolean;
}

export class ManagedResultReferenceError extends Error {
  code: 'invalid_result_cursor' | 'result_reference_mismatch';
  constructor(code: 'invalid_result_cursor' | 'result_reference_mismatch', message: string);
}

export interface ManagedTaskEvent {
  type: 'openchamber:managed-task';
  properties: {
    owner: 'devryan';
    directory: string;
    task: ManagedTaskEventRecord;
    resultEnvelope?: ManagedTaskResultEnvelope;
  };
}

export interface ManagedTaskRemovalEvent {
  type: 'openchamber:managed-task-removed';
  properties: {
    owner: 'devryan';
    taskId: string;
    rootSessionId: string;
    directory: string;
    sequence: number;
  };
}

export type ManagedOrchestrationEvent = ManagedTaskEvent | ManagedTaskRemovalEvent;

export interface ManagedTaskSubmitInput {
  idempotencyKey: string;
  rootSessionId: string;
  dispatchGroupId?: string | null;
  dispatchCallId?: string | null;
  parentTaskId?: string | null;
  childSessionId?: string | null;
  directory: string;
  mode: ManagedTaskMode;
  readOnly?: boolean;
  providerId: string;
  modelId: string;
  agent: string;
  variant?: string | null;
  label: string;
  prompt: string;
  attempt?: number;
  priorTaskId?: string | null;
  executionKind?: ManagedTaskExecutionKind;
  timeoutAt?: number | null;
}

export interface ManagedTaskExecutorResult {
  status: ManagedTaskTerminalStatus;
  failureReason?: string | null;
  partial?: boolean;
  recoverablePreview?: string;
  canonicalRefs?: ManagedTaskCanonicalRef[];
  resumable?: boolean;
}

export interface ManagedTaskControl {
  setChildSessionId(childSessionId: string): Promise<boolean>;
  markAccepted(): Promise<boolean>;
}

export type ManagedTaskReconciliation =
  | { state: 'live'; accepted?: boolean }
  | { state: 'relaunch' }
  | { state: 'terminal'; result: ManagedTaskExecutorResult }
  | { state: 'transient'; failureReason?: string }
  | {
      state: 'unavailable';
      failureReason?: string;
      recovery?: Omit<ManagedTaskExecutorResult, 'status'>;
    };

export interface ManagedTaskExecutor {
  start(task: ManagedTaskRecord, control: ManagedTaskControl): Promise<ManagedTaskExecutorResult>;
  resume?(task: ManagedTaskRecord, control: ManagedTaskControl): Promise<ManagedTaskExecutorResult>;
  retryInPlace?(task: ManagedTaskRecord, control: ManagedTaskControl): Promise<ManagedTaskExecutorResult>;
  observe?(task: ManagedTaskRecord, control: ManagedTaskControl): Promise<ManagedTaskExecutorResult>;
  abort(task: ManagedTaskRecord, options?: { signal?: AbortSignal }): Promise<{
    aborted: boolean;
    failureReason?: string;
  }>;
  reconcile(task: ManagedTaskRecord): Promise<ManagedTaskReconciliation>;
  readRecoverableResult(task: ManagedTaskRecord): Promise<Omit<ManagedTaskExecutorResult, 'status'>>;
  shutdown?(): Promise<void>;
}

export interface ManagedOpenCodeTransportInput {
  sessionId: string;
  directory: string;
  providerId: string;
}

export interface ManagedOpenCodeTransport {
  createSession(input: {
    directory: string;
    parentSessionId: string;
    title: string;
  }): Promise<{ id?: string } | null>;
  promptSession(input: ManagedOpenCodeTransportInput & {
    modelId: string;
    agent: string;
    variant: string | null;
    messageId?: string;
    prompt: string;
    tools?: Readonly<Record<string, boolean>>;
  }): Promise<void>;
  readSession(input: ManagedOpenCodeTransportInput): Promise<Record<string, unknown> | null>;
  readStatus(input: ManagedOpenCodeTransportInput): Promise<{
    type?: string;
    message?: string;
    attempt?: number;
    next?: number;
    action?: {
      reason?: string;
    };
  } | null>;
  readMessages(input: ManagedOpenCodeTransportInput): Promise<Array<{
    info?: Record<string, unknown>;
    parts?: Record<string, unknown>[];
  }>>;
  readTerminalError?(input: ManagedOpenCodeTransportInput & { after?: number }): Promise<{
    sessionId: string;
    observedAt: number;
    eventId: string | null;
    errorName: string;
    message: string;
    code: string | null;
    statusCode: number | null;
    retryable: boolean | null;
  } | null>;
  abortSession(input: ManagedOpenCodeTransportInput & { signal?: AbortSignal }): Promise<boolean>;
  deleteSession(input: ManagedOpenCodeTransportInput): Promise<boolean>;
}

export interface ManagedOpenCodeExecutorOptions {
  transport: ManagedOpenCodeTransport;
  pollIntervalMs?: number;
  idleStablePolls?: number;
  retryStopMaxAborts?: number;
  retryStopPollLimit?: number;
  /** How long an unreadable child may keep failing transiently before the wait
   * gives up with a resumable interruption instead of polling to the deadline. */
  observationFailureGraceMs?: number;
  /** How often a still-live child's transcript is re-read to refresh the
   * partial-work snapshot. Status is still polled at `pollIntervalMs`. */
  liveTranscriptRefreshMs?: number;
  /** How long a busy child with no running tool may make no transcript progress
   * before one bounded same-child timeout recovery is attempted. */
  liveProgressTimeoutMs?: number;
  /** Host-supplied text prepended (ahead of the Context Mode routing prefix) to a
   * task's first child prompt on `start` only; resume and retry-in-place
   * continuations never carry it. Return `null` for no preamble. */
  resolveTaskPromptPreamble?: (
    task: ManagedTaskRecord,
  ) => string | null | Promise<string | null>;
  /** Assistant-turn budget applied to every task unless `resolveTaskTurnBudget`
   * answers for it. At the budget the child is told once to wrap up; at budget +
   * `MANAGED_TURN_BUDGET_ABORT_GRACE_TURNS` it is aborted and reported as a
   * resumable failure. `null` (default) disables the backstop. */
  maxAssistantTurns?: number | null;
  /** Per-task turn budget. `null` disables the backstop for that task; `undefined`
   * falls back to `maxAssistantTurns`. */
  resolveTaskTurnBudget?: (task: ManagedTaskRecord) => number | null | undefined;
  now?: () => number;
  sleep?: (delayMs: number, options: { signal: AbortSignal }) => Promise<void>;
}

export interface ManagedOrchestrationState {
  version: 1;
  tasks: ManagedTaskRecord[];
  resultEnvelopes: ManagedTaskResultEnvelope[];
}

export interface ManagedOrchestrationPersistence {
  load(): Promise<ManagedOrchestrationState | null>;
  save(state: ManagedOrchestrationState): Promise<void>;
}

export interface ManagedTaskSchedulerOptions {
  executor: ManagedTaskExecutor;
  persistence?: ManagedOrchestrationPersistence;
  now?: () => number;
  createTaskId?: () => string;
  createLeaseToken?: () => string;
  publishEvent?: (event: ManagedOrchestrationEvent) => void | Promise<void>;
  logger?: Pick<Console, 'warn'>;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (timer: unknown) => void;
  abortTimeoutMs?: number;
  startingLeaseTimeoutMs?: number;
  reconciliationRetryMs?: number;
  providerRecoveryContinuationLeaseMs?: number;
  maxTerminalRecords?: number;
  maxHistoryAgeMs?: number;
  maxPersistedBytes?: number;
}

export interface ManagedTaskSchedulerDiagnostics {
  taskCount: number;
  activeLaunchCount: number;
  pendingCancellationCount: number;
  pendingAcknowledgementCount: number;
  activeHandoffCount: number;
  pendingWaiterCount: number;
  pendingTimeoutCount: number;
  pendingLeaseCount: number;
  pendingReconciliationRetryCount: number;
  activeProviderRecoveryContinuationClaimCount: number;
  compactedTaskCount: number;
  serializedBytes: number;
  shutDown: boolean;
}

export interface ManagedAgentHandoffScope {
  rootSessionId: string;
  fromMode: 'orchestrator';
  toMode: 'builder';
}

export interface ManagedAgentHandoffResult {
  state: 'clear' | 'confirmation_required' | 'blocked';
  taskIds: string[];
  failures: Array<{
    taskId: string;
    code: 'cleanup_failed';
    message: string;
  }>;
}

export interface ManagedProviderRecoveryContinuation {
  sourceTaskId: string | null;
  taskId: string;
  rootSessionId: string;
  childSessionId: string | null;
  directory: string;
  /**
   * Collectable unacknowledged terminals the idle parent may wait for and
   * disposition. The scheduler never emits parked Model Recovery results;
   * those stay on the unacknowledged envelope and the UI recovery card.
   */
  kind: 'collect';
}

export interface ManagedTaskScheduler {
  initialize(): Promise<void>;
  submit(input: ManagedTaskSubmitInput): Promise<ManagedTaskRecord>;
  cancelTask(taskId: string, options?: { cascade?: false; reason?: string }): Promise<ManagedTaskRecord>;
  cancelTask(taskId: string, options: { cascade: true; reason?: string }): Promise<ManagedTaskRecord[]>;
  waitForTask(taskId: string, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<ManagedTaskRecord>;
  waitForResultAction(taskId: string, options?: {
    signal?: AbortSignal;
  }): Promise<ManagedTaskResultEnvelope>;
  waitForDispatchBarrier(rootSessionId: string, options?: { signal?: AbortSignal }): Promise<{
    state: 'clear' | 'awaiting_acknowledgement';
    taskIds: string[];
  }>;
  inspectDispatchBarrier(rootSessionId: string): Promise<{
    state: 'clear' | 'active' | 'awaiting_acknowledgement';
    taskIds: string[];
  }>;
  listReadyProviderRecoveryContinuations(options?: {
    sessionId?: string;
  }): ManagedProviderRecoveryContinuation[];
  claimProviderRecoveryContinuation(input: {
    taskId: string;
    rootSessionId: string;
    directory: string;
    claimantId: string;
  }): Promise<{ claimed: boolean; expiresAt: number | null }>;
  releaseProviderRecoveryContinuation(input: {
    taskId: string;
    rootSessionId: string;
    directory: string;
    claimantId: string;
  }): Promise<{ released: boolean }>;
  inspectAgentHandoff(input: ManagedAgentHandoffScope): Promise<ManagedAgentHandoffResult>;
  confirmAgentHandoff(input: ManagedAgentHandoffScope & {
    idempotencyKey: string;
  }): Promise<ManagedAgentHandoffResult>;
  acknowledgeResult(taskId: string, options: {
    action: ManagedTaskResultAction;
    idempotencyKey: string;
    providerId?: string;
    modelId?: string;
    agent?: string;
    variant?: string | null;
    label?: string;
    prompt?: string;
    timeoutAt?: number | null;
  }): Promise<{ envelope: ManagedTaskResultEnvelope; followUpTask: ManagedTaskRecord | null }>;
  releaseModeLease(rootSessionId: string, mode: ManagedTaskMode): Promise<boolean>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  getTask(taskId: string): ManagedTaskRecord | null;
  listTasks(options?: { rootSessionId?: string }): ManagedTaskRecord[];
  getSnapshot(): ManagedOrchestrationState;
  getResultEnvelope(taskId: string): ManagedTaskResultEnvelope | null;
  listResultEnvelopes(options?: { rootSessionId?: string }): ManagedTaskResultEnvelope[];
  getDiagnostics(): ManagedTaskSchedulerDiagnostics;
}

export class ManagedOrchestrationError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export const MANAGED_TASK_OWNER: 'devryan';
export const MANAGED_TASK_STATUSES: readonly ManagedTaskStatus[];
export const MAX_MANAGED_TASK_LABEL_BYTES: number;
export const MAX_MANAGED_TASK_PROMPT_BYTES: number;
export const MAX_MANAGED_TASK_PREVIEW_BYTES: number;
export const MAX_MANAGED_TASK_FAILURE_BYTES: number;
export const PROVIDER_USAGE_LIMIT_FAILURE_KIND: 'provider_usage_limit';
export const PROVIDER_PROMPT_REJECTED_FAILURE_KIND: 'provider_prompt_rejected';
export const MODEL_UNAVAILABLE_FAILURE_KIND: 'model_unavailable';
export const PROVIDER_TRANSPORT_FAILURE_KINDS: readonly ProviderTransportFailureKind[];
export const MANAGED_RETRY_IN_PLACE_PROMPT: string;
export const MANAGED_RESUME_CONTINUATION_PROMPT: string;
export const MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT: string;
export const MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT: string;
export const MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT: string;
export const MANAGED_READ_ONLY_PROMPT: string;
export const MANAGED_CONTEXT_MODE_WRITABLE_PROMPT: string;
export const MANAGED_CONTEXT_MODE_READ_ONLY_PROMPT: string;
export const MANAGED_TURN_BUDGET_PROMPT: string;
export const MANAGED_TURN_BUDGET_ABORT_GRACE_TURNS: number;
export function isManagedTransientTransportContinuationPrompt(value: unknown): boolean;
export function isManagedResumeContinuationPrompt(value: unknown): boolean;
export function isManagedRetryInPlacePrompt(value: unknown): boolean;
export const DEFAULT_MANAGED_TERMINAL_MAX_RECORDS: number;
export const DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS: number;
export const DEFAULT_MANAGED_LEDGER_MAX_BYTES: number;
export const MANAGED_RESULT_PAGE_MAX_BYTES: number;
export const MANAGED_RESULT_MODES: readonly ManagedResultMode[];

export function formatManagedTaskDisplayName(label: string): string;
export function resolveManagedResultMode(value?: unknown): ManagedResultMode;
export function managedResultPayloadMatches(
  task: Partial<ManagedTaskRecord> | ManagedTaskEventRecord,
  resultEnvelope: ManagedTaskResultEnvelope,
): boolean;
export function projectManagedTaskResult<TTask extends Record<string, unknown>>(
  task: TTask,
  resultEnvelope: ManagedTaskResultEnvelope | null | undefined,
  resultMode?: ManagedResultMode,
): {
  task: TTask | Omit<TTask, 'recoverablePreview'>;
  resultEnvelope?: ManagedTaskResultEnvelope | Omit<ManagedTaskResultEnvelope, 'recoverablePreview'>;
  resultReference?: ManagedResultReference;
};
export function projectManagedResultEnvelope(
  task: Partial<ManagedTaskRecord> | ManagedTaskEventRecord,
  resultEnvelope: ManagedTaskResultEnvelope,
  resultMode?: ManagedResultMode,
): {
  resultEnvelope: ManagedTaskResultEnvelope | Omit<ManagedTaskResultEnvelope, 'recoverablePreview'>;
  resultReference?: ManagedResultReference;
};
export function readManagedResultReference(input: {
  task: Partial<ManagedTaskRecord> | ManagedTaskEventRecord;
  resultEnvelope: ManagedTaskResultEnvelope;
  resultCursor: string;
}): ManagedResultReference;
export function createKeyedSingleFlight(): {
  run<T>(key: string, operation: () => T | PromiseLike<T>): Promise<T>;
};
export function classifyProviderRetryFailure(value: unknown): ManagedTaskFailureKind;
export function classifyProviderRetryStatus(value: unknown): ManagedTaskFailureKind;
export function classifyProviderTransportFailure(
  name: unknown,
  detail: unknown,
): ProviderTransportFailureKind | null;
export function isDefiniteProviderUsageLimit(value: unknown): boolean;
export function isProviderPromptRejected(value: unknown): boolean;
export const DEADLINE_EXCEEDED_FAILURE_KIND: 'deadline_exceeded';
export const MANAGED_TASK_TIMEOUT_REASON_PREFIX: string;
export function isManagedTaskDeadlineExceeded(value: unknown): boolean;
export function isManagedTaskModelUnavailable(value: unknown): boolean;
export function classifyManagedTaskFailure(value: unknown): ManagedTaskFailureKind;
export function createManagedTerminalErrorRegistry(options?: {
  now?: () => number;
  maximumSessions?: number;
}): {
  record(payload: unknown, options?: { observedAt?: number }): boolean;
  observe(payload: unknown, options?: { observedAt?: number }): boolean;
  read(input?: { sessionId?: string; after?: number }): {
    sessionId: string;
    observedAt: number;
    eventId: string | null;
    errorName: string;
    message: string;
    code: string | null;
    statusCode: number | null;
    retryable: boolean | null;
  } | null;
  remove(sessionId: unknown): boolean;
  clear(): void;
  readonly size: number;
};
export function truncateManagedText(value: unknown, maxBytes: number): string;
export function isTerminalManagedTaskStatus(status: unknown): status is ManagedTaskTerminalStatus;
export function validateManagedTaskRecord(task: unknown): ManagedTaskRecord;
export function createManagedTaskRecord(input: Omit<ManagedTaskRecord,
  | 'owner'
  | 'status'
  | 'dispatchGroupId'
  | 'dispatchCallId'
  | 'readOnly'
  | 'childSessionId'
  | 'leaseToken'
  | 'startedAt'
  | 'finishedAt'
  | 'failureReason'
  | 'partial'
  | 'recoverablePreview'
  | 'canonicalRefs'
> & {
  childSessionId?: string | null;
  dispatchGroupId?: string | null;
  dispatchCallId?: string | null;
  readOnly?: boolean;
}): ManagedTaskRecord;
export function toManagedTaskEvent(task: ManagedTaskRecord, resultEnvelope?: ManagedTaskResultEnvelope | null): ManagedTaskEvent;
export function toManagedTaskRemovalEvent(task: ManagedTaskRecord): ManagedTaskRemovalEvent;
export function createManagedTaskResultEnvelope(task: ManagedTaskRecord, options: {
  sequence: number;
  createdAt: number;
  resumable: boolean;
}): ManagedTaskResultEnvelope;
export function validateManagedTaskResultEnvelope(envelope: unknown): ManagedTaskResultEnvelope;
export function assertManagedTaskResultEnvelopeMatchesTask(task: ManagedTaskRecord, envelope: ManagedTaskResultEnvelope): ManagedTaskResultEnvelope;
export function canTransitionManagedTaskStatus(from: ManagedTaskStatus, to: ManagedTaskStatus): boolean;
export function assertManagedTaskTransition(previous: ManagedTaskRecord, next: ManagedTaskRecord): ManagedTaskRecord;
export function compareManagedTaskQueueOrder(left: Pick<ManagedTaskRecord, 'sequence' | 'createdAt' | 'taskId'>, right: Pick<ManagedTaskRecord, 'sequence' | 'createdAt' | 'taskId'>): number;
export function compactManagedOrchestrationState(state: ManagedOrchestrationState, options?: {
  now?: number;
  maxTerminalRecords?: number;
  maxAgeMs?: number;
  maxBytes?: number;
}): {
  state: ManagedOrchestrationState;
  removedTaskIds: string[];
  serializedBytes: number;
  overLimit: boolean;
};
export function resolveProviderPromptTools(
  providerId: unknown,
  agent?: unknown,
  options?: {
    readOnly?: boolean;
    planMode?: boolean;
    /** Verified managed OpenCode capability advertised by `/api/health`. */
    contextModeAvailable?: boolean;
    /** Verified managed-runtime capability advertised by `/api/health`. */
    contextModeReadOnlyIndexing?: boolean;
  },
): Readonly<Record<string, boolean>> | undefined;
export const MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED: 'MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED';
export const MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE: string;
export function supportsManagedReadOnlyProvider(providerId: unknown): boolean;
export const MANAGED_READ_ONLY_AGENT_UNSUPPORTED: 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED';
export const MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE: string;
export function supportsManagedReadOnlyAgent(agent: unknown): boolean;
export function createManagedOpenCodeExecutor(options: ManagedOpenCodeExecutorOptions): ManagedTaskExecutor;
export type ManagedAgentContractRole = 'designer' | 'fixer' | 'explorer' | 'librarian' | 'oracle';
export const MANAGED_AGENT_CONTRACT_TAG: '[devryan-agent-contract:v1]';
export const MANAGED_AGENT_CONTRACT_MAX_LINES: number;
export const MANAGED_AGENT_CONTRACT_DEFAULT_ROLE: 'default';
export const MANAGED_AGENT_CONTRACT_ROLES: readonly ManagedAgentContractRole[];
export function normalizeManagedAgentContractRole(agent: unknown): ManagedAgentContractRole | 'default';
/** Compact per-role rules (terminal marker, owned target set, git boundary,
 * validation budget, foreign-changes scope) for a managed child whose agent
 * instructions are not loaded, e.g. Anthropic-routed tasks in Claude
 * compatibility mode. Always at most `MANAGED_AGENT_CONTRACT_MAX_LINES` lines. */
export function buildManagedAgentContract(input?: { agent?: string | null }): string;
export function createManagedTaskScheduler(options: ManagedTaskSchedulerOptions): ManagedTaskScheduler;
