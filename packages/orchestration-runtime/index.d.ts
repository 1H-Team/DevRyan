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
export type ManagedTaskExecutionKind = 'start' | 'retry' | 'resume' | 'retry_in_place';
export type ManagedTaskResultAction = 'continue' | 'resume' | 'retry' | 'retry_in_place' | 'abandon';

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
  parentTaskId: string | null;
  childSessionId: string | null;
  directory: string;
  sequence: number;
  mode: ManagedTaskMode;
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

export type ManagedTaskEventRecord = Omit<ManagedTaskRecord, 'prompt' | 'idempotencyKey' | 'leaseToken'>;

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
  parentTaskId?: string | null;
  childSessionId?: string | null;
  directory: string;
  mode: ManagedTaskMode;
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
  setChildSessionId(childSessionId: string): Promise<void>;
  markAccepted(): Promise<void>;
}

export type ManagedTaskReconciliation =
  | { state: 'live'; accepted?: boolean }
  | { state: 'terminal'; result: ManagedTaskExecutorResult }
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
  abort(task: ManagedTaskRecord): Promise<{ aborted: boolean; failureReason?: string }>;
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
  abortSession(input: ManagedOpenCodeTransportInput): Promise<boolean>;
}

export interface ManagedOpenCodeExecutorOptions {
  transport: ManagedOpenCodeTransport;
  pollIntervalMs?: number;
  idleStablePolls?: number;
  retryStopMaxAborts?: number;
  retryStopPollLimit?: number;
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
  maxConcurrency?: number;
  now?: () => number;
  createTaskId?: () => string;
  createLeaseToken?: () => string;
  publishEvent?: (event: ManagedOrchestrationEvent) => void | Promise<void>;
  logger?: Pick<Console, 'warn'>;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (timer: unknown) => void;
  abortTimeoutMs?: number;
  startingLeaseTimeoutMs?: number;
  maxTerminalRecords?: number;
  maxHistoryAgeMs?: number;
  maxPersistedBytes?: number;
}

export interface ManagedTaskSchedulerDiagnostics {
  taskCount: number;
  activeLaunchCount: number;
  pendingCancellationCount: number;
  pendingAcknowledgementCount: number;
  pendingWaiterCount: number;
  pendingTimeoutCount: number;
  pendingLeaseCount: number;
  compactedTaskCount: number;
  serializedBytes: number;
  shutDown: boolean;
}

export interface ManagedTaskScheduler {
  initialize(): Promise<void>;
  submit(input: ManagedTaskSubmitInput): Promise<ManagedTaskRecord>;
  cancelTask(taskId: string, options?: { cascade?: false; reason?: string }): Promise<ManagedTaskRecord>;
  cancelTask(taskId: string, options: { cascade: true; reason?: string }): Promise<ManagedTaskRecord[]>;
  waitForTask(taskId: string, options?: { signal?: AbortSignal }): Promise<ManagedTaskRecord>;
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
export const DEFAULT_MANAGED_TERMINAL_MAX_RECORDS: number;
export const DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS: number;
export const DEFAULT_MANAGED_LEDGER_MAX_BYTES: number;

export function formatManagedTaskDisplayName(label: string): string;
export function truncateManagedText(value: unknown, maxBytes: number): string;
export function isTerminalManagedTaskStatus(status: unknown): status is ManagedTaskTerminalStatus;
export function validateManagedTaskRecord(task: unknown): ManagedTaskRecord;
export function createManagedTaskRecord(input: Omit<ManagedTaskRecord,
  | 'owner'
  | 'status'
  | 'childSessionId'
  | 'leaseToken'
  | 'startedAt'
  | 'finishedAt'
  | 'failureReason'
  | 'partial'
  | 'recoverablePreview'
  | 'canonicalRefs'
> & { childSessionId?: string | null }): ManagedTaskRecord;
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
export function resolveProviderPromptTools(providerId: unknown): Readonly<Record<string, boolean>> | undefined;
export function createManagedOpenCodeExecutor(options: ManagedOpenCodeExecutorOptions): ManagedTaskExecutor;
export function createManagedTaskScheduler(options: ManagedTaskSchedulerOptions): ManagedTaskScheduler;
