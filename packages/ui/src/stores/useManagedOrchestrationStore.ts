import { create } from 'zustand';
import {
  canTransitionManagedTaskStatus,
  classifyProviderRetryFailure,
  isTerminalManagedTaskStatus,
  MAX_MANAGED_TASK_FAILURE_BYTES,
  MAX_MANAGED_TASK_LABEL_BYTES,
  MAX_MANAGED_TASK_PREVIEW_BYTES,
  truncateManagedText,
  validateManagedTaskResultEnvelope,
  type ManagedTaskEvent,
  type ManagedTaskEventRecord,
  type ManagedTaskRemovalEvent,
  type ManagedTaskResultAction,
  type ManagedTaskResultEnvelope,
  type ManagedTaskStatus,
} from '@openchamber/orchestration-runtime';

import {
  managedOrchestrationApi,
  type ManagedOrchestrationApi,
  type ManagedOrchestrationSnapshot,
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
] as const satisfies readonly (keyof ManagedTaskEventRecord)[];
const EMPTY_TASK_IDS: readonly string[] = Object.freeze([]);

type ManagedOrchestrationWarningEvent = {
  type: 'openchamber:managed-orchestration-warning';
  properties: { message: string };
};

type ParsedManagedTaskProjection = {
  task: ManagedTaskEventRecord;
  envelope: ManagedTaskResultEnvelope | null;
};

export type ManagedOrchestrationUiEvent = ManagedTaskEvent | ManagedTaskRemovalEvent | ManagedOrchestrationWarningEvent;

export type ManagedOrchestrationStore = {
  tasksById: Readonly<Record<string, ManagedTaskEventRecord>>;
  taskIdsByRootId: Readonly<Record<string, readonly string[]>>;
  resultEnvelopesByTaskId: Readonly<Record<string, ManagedTaskResultEnvelope>>;
  manualRecoveryTaskIdByChildSessionId: Readonly<Record<string, string>>;
  available: boolean | null;
  bridgeReady: boolean;
  recoveryWarning: string | null;
  isLoadingSnapshot: boolean;
  snapshotError: string | null;
  pendingActionByTaskId: Readonly<Record<string, 'cancel' | ManagedTaskResultAction>>;
  actionErrorByTaskId: Readonly<Record<string, string>>;
  ingestEvent(event: unknown): void;
  loadSnapshot(options?: { rootSessionId?: string }): Promise<void>;
  cancelTask(taskId: string, options?: { cascade?: boolean; reason?: string }): Promise<void>;
  acknowledgeTask(taskId: string, action: ManagedTaskResultAction, selection?: {
    providerId: string;
    modelId: string;
    variant: string | null;
  }): Promise<void>;
  reset(): void;
};

const initialState = () => ({
  tasksById: {} as Readonly<Record<string, ManagedTaskEventRecord>>,
  taskIdsByRootId: {} as Readonly<Record<string, readonly string[]>>,
  resultEnvelopesByTaskId: {} as Readonly<Record<string, ManagedTaskResultEnvelope>>,
  manualRecoveryTaskIdByChildSessionId: {} as Readonly<Record<string, string>>,
  available: null as boolean | null,
  bridgeReady: false,
  recoveryWarning: null as string | null,
  isLoadingSnapshot: false,
  snapshotError: null as string | null,
  pendingActionByTaskId: {} as Readonly<Record<string, 'cancel' | ManagedTaskResultAction>>,
  actionErrorByTaskId: {} as Readonly<Record<string, string>>,
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);
const isNullableTimestamp = (value: unknown): value is number | null => value === null || isTimestamp(value);

const isCanonicalReference = (value: unknown) => (
  isRecord(value)
  && typeof value.type === 'string'
  && Boolean(value.type.trim())
  && typeof value.id === 'string'
  && Boolean(value.id.trim())
);

const parseManagedTaskEventRecord = (value: unknown): ManagedTaskEventRecord | null => {
  if (!isRecord(value)) return null;
  const valid = value.owner === 'devryan'
    && typeof value.taskId === 'string'
    && value.taskId.startsWith('dvr_task_')
    && typeof value.rootSessionId === 'string'
    && Boolean(value.rootSessionId.trim())
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
    && (value.failureKind === undefined || value.failureKind === null || value.failureKind === 'provider_usage_limit')
    && typeof value.partial === 'boolean'
    && typeof value.recoverablePreview === 'string'
    && Array.isArray(value.canonicalRefs)
    && value.canonicalRefs.every(isCanonicalReference)
    && typeof value.agentRetryAvailable === 'boolean';
  if (!valid) return null;
  return {
    owner: 'devryan',
    taskId: value.taskId as string,
    rootSessionId: value.rootSessionId as string,
    parentTaskId: value.parentTaskId as string | null,
    childSessionId: value.childSessionId as string | null,
    directory: value.directory as string,
    sequence: value.sequence as number,
    mode: value.mode as ManagedTaskEventRecord['mode'],
    providerId: truncateManagedText(value.providerId, 1_024),
    modelId: truncateManagedText(value.modelId, 1_024),
    agent: truncateManagedText(value.agent, 1_024),
    variant: value.variant === null ? null : truncateManagedText(value.variant, 1_024),
    label: truncateManagedText(value.label, MAX_MANAGED_TASK_LABEL_BYTES),
    status: value.status as ManagedTaskStatus,
    attempt: value.attempt as number,
    priorTaskId: value.priorTaskId as string | null,
    executionKind: value.executionKind as ManagedTaskEventRecord['executionKind'],
    createdAt: value.createdAt as number,
    startedAt: value.startedAt as number | null,
    finishedAt: value.finishedAt as number | null,
    timeoutAt: value.timeoutAt as number | null,
    failureReason: value.failureReason === null
      ? null
      : truncateManagedText(value.failureReason, MAX_MANAGED_TASK_FAILURE_BYTES),
    failureKind: value.failureKind === 'provider_usage_limit'
      ? value.failureKind
      : classifyProviderRetryFailure(value.failureReason),
    partial: value.partial as boolean,
    recoverablePreview: truncateManagedText(value.recoverablePreview, MAX_MANAGED_TASK_PREVIEW_BYTES),
    canonicalRefs: (value.canonicalRefs as Array<{ type: string; id: string }>)
      .slice(0, 512)
      .map((reference) => ({
        type: truncateManagedText(reference.type, 1_024),
        id: truncateManagedText(reference.id, 1_024),
      })),
    agentRetryAvailable: value.agentRetryAvailable as boolean,
  };
};

export const isManagedTaskEventRecord = (value: unknown): value is ManagedTaskEventRecord => (
  parseManagedTaskEventRecord(value) !== null
);

const parseEnvelope = (value: unknown): ManagedTaskResultEnvelope | null => {
  try {
    const envelope = validateManagedTaskResultEnvelope(value);
    if (!envelope.canonicalRefs.every(isCanonicalReference)) return null;
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
    };
  } catch {
    return null;
  }
};

const envelopeMatchesTask = (
  task: ManagedTaskEventRecord,
  envelope: ManagedTaskResultEnvelope,
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

const parseSnapshot = (value: unknown): ManagedOrchestrationSnapshot => {
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

  const tasks: ManagedTaskEventRecord[] = [];
  const tasksById = new Map<string, ManagedTaskEventRecord>();
  for (const candidate of value.tasks) {
    const task = parseManagedTaskEventRecord(candidate);
    if (!task || tasksById.has(task.taskId)) {
      throw new TypeError('Managed orchestration returned an invalid snapshot');
    }
    tasks.push(task);
    tasksById.set(task.taskId, task);
  }

  const resultEnvelopes: ManagedTaskResultEnvelope[] = [];
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
    if (key === 'canonicalRefs') {
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) return false;
    } else if (!Object.is(leftValue, rightValue)) {
      return false;
    }
  }
  return true;
};

const sameTask = (left: ManagedTaskEventRecord, right: ManagedTaskEventRecord) => (
  sameRecord(left as unknown as Record<string, unknown>, right as unknown as Record<string, unknown>)
);

const sameEnvelope = (left: ManagedTaskResultEnvelope, right: ManagedTaskResultEnvelope) => (
  sameRecord(left as unknown as Record<string, unknown>, right as unknown as Record<string, unknown>)
);

const metadataRegressed = (current: ManagedTaskEventRecord, incoming: ManagedTaskEventRecord) => (
  (current.childSessionId !== null && incoming.childSessionId !== current.childSessionId)
  || (current.startedAt !== null && incoming.startedAt !== current.startedAt)
  || (current.finishedAt !== null && incoming.finishedAt !== current.finishedAt)
);

const immutableTaskMetadataChanged = (
  current: ManagedTaskEventRecord,
  incoming: ManagedTaskEventRecord,
) => IMMUTABLE_PROJECTED_TASK_FIELDS.some((field) => !Object.is(current[field], incoming[field]));

const statusStage = (status: ManagedTaskStatus) => {
  if (status === 'queued') return 0;
  if (status === 'starting') return 1;
  if (status === 'running') return 2;
  return 3;
};

const mergeTask = (
  current: ManagedTaskEventRecord | undefined,
  incoming: ManagedTaskEventRecord,
): ManagedTaskEventRecord => {
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
  current: ManagedTaskResultEnvelope | undefined,
  incoming: ManagedTaskResultEnvelope,
): ManagedTaskResultEnvelope => {
  if (!current) return incoming;
  if (current.envelopeId !== incoming.envelopeId || current.sequence !== incoming.sequence) return current;
  if (sameEnvelope(current, incoming)) return current;
  if (current.action !== null) return current;
  if (incoming.action === null || incoming.acknowledgedAt === null) return current;
  return incoming;
};

const sameIds = (left: readonly string[] | undefined, right: readonly string[]) => (
  Boolean(left && left.length === right.length && left.every((value, index) => value === right[index]))
);

const withRootIds = (
  current: Readonly<Record<string, readonly string[]>>,
  tasksById: Readonly<Record<string, ManagedTaskEventRecord>>,
  roots: Set<string>,
) => {
  const grouped = new Map<string, ManagedTaskEventRecord[]>();
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
  task: ManagedTaskEventRecord,
  envelope: ManagedTaskResultEnvelope | undefined,
) => Boolean(
  task.childSessionId
  && !task.agentRetryAvailable
  && (task.status === 'failed' || task.status === 'interrupted')
  && envelope?.resumable
  && envelope.action === null
);

const resolveManualRecoveryTaskId = (
  tasksById: Readonly<Record<string, ManagedTaskEventRecord>>,
  resultEnvelopesByTaskId: Readonly<Record<string, ManagedTaskResultEnvelope>>,
  childSessionId: string,
) => {
  let latest: ManagedTaskEventRecord | null = null;
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
  tasksById: Readonly<Record<string, ManagedTaskEventRecord>>,
  resultEnvelopesByTaskId: Readonly<Record<string, ManagedTaskResultEnvelope>>,
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
        let mutableTasksById: Record<string, ManagedTaskEventRecord> | null = null;
        let mutableEnvelopesByTaskId: Record<string, ManagedTaskResultEnvelope> | null = null;
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

    const upsert = (task: ManagedTaskEventRecord, envelope?: ManagedTaskResultEnvelope | null) => {
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
      pending: 'cancel' | ManagedTaskResultAction | null,
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
            const wasRemovedDuringLoad = (task: ManagedTaskEventRecord) => {
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
            const validEnvelopes = new Map<string, ManagedTaskResultEnvelope>();
            for (const envelope of snapshot.resultEnvelopes) {
              validEnvelopes.set(envelope.taskId, envelope);
            }
            const removedTaskIds = new Set<string>();
            set((state) => {
              let mutableTasksById: Record<string, ManagedTaskEventRecord> | null = null;
              let mutableEnvelopesByTaskId: Record<string, ManagedTaskResultEnvelope> | null = null;
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

              let mutablePendingActions: Record<string, 'cancel' | ManagedTaskResultAction> | null = null;
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

export const managedOrchestrationSelectors = {
  emptyTaskIds: EMPTY_TASK_IDS,
  taskIdsForRoot: (rootSessionId: string) => (state: ManagedOrchestrationStore) => (
    state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS
  ),
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
  task: (taskId: string) => (state: ManagedOrchestrationStore) => state.tasksById[taskId],
  resultEnvelope: (taskId: string) => (state: ManagedOrchestrationStore) => (
    state.resultEnvelopesByTaskId[taskId]
  ),
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
