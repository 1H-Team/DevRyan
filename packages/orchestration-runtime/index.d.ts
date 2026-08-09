export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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
export type ManagedTaskFailureKind = 'provider_usage_limit' | 'provider_prompt_rejected' | null;
export type ProviderTransportFailureKind =
  | 'request_timeout'
  | 'response_header_timeout'
  | 'stream_idle_timeout'
  | 'connection_failure';

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
  } | null>;
  readMessages(input: ManagedOpenCodeTransportInput): Promise<Array<{
    info?: Record<string, unknown>;
    parts?: Record<string, unknown>[];
  }>>;
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
  sourceTaskId: string;
  taskId: string;
  rootSessionId: string;
  childSessionId: string | null;
  directory: string;
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
export const PROVIDER_TRANSPORT_FAILURE_KINDS: readonly ProviderTransportFailureKind[];
export const MANAGED_RETRY_IN_PLACE_PROMPT: string;
export const MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT: string;
export const MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT: string;
export const MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT: string;
export const MANAGED_READ_ONLY_PROMPT: string;
export const DEFAULT_MANAGED_TERMINAL_MAX_RECORDS: number;
export const DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS: number;
export const DEFAULT_MANAGED_LEDGER_MAX_BYTES: number;

export function formatManagedTaskDisplayName(label: string): string;
export function classifyProviderRetryFailure(value: unknown): ManagedTaskFailureKind;
export function classifyProviderTransportFailure(
  name: unknown,
  detail: unknown,
): ProviderTransportFailureKind | null;
export function isDefiniteProviderUsageLimit(value: unknown): boolean;
export function isProviderPromptRejected(value: unknown): boolean;
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
  options?: { readOnly?: boolean },
): Readonly<Record<string, boolean>> | undefined;
export function createManagedOpenCodeExecutor(options: ManagedOpenCodeExecutorOptions): ManagedTaskExecutor;
export function createManagedTaskScheduler(options: ManagedTaskSchedulerOptions): ManagedTaskScheduler;
