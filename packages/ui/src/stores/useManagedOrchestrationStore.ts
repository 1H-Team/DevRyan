import { create } from 'zustand';
import {
  canTransitionManagedTaskStatus,
  classifyManagedTaskFailure,
  isTerminalManagedTaskStatus,
  MAX_MANAGED_TASK_FAILURE_BYTES,
  MAX_MANAGED_TASK_LABEL_BYTES,
  MAX_MANAGED_TASK_PREVIEW_BYTES,
  truncateManagedText,
  validateManagedTaskResultEnvelope,
  type ManagedTaskEvent,
  type ManagedTaskRemovalEvent,
  type ManagedTaskResultAction,
  type ManagedTaskStatus,
} from '@openchamber/orchestration-runtime';

import {
  managedOrchestrationApi,
  type ManagedOrchestrationApi,
  type ManagedOrchestrationSnapshot,
  type ManagedTaskAutoResume,
  type ManagedTaskAutoResumeReason,
  type ManagedTaskAutoResumeResetSource,
  type ManagedTaskAutoResumeState,
  type ManagedTaskProjectedEnvelope,
  type ManagedTaskProjectedRecord,
  type ManagedTaskWaitingReason,
  type ManagedTaskWaitingReasonKind,
} from '@/lib/orchestrationApi';

const MANAGED_TASK_STATUSES = new Set<ManagedTaskStatus>([
  'queued',
  'starting',
  'running',
  'completed',
  'failed',
  'aborted',
  'interrupted',
]);
const IMMUTABLE_PROJECTED_TASK_FIELDS = [
  'owner',
  'taskId',
  'rootSessionId',
  'dispatchCallId',
  'dispatchGrouped',
  'dispatchWaveId',
  'parentTaskId',
  'directory',
  'sequence',
  'mode',
  'providerId',
  'modelId',
  'agent',
  'variant',
  'label',
  'attempt',
  'priorTaskId',
  'executionKind',
  'createdAt',
  'timeoutAt',
  'recoveryLineageId',
] as const satisfies readonly (keyof ManagedTaskProjectedRecord)[];
const EMPTY_TASK_IDS: readonly string[] = Object.freeze([]);
const MANAGED_TASK_AUTO_RESUME_STATES = new Set<ManagedTaskAutoResumeState>([
  'planning',
  'scheduled',
  'attempting',
  'superseded',
  'succeeded',
  'ended',
  'cancelled',
  'exhausted',
  'acknowledged',
]);
const MANAGED_TASK_AUTO_RESUME_REASONS = new Set<ManagedTaskAutoResumeReason>([
  'user',
  'manual_retry',
  'session_deleted',
  'cancelled',
  'attempt_cap',
  'time_cap',
  'host_failures',
  'window_rejections',
]);

const MANAGED_TASK_AUTO_RESUME_RESET_SOURCES = new Set<ManagedTaskAutoResumeResetSource>([
  'opencode_status',
  'meridian_quota',
  'backoff',
]);
const MANAGED_TASK_WAITING_REASON_KINDS = new Set<ManagedTaskWaitingReasonKind>([
  'capacity',
  'system_pressure',
]);

export type ManagedTaskPendingAction = 'cancel' | 'auto_resume' | ManagedTaskResultAction;

export type ManagedRootDelegationPhase = 'starting' | 'waiting' | null;

type ManagedOrchestrationWarningEvent = {
  type: 'openchamber:managed-orchestration-warning';
  properties: { message: string };
};

type ParsedManagedTaskProjection = {
  task: ManagedTaskProjectedRecord;
  envelope: ManagedTaskProjectedEnvelope | null;
};

type ParsedManagedOrchestrationSnapshot = Omit<ManagedOrchestrationSnapshot, 'tasks' | 'resultEnvelopes'> & {
  tasks: ManagedTaskProjectedRecord[];
  resultEnvelopes: ManagedTaskProjectedEnvelope[];
};

export type ManagedOrchestrationUiEvent = ManagedTaskEvent | ManagedTaskRemovalEvent | ManagedOrchestrationWarningEvent;

export type ManagedOrchestrationStore = {
  tasksById: Readonly<Record<string, ManagedTaskProjectedRecord>>;
  taskIdsByRootId: Readonly<Record<string, readonly string[]>>;
  resultEnvelopesByTaskId: Readonly<Record<string, ManagedTaskProjectedEnvelope>>;
  latestTaskIdByChildSessionId: Readonly<Record<string, string>>;
  manualRecoveryTaskIdByChildSessionId: Readonly<Record<string, string>>;
  available: boolean | null;
  bridgeReady: boolean;
  recoveryWarning: string | null;
  isLoadingSnapshot: boolean;
  snapshotError: string | null;
  pendingActionByTaskId: Readonly<Record<string, ManagedTaskPendingAction>>;
  actionErrorByTaskId: Readonly<Record<string, string>>;
  ingestEvent(event: unknown): void;
  loadSnapshot(options?: { rootSessionId?: string }): Promise<void>;
  cancelTask(taskId: string, options?: { cascade?: boolean; reason?: string }): Promise<void>;
  acknowledgeTask(taskId: string, action: ManagedTaskResultAction, selection?: {
    providerId: string;
    modelId: string;
    variant: string | null;
  }): Promise<void>;
  setAutoResume(taskId: string, enabled: boolean): Promise<void>;
  reset(): void;
};

const initialState = () => ({
  tasksById: {} as Readonly<Record<string, ManagedTaskProjectedRecord>>,
  taskIdsByRootId: {} as Readonly<Record<string, readonly string[]>>,
  resultEnvelopesByTaskId: {} as Readonly<Record<string, ManagedTaskProjectedEnvelope>>,
  latestTaskIdByChildSessionId: {} as Readonly<Record<string, string>>,
  manualRecoveryTaskIdByChildSessionId: {} as Readonly<Record<string, string>>,
  available: null as boolean | null,
  bridgeReady: false,
  recoveryWarning: null as string | null,
  isLoadingSnapshot: false,
  snapshotError: null as string | null,
  pendingActionByTaskId: {} as Readonly<Record<string, ManagedTaskPendingAction>>,
  actionErrorByTaskId: {} as Readonly<Record<string, string>>,
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isOptionalNullableString = (value: unknown): value is string | null | undefined => (
  value === undefined || isNullableString(value)
);
const isTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);
const isNullableTimestamp = (value: unknown): value is number | null => value === null || isTimestamp(value);
const isOptionalNullableTimestamp = (value: unknown): value is number | null | undefined => (
  value === undefined || isNullableTimestamp(value)
);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

const isCanonicalReference = (value: unknown) => (
  isRecord(value)
  && typeof value.type === 'string'
  && Boolean(value.type.trim())
  && typeof value.id === 'string'
  && Boolean(value.id.trim())
);

/**
 * Why a queued task has not started. A malformed value degrades to "no
 * reason" instead of rejecting the task, and only a queued task carries one.
 */
export const parseManagedTaskWaitingReason = (value: unknown): ManagedTaskWaitingReason | null => {
  if (!isRecord(value)) return null;
  if (!MANAGED_TASK_WAITING_REASON_KINDS.has(value.kind as ManagedTaskWaitingReasonKind)) return null;
  if (!isCount(value.activeCount)) return null;
  if (value.limit !== null && !isCount(value.limit)) return null;
  if (!isTimestamp(value.since)) return null;
  return {
    kind: value.kind as ManagedTaskWaitingReasonKind,
    activeCount: value.activeCount as number,
    limit: value.limit as number | null,
    since: value.since as number,
  };
};

const parseManagedTaskEventRecord = (value: unknown): ManagedTaskProjectedRecord | null => {
  if (!isRecord(value)) return null;
  const valid = value.owner === 'devryan'
    && typeof value.taskId === 'string'
    && value.taskId.startsWith('dvr_task_')
    && typeof value.rootSessionId === 'string'
    && Boolean(value.rootSessionId.trim())
    && isOptionalNullableString(value.dispatchCallId)
    && (value.dispatchGrouped === undefined || typeof value.dispatchGrouped === 'boolean')
    && isOptionalNullableString(value.dispatchWaveId)
    && isNullableString(value.parentTaskId)
    && isNullableString(value.childSessionId)
    && typeof value.directory === 'string'
    && Boolean(value.directory.trim())
    && Number.isSafeInteger(value.sequence)
    && Number(value.sequence) > 0
    && (value.mode === 'builder' || value.mode === 'orchestrator')
    && typeof value.providerId === 'string'
    && Boolean(value.providerId.trim())
    && typeof value.modelId === 'string'
    && Boolean(value.modelId.trim())
    && typeof value.agent === 'string'
    && Boolean(value.agent.trim())
    && isNullableString(value.variant)
    && typeof value.label === 'string'
    && MANAGED_TASK_STATUSES.has(value.status as ManagedTaskStatus)
    && Number.isSafeInteger(value.attempt)
    && Number(value.attempt) > 0
    && isNullableString(value.priorTaskId)
    && (value.executionKind === 'start' || value.executionKind === 'retry' || value.executionKind === 'resume' || value.executionKind === 'recover_in_place' || value.executionKind === 'retry_in_place')
    && isTimestamp(value.createdAt)
    && isNullableTimestamp(value.startedAt)
    && isNullableTimestamp(value.finishedAt)
    && isNullableTimestamp(value.timeoutAt)
    && isNullableString(value.failureReason)
    && (
      value.failureKind === undefined
      || value.failureKind === null
      || value.failureKind === 'provider_usage_limit'
      || value.failureKind === 'provider_prompt_rejected'
      || value.failureKind === 'model_unavailable'
      || value.failureKind === 'deadline_exceeded'
    )
    && typeof value.partial === 'boolean'
    && typeof value.recoverablePreview === 'string'
    && Array.isArray(value.canonicalRefs)
    && value.canonicalRefs.every(isCanonicalReference)
    && typeof value.agentRetryAvailable === 'boolean'
    // Automatic-recovery fields; absent on older hosts.
    && isOptionalNullableString(value.recoveryLineageId)
    && isOptionalNullableTimestamp(value.childPromptedAt)
    && isOptionalNullableTimestamp(value.firstAssistantPartAt);
  if (!valid) return null;
  return {
    owner: 'devryan',
    taskId: value.taskId as string,
    rootSessionId: value.rootSessionId as string,
    dispatchCallId: value.dispatchCallId === null || value.dispatchCallId === undefined
      ? null
      : truncateManagedText(value.dispatchCallId, 1_024),
    dispatchGrouped: value.dispatchGrouped === true,
    // Display-only wave label; absent on hosts predating it. Only a well-formed
    // `dvr_wave_` id is kept so the chat never groups cards by an arbitrary string.
    dispatchWaveId: typeof value.dispatchWaveId === 'string' && value.dispatchWaveId.startsWith('dvr_wave_')
      ? truncateManagedText(value.dispatchWaveId, 1_024)
      : null,
    parentTaskId: value.parentTaskId as string | null,
    childSessionId: value.childSessionId as string | null,
    directory: value.directory as string,
    sequence: value.sequence as number,
    mode: value.mode as ManagedTaskProjectedRecord['mode'],
    providerId: truncateManagedText(value.providerId, 1_024),
    modelId: truncateManagedText(value.modelId, 1_024),
    agent: truncateManagedText(value.agent, 1_024),
    variant: value.variant === null ? null : truncateManagedText(value.variant, 1_024),
    label: truncateManagedText(value.label, MAX_MANAGED_TASK_LABEL_BYTES),
    status: value.status as ManagedTaskStatus,
    attempt: value.attempt as number,
    priorTaskId: value.priorTaskId as string | null,
    executionKind: value.executionKind as ManagedTaskProjectedRecord['executionKind'],
    createdAt: value.createdAt as number,
    startedAt: value.startedAt as number | null,
    finishedAt: value.finishedAt as number | null,
    timeoutAt: value.timeoutAt as number | null,
    failureReason: value.failureReason === null
      ? null
      : truncateManagedText(value.failureReason, MAX_MANAGED_TASK_FAILURE_BYTES),
    failureKind: value.failureKind === 'provider_usage_limit'
      || value.failureKind === 'provider_prompt_rejected'
      || value.failureKind === 'model_unavailable'
      || value.failureKind === 'deadline_exceeded'
      ? value.failureKind
      : classifyManagedTaskFailure(value.failureReason),
    partial: value.partial as boolean,
    recoverablePreview: truncateManagedText(value.recoverablePreview, MAX_MANAGED_TASK_PREVIEW_BYTES),
    canonicalRefs: (value.canonicalRefs as Array<{ type: string; id: string }>)
      .slice(0, 512)
      .map((reference) => ({
        type: truncateManagedText(reference.type, 1_024),
        id: truncateManagedText(reference.id, 1_024),
      })),
    agentRetryAvailable: value.agentRetryAvailable as boolean,
    recoveryLineageId: typeof value.recoveryLineageId === 'string'
      ? truncateManagedText(value.recoveryLineageId, 1_024)
      : null,
    childPromptedAt: isTimestamp(value.childPromptedAt) ? value.childPromptedAt : null,
    firstAssistantPartAt: isTimestamp(value.firstAssistantPartAt) ? value.firstAssistantPartAt : null,
    // Queued-only scheduler state; a stale reason on a started task is dropped.
    waitingReason: value.status === 'queued' ? parseManagedTaskWaitingReason(value.waitingReason) : null,
  };
};

export const isManagedTaskEventRecord = (value: unknown): value is ManagedTaskProjectedRecord => (
  parseManagedTaskEventRecord(value) !== null
);

const parseManagedTaskAutoResumeTarget = (
  value: unknown,
): ManagedTaskAutoResume['target'] | undefined => {
  if (value === null) return null;
  if (
    !isRecord(value)
    || (value.kind !== 'backup' && value.kind !== 'original')
    || typeof value.providerId !== 'string'
    || !value.providerId.trim()
    || typeof value.modelId !== 'string'
    || !value.modelId.trim()
    || !isNullableString(value.variant)
  ) return undefined;
  return {
    kind: value.kind as 'backup' | 'original',
    providerId: truncateManagedText(value.providerId, 1_024),
    modelId: truncateManagedText(value.modelId, 1_024),
    variant: value.variant === null ? null : truncateManagedText(value.variant, 1_024),
  };
};

const parseManagedTaskAutoResumeError = (
  value: unknown,
): ManagedTaskAutoResume['lastError'] | undefined => {
  if (value === null) return null;
  if (
    !isRecord(value)
    || typeof value.code !== 'string'
    || !value.code.trim()
    || typeof value.message !== 'string'
    || !isTimestamp(value.at)
  ) return undefined;
  return {
    code: truncateManagedText(value.code, 1_024),
    message: truncateManagedText(value.message, MAX_MANAGED_TASK_FAILURE_BYTES),
    at: value.at,
  };
};

/**
 * Validates the host's auto-resume block on a result envelope. Returns null for
 * anything that is not a complete, well-typed block so a malformed host payload
 * degrades to "no automatic recovery" instead of dropping the envelope.
 */
export const parseManagedTaskAutoResume = (value: unknown): ManagedTaskAutoResume | null => {
  if (!isRecord(value)) return null;
  const target = parseManagedTaskAutoResumeTarget(value.target);
  const lastError = parseManagedTaskAutoResumeError(value.lastError);
  if (target === undefined || lastError === undefined) return null;
  const valid = isCount(value.revision)
    && typeof value.enabled === 'boolean'
    && MANAGED_TASK_AUTO_RESUME_STATES.has(value.state as ManagedTaskAutoResumeState)
    && isCount(value.cancelGeneration)
    && isTimestamp(value.lineageStartedAt)
    && isTimestamp(value.expiresAt)
    && isCount(value.attemptCount)
    && isCount(value.noSignalProbes)
    && isCount(value.rejectionsInWindow)
    && isNullableTimestamp(value.windowResetAt)
    && isNullableTimestamp(value.nextAttemptAt)
    && isNullableTimestamp(value.resetAt)
    && (
      value.resetSource === null
      || MANAGED_TASK_AUTO_RESUME_RESET_SOURCES.has(value.resetSource as ManagedTaskAutoResumeResetSource)
    )
    && isNullableString(value.lastAttemptTaskId)
    && isNullableTimestamp(value.lastAttemptAt)
    && isCount(value.hostFailures)
    && isNullableString(value.reason);
  if (!valid) return null;
  return {
    revision: value.revision as number,
    enabled: value.enabled as boolean,
    state: value.state as ManagedTaskAutoResumeState,
    cancelGeneration: value.cancelGeneration as number,
    lineageStartedAt: value.lineageStartedAt as number,
    expiresAt: value.expiresAt as number,
    attemptCount: value.attemptCount as number,
    noSignalProbes: value.noSignalProbes as number,
    rejectionsInWindow: value.rejectionsInWindow as number,
    windowResetAt: value.windowResetAt as number | null,
    nextAttemptAt: value.nextAttemptAt as number | null,
    resetAt: value.resetAt as number | null,
    resetSource: value.resetSource as ManagedTaskAutoResumeResetSource | null,
    target,
    lastAttemptTaskId: value.lastAttemptTaskId === null
      ? null
      : truncateManagedText(value.lastAttemptTaskId, 1_024),
    lastAttemptAt: value.lastAttemptAt as number | null,
    lastError,
    hostFailures: value.hostFailures as number,
    // Unknown reasons from a newer host degrade to null instead of dropping the state.
    reason: MANAGED_TASK_AUTO_RESUME_REASONS.has(value.reason as ManagedTaskAutoResumeReason)
      ? (value.reason as ManagedTaskAutoResumeReason)
      : null,
  };
};

const parseEnvelope = (value: unknown): ManagedTaskProjectedEnvelope | null => {
  try {
    const envelope = validateManagedTaskResultEnvelope(value);
    if (!envelope.canonicalRefs.every(isCanonicalReference)) return null;
    // The runtime validator ignores the automatic-recovery fields; read them off the raw payload.
    const raw = envelope as unknown as Record<string, unknown>;
    return {
      owner: 'devryan',
      envelopeId: envelope.envelopeId,
      taskId: envelope.taskId,
      rootSessionId: envelope.rootSessionId,
      parentTaskId: envelope.parentTaskId,
      childSessionId: envelope.childSessionId,
      directory: envelope.directory,
      sequence: envelope.sequence,
      status: envelope.status,
      partial: envelope.partial,
      failureReason: envelope.failureReason === null
        ? null
        : truncateManagedText(envelope.failureReason, MAX_MANAGED_TASK_FAILURE_BYTES),
      attempt: envelope.attempt,
      priorTaskId: envelope.priorTaskId,
      executionKind: envelope.executionKind,
      recoverablePreview: truncateManagedText(envelope.recoverablePreview, MAX_MANAGED_TASK_PREVIEW_BYTES),
      canonicalRefs: envelope.canonicalRefs
        .filter(isCanonicalReference)
        .slice(0, 512)
        .map((reference) => ({
          type: truncateManagedText(reference.type, 1_024),
          id: truncateManagedText(reference.id, 1_024),
        })),
      resumable: envelope.resumable,
      createdAt: envelope.createdAt,
      acknowledgedAt: envelope.acknowledgedAt,
      action: envelope.action,
      followUpTaskId: envelope.followUpTaskId,
      providerResetAt: isTimestamp(raw.providerResetAt) ? raw.providerResetAt : null,
      autoResume: parseManagedTaskAutoResume(raw.autoResume),
    };
  } catch {
    return null;
  }
};

const envelopeMatchesTask = (
  task: ManagedTaskProjectedRecord,
  envelope: ManagedTaskProjectedEnvelope,
) => (
  envelope.taskId === task.taskId
  && envelope.rootSessionId === task.rootSessionId
  && envelope.parentTaskId === task.parentTaskId
  && envelope.childSessionId === task.childSessionId
  && envelope.directory === task.directory
  && envelope.status === task.status
  && envelope.partial === task.partial
  && envelope.failureReason === task.failureReason
  && envelope.attempt === task.attempt
  && envelope.priorTaskId === task.priorTaskId
  && envelope.executionKind === task.executionKind
  && envelope.recoverablePreview === task.recoverablePreview
  && JSON.stringify(envelope.canonicalRefs) === JSON.stringify(task.canonicalRefs)
);

const parseSnapshot = (value: unknown): ParsedManagedOrchestrationSnapshot => {
  if (
    !isRecord(value)
    || typeof value.available !== 'boolean'
    || typeof value.bridgeReady !== 'boolean'
    || !isNullableString(value.recoveryWarning)
    || !Array.isArray(value.tasks)
    || !Array.isArray(value.resultEnvelopes)
  ) {
    throw new TypeError('Managed orchestration returned an invalid snapshot');
  }

  const tasks: ManagedTaskProjectedRecord[] = [];
  const tasksById = new Map<string, ManagedTaskProjectedRecord>();
  for (const candidate of value.tasks) {
    const task = parseManagedTaskEventRecord(candidate);
    if (!task || tasksById.has(task.taskId)) {
      throw new TypeError('Managed orchestration returned an invalid snapshot');
    }
    tasks.push(task);
    tasksById.set(task.taskId, task);
  }

  const resultEnvelopes: ManagedTaskProjectedEnvelope[] = [];
  const envelopeTaskIds = new Set<string>();
  for (const candidate of value.resultEnvelopes) {
    const envelope = parseEnvelope(candidate);
    const task = envelope ? tasksById.get(envelope.taskId) : null;
    if (
      !envelope
      || !task
      || envelopeTaskIds.has(envelope.taskId)
      || !envelopeMatchesTask(task, envelope)
    ) {
      throw new TypeError('Managed orchestration returned an invalid snapshot');
    }
    resultEnvelopes.push(envelope);
    envelopeTaskIds.add(envelope.taskId);
  }
  if (tasks.some((task) => isTerminalManagedTaskStatus(task.status) && !envelopeTaskIds.has(task.taskId))) {
    throw new TypeError('Managed orchestration returned an invalid snapshot');
  }

  return {
    available: value.available,
    bridgeReady: value.bridgeReady,
    recoveryWarning: value.recoveryWarning === null
      ? null
      : truncateManagedText(value.recoveryWarning, MAX_MANAGED_TASK_FAILURE_BYTES),
    tasks,
    resultEnvelopes,
  };
};

const sameRecord = (left: Record<string, unknown>, right: Record<string, unknown>) => {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (key === 'canonicalRefs' || key === 'autoResume' || key === 'waitingReason') {
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) return false;
    } else if (!Object.is(leftValue, rightValue)) {
      return false;
    }
  }
  return true;
};

const sameTask = (left: ManagedTaskProjectedRecord, right: ManagedTaskProjectedRecord) => (
  sameRecord(left as unknown as Record<string, unknown>, right as unknown as Record<string, unknown>)
);

const sameEnvelope = (left: ManagedTaskProjectedEnvelope, right: ManagedTaskProjectedEnvelope) => (
  sameRecord(left as unknown as Record<string, unknown>, right as unknown as Record<string, unknown>)
);

const metadataRegressed = (current: ManagedTaskProjectedRecord, incoming: ManagedTaskProjectedRecord) => (
  (current.childSessionId !== null && incoming.childSessionId !== current.childSessionId)
  || (current.startedAt !== null && incoming.startedAt !== current.startedAt)
  || (current.finishedAt !== null && incoming.finishedAt !== current.finishedAt)
);

const immutableTaskMetadataChanged = (
  current: ManagedTaskProjectedRecord,
  incoming: ManagedTaskProjectedRecord,
) => IMMUTABLE_PROJECTED_TASK_FIELDS.some((field) => !Object.is(current[field], incoming[field]));

const statusStage = (status: ManagedTaskStatus) => {
  if (status === 'queued') return 0;
  if (status === 'starting') return 1;
  if (status === 'running') return 2;
  return 3;
};

const mergeTask = (
  current: ManagedTaskProjectedRecord | undefined,
  incoming: ManagedTaskProjectedRecord,
): ManagedTaskProjectedRecord => {
  if (!current) return incoming;
  if (immutableTaskMetadataChanged(current, incoming)) return current;
  if (sameTask(current, incoming)) return current;
  if (isTerminalManagedTaskStatus(current.status)) return current;
  if (metadataRegressed(current, incoming)) return current;
  if (!canTransitionManagedTaskStatus(current.status, incoming.status)) {
    const skippedForward = statusStage(incoming.status) > statusStage(current.status);
    if (!skippedForward) return current;
  }
  return incoming;
};

const mergeEnvelope = (
  current: ManagedTaskProjectedEnvelope | undefined,
  incoming: ManagedTaskProjectedEnvelope,
): ManagedTaskProjectedEnvelope => {
  if (!current) return incoming;
  if (current.envelopeId !== incoming.envelopeId || current.sequence !== incoming.sequence) return current;
  if (sameEnvelope(current, incoming)) return current;
  if (current.action !== null) return current;
  if (incoming.action === null) {
    // Auto-resume progress arrives on an unacknowledged envelope. The host bumps
    // `revision` on every change, so only a newer revision (or a provider reset
    // update at the same revision) may replace what we hold; stale replays lose.
    const currentRevision = current.autoResume?.revision ?? 0;
    const incomingRevision = incoming.autoResume?.revision ?? 0;
    if (incomingRevision > currentRevision) return incoming;
    if (
      incomingRevision === currentRevision
      && !Object.is(incoming.providerResetAt, current.providerResetAt)
    ) return incoming;
    return current;
  }
  if (incoming.acknowledgedAt === null) return current;
  return incoming;
};

const sameIds = (left: readonly string[] | undefined, right: readonly string[]) => (
  Boolean(left && left.length === right.length && left.every((value, index) => value === right[index]))
);

const withRootIds = (
  current: Readonly<Record<string, readonly string[]>>,
  tasksById: Readonly<Record<string, ManagedTaskProjectedRecord>>,
  roots: Set<string>,
) => {
  const grouped = new Map<string, ManagedTaskProjectedRecord[]>();
  roots.forEach((rootSessionId) => grouped.set(rootSessionId, []));
  for (const task of Object.values(tasksById)) {
    grouped.get(task.rootSessionId)?.push(task);
  }
  let next: Record<string, readonly string[]> | null = null;
  for (const [rootSessionId, tasks] of grouped) {
    const ids = tasks
      .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId))
      .map((task) => task.taskId);
    const previous = current[rootSessionId];
    if (sameIds(previous, ids)) continue;
    next ??= { ...current };
    if (ids.length > 0) {
      next[rootSessionId] = ids;
    } else {
      delete next[rootSessionId];
    }
  }
  return next ?? current;
};

const isManualRecoveryTask = (
  task: ManagedTaskProjectedRecord,
  envelope: ManagedTaskProjectedEnvelope | undefined,
) => Boolean(
  task.childSessionId
  && !task.agentRetryAvailable
  && task.failureKind !== 'provider_prompt_rejected'
  && (
    task.failureKind === 'provider_usage_limit'
    || task.failureKind === 'model_unavailable'
    || (task.mode === 'orchestrator' && task.dispatchGrouped && task.attempt >= 2)
  )
  && (task.status === 'failed' || task.status === 'interrupted')
  && envelope?.resumable
  && envelope.action === null
);

const resolveLatestTaskIdForChildSession = (
  tasksById: Readonly<Record<string, ManagedTaskProjectedRecord>>,
  childSessionId: string,
) => {
  let latest: ManagedTaskProjectedRecord | null = null;
  for (const task of Object.values(tasksById)) {
    if (task.childSessionId !== childSessionId) continue;
    if (
      !latest
      || task.sequence > latest.sequence
      || (task.sequence === latest.sequence && task.taskId.localeCompare(latest.taskId) > 0)
    ) latest = task;
  }
  return latest?.taskId;
};

const withLatestTaskIdsByChildSession = (
  current: Readonly<Record<string, string>>,
  tasksById: Readonly<Record<string, ManagedTaskProjectedRecord>>,
  childSessionIds: Set<string>,
) => {
  let next: Record<string, string> | null = null;
  for (const childSessionId of childSessionIds) {
    const taskId = resolveLatestTaskIdForChildSession(tasksById, childSessionId);
    if (current[childSessionId] === taskId) continue;
    next ??= { ...current };
    if (taskId) next[childSessionId] = taskId;
    else delete next[childSessionId];
  }
  return next ?? current;
};

const resolveManualRecoveryTaskId = (
  tasksById: Readonly<Record<string, ManagedTaskProjectedRecord>>,
  resultEnvelopesByTaskId: Readonly<Record<string, ManagedTaskProjectedEnvelope>>,
  childSessionId: string,
) => {
  let latest: ManagedTaskProjectedRecord | null = null;
  for (const task of Object.values(tasksById)) {
    if (
      task.childSessionId !== childSessionId
      || !isManualRecoveryTask(task, resultEnvelopesByTaskId[task.taskId])
    ) continue;
    if (
      !latest
      || task.sequence > latest.sequence
      || (task.sequence === latest.sequence && task.taskId.localeCompare(latest.taskId) > 0)
    ) latest = task;
  }
  return latest?.taskId;
};

const withManualRecoveryTaskIds = (
  current: Readonly<Record<string, string>>,
  tasksById: Readonly<Record<string, ManagedTaskProjectedRecord>>,
  resultEnvelopesByTaskId: Readonly<Record<string, ManagedTaskProjectedEnvelope>>,
  childSessionIds: Set<string>,
) => {
  let next: Record<string, string> | null = null;
  for (const childSessionId of childSessionIds) {
    const taskId = resolveManualRecoveryTaskId(
      tasksById,
      resultEnvelopesByTaskId,
      childSessionId,
    );
    if (current[childSessionId] === taskId) continue;
    next ??= { ...current };
    if (taskId) next[childSessionId] = taskId;
    else delete next[childSessionId];
  }
  return next ?? current;
};

const errorMessage = (error: unknown) => error instanceof Error
  ? error.message
  : 'Managed orchestration action failed';

const defaultIdempotencyKey = () => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `devryan-ui-${random}`;
};

export const createManagedOrchestrationStore = (options: {
  api?: ManagedOrchestrationApi;
  createIdempotencyKey?: () => string;
} = {}) => {
  const api = options.api ?? managedOrchestrationApi;
  const createIdempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
  const snapshotLoads = new Map<string, {
    promise: Promise<void>;
    token: symbol;
    removedTasks: Map<string, { rootSessionId: string; directory: string; sequence: number }>;
  }>();
  const actionPromises = new Map<string, {
    promise: Promise<void>;
    token: symbol;
    removed: boolean;
  }>();
  const actionKeys = new Map<string, Map<ManagedTaskResultAction, string>>();
  const markTaskRemoved = (taskId: string) => {
    actionKeys.delete(taskId);
    const action = actionPromises.get(taskId);
    if (action) action.removed = true;
  };
  let generation = 0;

  const store = create<ManagedOrchestrationStore>()((set, get) => {
    const upsertMany = (projections: readonly ParsedManagedTaskProjection[]) => {
      set((state) => {
        let mutableTasksById: Record<string, ManagedTaskProjectedRecord> | null = null;
        let mutableEnvelopesByTaskId: Record<string, ManagedTaskProjectedEnvelope> | null = null;
        const affectedRoots = new Set<string>();
        const affectedChildSessionIds = new Set<string>();

        for (const { task, envelope } of projections) {
          const currentTask = (mutableTasksById ?? state.tasksById)[task.taskId];
          if (currentTask?.childSessionId) affectedChildSessionIds.add(currentTask.childSessionId);
          if (task.childSessionId) affectedChildSessionIds.add(task.childSessionId);
          const nextTask = mergeTask(currentTask, task);
          if (nextTask !== currentTask) {
            mutableTasksById ??= { ...state.tasksById };
            mutableTasksById[task.taskId] = nextTask;
            if (!currentTask) affectedRoots.add(nextTask.rootSessionId);
          }

          if (envelope && envelopeMatchesTask(task, envelope)) {
            const currentEnvelope = (mutableEnvelopesByTaskId ?? state.resultEnvelopesByTaskId)[task.taskId];
            const nextEnvelope = mergeEnvelope(currentEnvelope, envelope);
            if (nextEnvelope !== currentEnvelope) {
              mutableEnvelopesByTaskId ??= { ...state.resultEnvelopesByTaskId };
              mutableEnvelopesByTaskId[task.taskId] = nextEnvelope;
            }
          }
        }

        if (!mutableTasksById && !mutableEnvelopesByTaskId) {
          return state;
        }
        const tasksById = mutableTasksById ?? state.tasksById;
        const resultEnvelopesByTaskId = mutableEnvelopesByTaskId ?? state.resultEnvelopesByTaskId;
        return {
          ...state,
          tasksById,
          taskIdsByRootId: affectedRoots.size > 0
            ? withRootIds(state.taskIdsByRootId, tasksById, affectedRoots)
            : state.taskIdsByRootId,
          resultEnvelopesByTaskId,
          latestTaskIdByChildSessionId: affectedChildSessionIds.size > 0
            ? withLatestTaskIdsByChildSession(
              state.latestTaskIdByChildSessionId,
              tasksById,
              affectedChildSessionIds,
            )
            : state.latestTaskIdByChildSessionId,
          manualRecoveryTaskIdByChildSessionId: affectedChildSessionIds.size > 0
            ? withManualRecoveryTaskIds(
              state.manualRecoveryTaskIdByChildSessionId,
              tasksById,
              resultEnvelopesByTaskId,
              affectedChildSessionIds,
            )
            : state.manualRecoveryTaskIdByChildSessionId,
        };
      });
    };

    const upsert = (task: ManagedTaskProjectedRecord, envelope?: ManagedTaskProjectedEnvelope | null) => {
      upsertMany([{ task, envelope: envelope ?? null }]);
    };

    const parseProjection = (projection: unknown): ParsedManagedTaskProjection => {
      const record = isRecord(projection) ? projection : null;
      const task = parseManagedTaskEventRecord(record?.task);
      if (!task) {
        throw new TypeError('Managed orchestration response did not include a valid task');
      }
      const envelope = record?.resultEnvelope === undefined
        ? null
        : parseEnvelope(record.resultEnvelope);
      if (record?.resultEnvelope !== undefined && (!envelope || !envelopeMatchesTask(task, envelope))) {
        throw new TypeError('Managed orchestration response included an invalid result envelope');
      }
      return { task, envelope };
    };

    const setActionState = (
      taskId: string,
      pending: ManagedTaskPendingAction | null,
      error?: string | null,
    ) => set((state) => {
      const pendingActionByTaskId = { ...state.pendingActionByTaskId };
      const actionErrorByTaskId = { ...state.actionErrorByTaskId };
      if (pending) pendingActionByTaskId[taskId] = pending;
      else delete pendingActionByTaskId[taskId];
      if (typeof error === 'string' && error) actionErrorByTaskId[taskId] = error;
      else if (error === null) delete actionErrorByTaskId[taskId];
      return { ...state, pendingActionByTaskId, actionErrorByTaskId };
    });

    const removeCompactedTask = (properties: Record<string, unknown>) => {
      const taskId = typeof properties.taskId === 'string' ? properties.taskId : '';
      const rootSessionId = typeof properties.rootSessionId === 'string' ? properties.rootSessionId : '';
      const directory = typeof properties.directory === 'string' ? properties.directory : '';
      const sequence = properties.sequence;
      if (
        properties.owner !== 'devryan'
        || !taskId.startsWith('dvr_task_')
        || !rootSessionId
        || !directory
        || !Number.isSafeInteger(sequence)
        || Number(sequence) < 1
      ) return;

      for (const load of snapshotLoads.values()) {
        load.removedTasks.set(taskId, {
          rootSessionId,
          directory,
          sequence: Number(sequence),
        });
      }

      let removed = false;
      set((state) => {
        const task = state.tasksById[taskId];
        if (
          !task
          || task.rootSessionId !== rootSessionId
          || task.directory !== directory
          || task.sequence !== sequence
        ) return state;

        const tasksById = { ...state.tasksById };
        const resultEnvelopesByTaskId = { ...state.resultEnvelopesByTaskId };
        const pendingActionByTaskId = { ...state.pendingActionByTaskId };
        const actionErrorByTaskId = { ...state.actionErrorByTaskId };
        delete tasksById[taskId];
        delete resultEnvelopesByTaskId[taskId];
        delete pendingActionByTaskId[taskId];
        delete actionErrorByTaskId[taskId];
        removed = true;
        const affectedChildSessionIds = task.childSessionId
          ? new Set([task.childSessionId])
          : new Set<string>();
        return {
          ...state,
          tasksById,
          taskIdsByRootId: withRootIds(state.taskIdsByRootId, tasksById, new Set([rootSessionId])),
          resultEnvelopesByTaskId,
          latestTaskIdByChildSessionId: affectedChildSessionIds.size > 0
            ? withLatestTaskIdsByChildSession(
              state.latestTaskIdByChildSessionId,
              tasksById,
              affectedChildSessionIds,
            )
            : state.latestTaskIdByChildSessionId,
          manualRecoveryTaskIdByChildSessionId: affectedChildSessionIds.size > 0
            ? withManualRecoveryTaskIds(
              state.manualRecoveryTaskIdByChildSessionId,
              tasksById,
              resultEnvelopesByTaskId,
              affectedChildSessionIds,
            )
            : state.manualRecoveryTaskIdByChildSessionId,
          pendingActionByTaskId,
          actionErrorByTaskId,
        };
      });
      if (removed) markTaskRemoved(taskId);
    };

    return {
      ...initialState(),
      ingestEvent(event) {
        if (!isRecord(event) || typeof event.type !== 'string') return;
        if (event.type === 'openchamber:managed-orchestration-warning') {
          const properties = isRecord(event.properties) ? event.properties : null;
          const message = typeof properties?.message === 'string' ? properties.message.trim() : '';
          const boundedMessage = truncateManagedText(message, MAX_MANAGED_TASK_FAILURE_BYTES);
          if (boundedMessage) set((state) => state.recoveryWarning === boundedMessage
            ? state
            : { ...state, recoveryWarning: boundedMessage });
          return;
        }
        if (event.type === 'openchamber:managed-task-removed') {
          const properties = isRecord(event.properties) ? event.properties : null;
          if (properties) removeCompactedTask(properties);
          return;
        }
        if (event.type !== 'openchamber:managed-task') return;
        const properties = isRecord(event.properties) ? event.properties : null;
        if (properties?.owner !== 'devryan') return;
        const task = parseManagedTaskEventRecord(properties.task);
        if (!task || properties.directory !== task.directory) return;
        const envelope = properties.resultEnvelope === undefined
          ? null
          : parseEnvelope(properties.resultEnvelope);
        if (properties.resultEnvelope !== undefined && (!envelope || !envelopeMatchesTask(task, envelope))) return;
        upsert(task, envelope);
      },
      loadSnapshot({ rootSessionId }: { rootSessionId?: string } = {}) {
        const scopeKey = rootSessionId?.trim() || '*';
        const existing = snapshotLoads.get(scopeKey);
        if (existing) return existing.promise;
        const loadToken = Symbol(scopeKey);
        const removedDuringLoad = new Map<string, {
          rootSessionId: string;
          directory: string;
          sequence: number;
        }>();
        const loadGeneration = generation;
        const baseline = new Map(Object.entries(get().tasksById));
        set((state) => ({ ...state, isLoadingSnapshot: true, snapshotError: null }));
        const operation = Promise.resolve().then(async () => {
          try {
            const snapshot = parseSnapshot(await api.getSnapshot(
              rootSessionId?.trim() ? { rootSessionId: rootSessionId.trim() } : {},
            ));
            if (generation !== loadGeneration) return;
            const wasRemovedDuringLoad = (task: ManagedTaskProjectedRecord) => {
              const removed = removedDuringLoad.get(task.taskId);
              return Boolean(
                removed
                && removed.rootSessionId === task.rootSessionId
                && removed.directory === task.directory
                && removed.sequence === task.sequence
              );
            };
            const incomingIds = new Set(snapshot.tasks
              .filter((task) => !wasRemovedDuringLoad(task))
              .map((task) => task.taskId));
            const validEnvelopes = new Map<string, ManagedTaskProjectedEnvelope>();
            for (const envelope of snapshot.resultEnvelopes) {
              validEnvelopes.set(envelope.taskId, envelope);
            }
            const removedTaskIds = new Set<string>();
            set((state) => {
              let mutableTasksById: Record<string, ManagedTaskProjectedRecord> | null = null;
              let mutableEnvelopesByTaskId: Record<string, ManagedTaskProjectedEnvelope> | null = null;
              const affectedRoots = new Set<string>();
              const affectedChildSessionIds = new Set<string>();

              for (const task of snapshot.tasks) {
                if (wasRemovedDuringLoad(task)) continue;
                const currentTask = (mutableTasksById ?? state.tasksById)[task.taskId];
                if (currentTask?.childSessionId) affectedChildSessionIds.add(currentTask.childSessionId);
                if (task.childSessionId) affectedChildSessionIds.add(task.childSessionId);
                if (currentTask && immutableTaskMetadataChanged(currentTask, task)) {
                  throw new TypeError('Managed orchestration returned an invalid snapshot');
                }
                const nextTask = mergeTask(currentTask, task);
                if (nextTask !== currentTask) {
                  mutableTasksById ??= { ...state.tasksById };
                  mutableTasksById[task.taskId] = nextTask;
                  if (!currentTask) affectedRoots.add(nextTask.rootSessionId);
                }

                const envelope = validEnvelopes.get(task.taskId);
                if (envelope) {
                  const currentEnvelope = (mutableEnvelopesByTaskId ?? state.resultEnvelopesByTaskId)[task.taskId];
                  const nextEnvelope = mergeEnvelope(currentEnvelope, envelope);
                  if (nextEnvelope !== currentEnvelope) {
                    mutableEnvelopesByTaskId ??= { ...state.resultEnvelopesByTaskId };
                    mutableEnvelopesByTaskId[task.taskId] = nextEnvelope;
                  }
                }
              }

              for (const [taskId, baselineTask] of baseline) {
                if (incomingIds.has(taskId)) continue;
                if (rootSessionId && baselineTask.rootSessionId !== rootSessionId) continue;
                if ((mutableTasksById ?? state.tasksById)[taskId] !== baselineTask) continue;
                mutableTasksById ??= { ...state.tasksById };
                delete mutableTasksById[taskId];
                affectedRoots.add(baselineTask.rootSessionId);
                if (baselineTask.childSessionId) {
                  affectedChildSessionIds.add(baselineTask.childSessionId);
                }
                removedTaskIds.add(taskId);
                if ((mutableEnvelopesByTaskId ?? state.resultEnvelopesByTaskId)[taskId]) {
                  mutableEnvelopesByTaskId ??= { ...state.resultEnvelopesByTaskId };
                  delete mutableEnvelopesByTaskId[taskId];
                }
              }

              let mutablePendingActions: Record<string, ManagedTaskPendingAction> | null = null;
              let mutableActionErrors: Record<string, string> | null = null;
              for (const taskId of removedTaskIds) {
                if (Object.prototype.hasOwnProperty.call(state.pendingActionByTaskId, taskId)) {
                  mutablePendingActions ??= { ...state.pendingActionByTaskId };
                  delete mutablePendingActions[taskId];
                }
                if (Object.prototype.hasOwnProperty.call(state.actionErrorByTaskId, taskId)) {
                  mutableActionErrors ??= { ...state.actionErrorByTaskId };
                  delete mutableActionErrors[taskId];
                }
              }

              const tasksById = mutableTasksById ?? state.tasksById;
              const resultEnvelopesByTaskId = mutableEnvelopesByTaskId ?? state.resultEnvelopesByTaskId;
              return {
                ...state,
                tasksById,
                taskIdsByRootId: affectedRoots.size > 0
                  ? withRootIds(state.taskIdsByRootId, tasksById, affectedRoots)
                  : state.taskIdsByRootId,
                resultEnvelopesByTaskId,
                latestTaskIdByChildSessionId: affectedChildSessionIds.size > 0
                  ? withLatestTaskIdsByChildSession(
                    state.latestTaskIdByChildSessionId,
                    tasksById,
                    affectedChildSessionIds,
                  )
                  : state.latestTaskIdByChildSessionId,
                manualRecoveryTaskIdByChildSessionId: affectedChildSessionIds.size > 0
                  ? withManualRecoveryTaskIds(
                    state.manualRecoveryTaskIdByChildSessionId,
                    tasksById,
                    resultEnvelopesByTaskId,
                    affectedChildSessionIds,
                  )
                  : state.manualRecoveryTaskIdByChildSessionId,
                pendingActionByTaskId: mutablePendingActions ?? state.pendingActionByTaskId,
                actionErrorByTaskId: mutableActionErrors ?? state.actionErrorByTaskId,
                available: snapshot.available === true,
                bridgeReady: snapshot.bridgeReady === true,
                recoveryWarning: snapshot.recoveryWarning,
                snapshotError: null,
              };
            });
            removedTaskIds.forEach(markTaskRemoved);
          } catch (error) {
            if (generation === loadGeneration) {
              set((state) => ({ ...state, snapshotError: errorMessage(error) }));
            }
          } finally {
            if (snapshotLoads.get(scopeKey)?.token === loadToken) snapshotLoads.delete(scopeKey);
            if (generation === loadGeneration && snapshotLoads.size === 0) {
              set((state) => ({ ...state, isLoadingSnapshot: false }));
            }
          }
        });
        snapshotLoads.set(scopeKey, { promise: operation, token: loadToken, removedTasks: removedDuringLoad });
        return operation;
      },
      cancelTask(taskId, actionOptions = {}) {
        const existing = actionPromises.get(taskId);
        if (existing) return existing.promise;
        const task = get().tasksById[taskId];
        if (!task) {
          setActionState(taskId, null, 'Managed task was not found');
          return Promise.resolve();
        }
        const actionGeneration = generation;
        const actionToken = Symbol(taskId);
        setActionState(taskId, 'cancel', null);
        const operation = Promise.resolve().then(async () => {
          try {
            const response = await api.cancelTask(taskId, {
              rootSessionId: task.rootSessionId,
              directory: task.directory,
              cascade: actionOptions.cascade === true,
              ...(actionOptions.reason?.trim() ? { reason: actionOptions.reason.trim() } : {}),
            });
            const actionState = actionPromises.get(taskId);
            if (
              generation !== actionGeneration
              || actionState?.token !== actionToken
              || actionState.removed
            ) return;
            if (!isRecord(response)) {
              throw new TypeError('Managed orchestration response did not include a valid task');
            }
            const responseRecord = response as unknown as Record<string, unknown>;
            const responseProjections = Object.prototype.hasOwnProperty.call(responseRecord, 'tasks')
              ? responseRecord.tasks
              : [responseRecord];
            if (!Array.isArray(responseProjections) || responseProjections.length === 0) {
              throw new TypeError('Managed orchestration response did not include a valid task');
            }
            const parsedProjections = responseProjections.map(parseProjection);
            const responseTaskIds = new Set(parsedProjections.map((projection) => projection.task.taskId));
            if (
              responseTaskIds.size !== parsedProjections.length
              || !responseTaskIds.has(taskId)
              || parsedProjections.some((projection) => projection.task.rootSessionId !== task.rootSessionId)
            ) {
              throw new TypeError('Managed orchestration response included an invalid task scope');
            }
            upsertMany(parsedProjections);
            setActionState(taskId, null, null);
          } catch (error) {
            const actionState = actionPromises.get(taskId);
            if (
              generation === actionGeneration
              && actionState?.token === actionToken
              && !actionState.removed
            ) setActionState(taskId, null, errorMessage(error));
          } finally {
            if (actionPromises.get(taskId)?.token === actionToken) actionPromises.delete(taskId);
          }
        });
        actionPromises.set(taskId, { promise: operation, token: actionToken, removed: false });
        return operation;
      },
      acknowledgeTask(taskId, action, selection) {
        const existing = actionPromises.get(taskId);
        if (existing) return existing.promise;
        const task = get().tasksById[taskId];
        const envelope = get().resultEnvelopesByTaskId[taskId];
        if (!task || !envelope) {
          setActionState(taskId, null, 'Managed task result was not found');
          return Promise.resolve();
        }
        const actionGeneration = generation;
        const actionToken = Symbol(taskId);
        const taskActionKeys = actionKeys.get(taskId) ?? new Map<ManagedTaskResultAction, string>();
        const idempotencyKey = taskActionKeys.get(action) ?? createIdempotencyKey();
        taskActionKeys.set(action, idempotencyKey);
        actionKeys.set(taskId, taskActionKeys);
        setActionState(taskId, action, null);
        const operation = Promise.resolve().then(async () => {
          try {
            const response = await api.acknowledgeTask(taskId, {
              rootSessionId: task.rootSessionId,
              directory: task.directory,
              action,
              idempotencyKey,
              ...(selection ? {
                providerId: selection.providerId,
                modelId: selection.modelId,
                variant: selection.variant ?? null,
              } : {}),
            });
            const actionState = actionPromises.get(taskId);
            if (
              generation !== actionGeneration
              || actionState?.token !== actionToken
              || actionState.removed
            ) return;
            const nextEnvelope = parseEnvelope(response.resultEnvelope);
            if (
              !nextEnvelope
              || !envelopeMatchesTask(task, nextEnvelope)
              || nextEnvelope.envelopeId !== envelope.envelopeId
              || nextEnvelope.sequence !== envelope.sequence
              || nextEnvelope.action !== action
              || nextEnvelope.acknowledgedAt === null
            ) {
              throw new TypeError('Managed orchestration response did not match the requested result action');
            }
            const followUpProjection = response.followUpTask === null
              ? null
              : parseProjection(response.followUpTask);
            const followUpTaskId = followUpProjection?.task.taskId ?? null;
            if (followUpTaskId !== nextEnvelope.followUpTaskId) {
              throw new TypeError('Managed orchestration response included an invalid follow-up task');
            }
            if (followUpProjection && (
              followUpProjection.task.rootSessionId !== task.rootSessionId
              || followUpProjection.task.priorTaskId !== task.taskId
            )) {
              throw new TypeError('Managed orchestration response included an invalid follow-up task');
            }
            upsertMany([
              { task, envelope: nextEnvelope },
              ...(followUpProjection ? [followUpProjection] : []),
            ]);
            actionKeys.delete(taskId);
            setActionState(taskId, null, null);
          } catch (error) {
            const actionState = actionPromises.get(taskId);
            if (
              generation === actionGeneration
              && actionState?.token === actionToken
              && !actionState.removed
            ) setActionState(taskId, null, errorMessage(error));
          } finally {
            if (actionPromises.get(taskId)?.token === actionToken) actionPromises.delete(taskId);
          }
        });
        actionPromises.set(taskId, { promise: operation, token: actionToken, removed: false });
        return operation;
      },
      setAutoResume(taskId, enabled) {
        const existing = actionPromises.get(taskId);
        if (existing) return existing.promise;
        const task = get().tasksById[taskId];
        const envelope = get().resultEnvelopesByTaskId[taskId];
        if (!task || !envelope) {
          setActionState(taskId, null, 'Managed task result was not found');
          return Promise.resolve();
        }
        const actionGeneration = generation;
        const actionToken = Symbol(taskId);
        setActionState(taskId, 'auto_resume', null);
        const operation = Promise.resolve().then(async () => {
          try {
            const response = await api.setAutoResume(taskId, {
              rootSessionId: task.rootSessionId,
              directory: task.directory,
              enabled,
            });
            const actionState = actionPromises.get(taskId);
            if (
              generation !== actionGeneration
              || actionState?.token !== actionToken
              || actionState.removed
            ) return;
            const nextEnvelope = parseEnvelope(isRecord(response) ? response.resultEnvelope : undefined);
            if (
              !nextEnvelope
              || !envelopeMatchesTask(task, nextEnvelope)
              || nextEnvelope.envelopeId !== envelope.envelopeId
              || nextEnvelope.sequence !== envelope.sequence
              || !nextEnvelope.autoResume
            ) {
              throw new TypeError('Managed orchestration response did not match the auto-resume request');
            }
            upsertMany([{ task, envelope: nextEnvelope }]);
            setActionState(taskId, null, null);
          } catch (error) {
            const actionState = actionPromises.get(taskId);
            if (
              generation === actionGeneration
              && actionState?.token === actionToken
              && !actionState.removed
            ) setActionState(taskId, null, errorMessage(error));
          } finally {
            if (actionPromises.get(taskId)?.token === actionToken) actionPromises.delete(taskId);
          }
        });
        actionPromises.set(taskId, { promise: operation, token: actionToken, removed: false });
        return operation;
      },
      reset() {
        generation += 1;
        snapshotLoads.clear();
        actionPromises.clear();
        actionKeys.clear();
        set(initialState());
      },
    };
  });

  return store;
};

export const useManagedOrchestrationStore = createManagedOrchestrationStore();

/**
 * Wave labels the chat groups Agent Dispatch cards by. `openWaveIds` holds
 * every wave with a task that is non-terminal or whose result is still
 * unacknowledged: the scheduler labels the next start with that wave, so the
 * chat attaches provisional starts to it. Display only.
 */
export type ManagedDispatchWaveIndex = {
  waveIdByTaskId: ReadonlyMap<string, string>;
  openWaveIds: ReadonlySet<string>;
};

const EMPTY_DISPATCH_WAVE_INDEX: ManagedDispatchWaveIndex = Object.freeze({
  waveIdByTaskId: new Map<string, string>(),
  openWaveIds: new Set<string>(),
});

const buildDispatchWaveIndex = (state: ManagedOrchestrationStore): ManagedDispatchWaveIndex => {
  const waveIdByTaskId = new Map<string, string>();
  const openWaveIds = new Set<string>();
  for (const task of Object.values(state.tasksById)) {
    const waveId = task.dispatchWaveId ?? null;
    if (!waveId) continue;
    waveIdByTaskId.set(task.taskId, waveId);
    if (openWaveIds.has(waveId)) continue;
    if (!isTerminalManagedTaskStatus(task.status)) {
      openWaveIds.add(waveId);
      continue;
    }
    const envelope = state.resultEnvelopesByTaskId[task.taskId];
    if (!envelope || envelope.action === null) openWaveIds.add(waveId);
  }
  if (waveIdByTaskId.size === 0) return EMPTY_DISPATCH_WAVE_INDEX;
  return { waveIdByTaskId, openWaveIds };
};

const isSameDispatchWaveIndex = (current: ManagedDispatchWaveIndex, next: ManagedDispatchWaveIndex) => {
  if (current === next) return true;
  if (
    current.waveIdByTaskId.size !== next.waveIdByTaskId.size
    || current.openWaveIds.size !== next.openWaveIds.size
  ) return false;
  for (const [taskId, waveId] of next.waveIdByTaskId) {
    if (current.waveIdByTaskId.get(taskId) !== waveId) return false;
  }
  for (const waveId of next.openWaveIds) {
    if (!current.openWaveIds.has(waveId)) return false;
  }
  return true;
};

// Identity-stable across store updates that do not move a task between waves
// or open/close a wave, so subscribers re-render only when a card would change.
let dispatchWaveIndexCache: {
  tasksById: ManagedOrchestrationStore['tasksById'];
  resultEnvelopesByTaskId: ManagedOrchestrationStore['resultEnvelopesByTaskId'];
  index: ManagedDispatchWaveIndex;
} | null = null;

const selectDispatchWaveIndex = (state: ManagedOrchestrationStore): ManagedDispatchWaveIndex => {
  const cache = dispatchWaveIndexCache;
  if (
    cache
    && cache.tasksById === state.tasksById
    && cache.resultEnvelopesByTaskId === state.resultEnvelopesByTaskId
  ) {
    return cache.index;
  }
  const built = buildDispatchWaveIndex(state);
  const index = cache && isSameDispatchWaveIndex(cache.index, built) ? cache.index : built;
  dispatchWaveIndexCache = {
    tasksById: state.tasksById,
    resultEnvelopesByTaskId: state.resultEnvelopesByTaskId,
    index,
  };
  return index;
};

export const managedOrchestrationSelectors = {
  emptyTaskIds: EMPTY_TASK_IDS,
  dispatchWaveIndex: selectDispatchWaveIndex,
  taskIdsForRoot: (rootSessionId: string) => (state: ManagedOrchestrationStore) => (
    state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS
  ),
  taskIdForDispatchCall: (rootSessionId: string, dispatchCallId: string) => (
    state: ManagedOrchestrationStore
  ) => {
    if (!rootSessionId || !dispatchCallId) return undefined;
    const taskIds = state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS;
    return taskIds.find((taskId) => (
      state.tasksById[taskId]?.dispatchCallId === dispatchCallId
    ));
  },
  hasUndispositionedTasksForRoot: (rootSessionId: string) => (
    state: ManagedOrchestrationStore
  ) => {
    const taskIds = state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS;
    return taskIds.some((taskId) => {
      const task = state.tasksById[taskId];
      if (!task) return false;
      if (!isTerminalManagedTaskStatus(task.status)) return true;
      const envelope = state.resultEnvelopesByTaskId[taskId];
      return !envelope || envelope.action === null;
    });
  },
  /**
   * True while a managed child for this root is still executing. Distinct from
   * `hasUndispositionedTasksForRoot`, which also counts finished-but-uncollected
   * results: this is only "a subagent is working right now". Used to keep the
   * status row alive when the parent turn itself is idle, which is what happens
   * after a recovered or detached child resumes.
   */
  hasActiveTasksForRoot: (rootSessionId: string) => (
    state: ManagedOrchestrationStore
  ) => {
    const taskIds = state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS;
    return taskIds.some((taskId) => {
      const task = state.tasksById[taskId];
      return Boolean(task && !isTerminalManagedTaskStatus(task.status));
    });
  },
  delegationPhaseForRoot: (rootSessionId: string) => (
    state: ManagedOrchestrationStore
  ): ManagedRootDelegationPhase => {
    const taskIds = state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS;
    let hasStartingTask = false;
    let hasUndispositionedTerminalTask = false;
    for (const taskId of taskIds) {
      const task = state.tasksById[taskId];
      if (!task) continue;
      if (task.status === 'running') return 'waiting';
      if (task.status === 'queued' || task.status === 'starting') {
        hasStartingTask = true;
        continue;
      }
      const envelope = state.resultEnvelopesByTaskId[taskId];
      if (!envelope || envelope.action === null) {
        hasUndispositionedTerminalTask = true;
      }
    }
    if (hasStartingTask) return 'starting';
    return hasUndispositionedTerminalTask ? 'waiting' : null;
  },
  hasManualRecoveryForRoot: (rootSessionId: string) => (
    state: ManagedOrchestrationStore
  ) => {
    const taskIds = state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS;
    return taskIds.some((taskId) => {
      const task = state.tasksById[taskId];
      return Boolean(
        task
        && isManualRecoveryTask(task, state.resultEnvelopesByTaskId[taskId]),
      );
    });
  },
  task: (taskId: string) => (state: ManagedOrchestrationStore) => state.tasksById[taskId],
  resultEnvelope: (taskId: string) => (state: ManagedOrchestrationStore) => (
    state.resultEnvelopesByTaskId[taskId]
  ),
  autoResume: (taskId: string) => (state: ManagedOrchestrationStore) => (
    state.resultEnvelopesByTaskId[taskId]?.autoResume ?? null
  ),
  /** Why the scheduler is holding a queued task back; null once it starts. */
  waitingReasonForTask: (taskId: string) => (state: ManagedOrchestrationStore) => (
    state.tasksById[taskId]?.waitingReason ?? null
  ),
  latestTaskForChildSession: (childSessionId: string) => (
    state: ManagedOrchestrationStore
  ) => {
    const taskId = state.latestTaskIdByChildSessionId[childSessionId];
    return taskId ? state.tasksById[taskId] : undefined;
  },
  latestTaskAgentForChildSession: (childSessionId: string) => (
    state: ManagedOrchestrationStore
  ) => {
    const taskId = state.latestTaskIdByChildSessionId[childSessionId];
    return taskId ? state.tasksById[taskId]?.agent : undefined;
  },
  manualRecoveryTaskIdForChildSession: (childSessionId: string) => (
    state: ManagedOrchestrationStore
  ) => state.manualRecoveryTaskIdByChildSessionId[childSessionId],
  manualRecoveryFailureKindForChildSession: (childSessionId: string) => (
    state: ManagedOrchestrationStore
  ) => {
    const taskId = state.manualRecoveryTaskIdByChildSessionId[childSessionId];
    return taskId ? state.tasksById[taskId]?.failureKind ?? null : null;
  },
  pendingAction: (taskId: string) => (state: ManagedOrchestrationStore) => (
    state.pendingActionByTaskId[taskId]
  ),
  actionError: (taskId: string) => (state: ManagedOrchestrationStore) => (
    state.actionErrorByTaskId[taskId]
  ),
  queuePosition: (taskId: string) => (state: ManagedOrchestrationStore) => {
    const task = state.tasksById[taskId];
    if (!task || task.status !== 'queued') return null;
    const queued = Object.values(state.tasksById)
      .filter((candidate) => candidate.status === 'queued')
      .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId));
    const index = queued.findIndex((candidate) => candidate.taskId === taskId);
    return index < 0 ? null : index + 1;
  },
};
