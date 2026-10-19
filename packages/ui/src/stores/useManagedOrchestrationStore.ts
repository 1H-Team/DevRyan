import { create } from 'zustand';
import {
  canTransitionManagedTaskStatus,
  decodeManagedTaskAutoResume,
  decodeManagedTaskWaitingReason,
  decodeResultEnvelopePayload,
  decodeSnapshotPayload,
  decodeTaskEventRecord,
  findManagedResultPayloadMismatch,
  isTerminalManagedTaskStatus,
  MAX_MANAGED_TASK_FAILURE_BYTES,
  truncateManagedText,
  type ManagedTaskEvent,
  type ManagedTaskRemovalEvent,
  type ManagedTaskResultAction,
  type ManagedTaskStatus,
} from '@devryan/orchestration-runtime';

import { isRecord } from '@/lib/decoders/guards';
import {
  managedOrchestrationApi,
  type ManagedOrchestrationApi,
  type ManagedOrchestrationSnapshot,
  type ManagedTaskAutoResume,
  type ManagedTaskProjectedEnvelope,
  type ManagedTaskProjectedRecord,
  type ManagedTaskWaitingReason,
} from '@/lib/orchestrationApi';
import { canonicalEventType } from '@/lib/eventTypes';

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
  'recoveryLineageId',
] as const satisfies readonly (keyof ManagedTaskProjectedRecord)[];
const EMPTY_TASK_IDS: readonly string[] = Object.freeze([]);
export type ManagedTaskPendingAction = 'cancel' | 'auto_resume' | ManagedTaskResultAction;

export type ManagedRootDelegationPhase = 'starting' | 'waiting' | null;

type ManagedOrchestrationWarningEvent = {
  type: 'devryan:managed-orchestration-warning';
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
  snapshotStateByScope: Readonly<Record<string, 'loading' | 'confirmed' | 'unavailable'>>;
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
  snapshotStateByScope: {} as Readonly<Record<string, 'loading' | 'confirmed' | 'unavailable'>>,
  snapshotError: null as string | null,
  pendingActionByTaskId: {} as Readonly<Record<string, ManagedTaskPendingAction>>,
  actionErrorByTaskId: {} as Readonly<Record<string, string>>,
});

// Host payloads decode through the orchestration codec in lenient mode: a
// newer host's unknown auto-resume reason or malformed waiting reason degrades
// to null instead of hiding the task or its result.
const LENIENT = { mode: 'lenient' } as const;

/** Why a queued task has not started; a malformed value degrades to null. */
export const parseManagedTaskWaitingReason = (value: unknown): ManagedTaskWaitingReason | null => (
  decodeManagedTaskWaitingReason(value)
);

const parseManagedTaskEventRecord = (value: unknown): ManagedTaskProjectedRecord | null => (
  decodeTaskEventRecord(value, LENIENT)
);

export const isManagedTaskEventRecord = (value: unknown): value is ManagedTaskProjectedRecord => (
  parseManagedTaskEventRecord(value) !== null
);

/** The host's auto-resume block; anything incomplete degrades to null. */
export const parseManagedTaskAutoResume = (value: unknown): ManagedTaskAutoResume | null => (
  decodeManagedTaskAutoResume(value)
);

const parseEnvelope = (value: unknown): ManagedTaskProjectedEnvelope | null => (
  decodeResultEnvelopePayload(value, LENIENT)
);

const envelopeMatchesTask = (
  task: ManagedTaskProjectedRecord,
  envelope: ManagedTaskProjectedEnvelope,
) => findManagedResultPayloadMismatch({ ...task }, { ...envelope }) === null;

const parseSnapshot = (value: unknown): ParsedManagedOrchestrationSnapshot => decodeSnapshotPayload(value, LENIENT);

const sameRecord = (left: Record<string, unknown>, right: Record<string, unknown>) => {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (key === 'canonicalRefs' || key === 'autoResume' || key === 'waitingReason' || key === 'transportRecovery') {
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
) => IMMUTABLE_PROJECTED_TASK_FIELDS.some((field) => !Object.is(current[field], incoming[field]))
  // An existing finite deadline may renew; whether the attempt has a deadline
  // remains fixed by admission.
  || (current.timeoutAt === null) !== (incoming.timeoutAt === null);

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
  if (isTerminalManagedTaskStatus(current.status)) return current;
  if (metadataRegressed(current, incoming)) return current;
  if ((incoming.transportRecovery?.revision ?? 0) < (current.transportRecovery?.revision ?? 0)) return current;
  if (!canTransitionManagedTaskStatus(current.status, incoming.status)) {
    const skippedForward = statusStage(incoming.status) > statusStage(current.status);
    if (!skippedForward) return current;
  }
  // The scheduler writes each progress stamp once per task attempt. Older
  // snapshots can still advance status, but cannot clear established activity.
  const childPromptedAt = current.childPromptedAt ?? incoming.childPromptedAt;
  const firstAssistantPartAt = current.firstAssistantPartAt ?? incoming.firstAssistantPartAt;
  // Writable implementation tasks renew their deadlines as they make progress.
  // Older events/snapshots must not erase an observed renewal or block completion.
  const timeoutAt = current.timeoutAt !== null && incoming.timeoutAt !== null
    ? Math.max(current.timeoutAt, incoming.timeoutAt)
    : incoming.timeoutAt;
  const next = childPromptedAt !== incoming.childPromptedAt || firstAssistantPartAt !== incoming.firstAssistantPartAt
    || timeoutAt !== incoming.timeoutAt
    ? { ...incoming, childPromptedAt, firstAssistantPartAt, timeoutAt }
    : incoming;
  return sameTask(current, next) ? current : next;
};

const mergeEnvelope = (
  current: ManagedTaskProjectedEnvelope | undefined,
  incoming: ManagedTaskProjectedEnvelope,
): ManagedTaskProjectedEnvelope => {
  if (!current) return incoming;
  // Disposition advances the same envelope's durable collection sequence.
  if (current.envelopeId !== incoming.envelopeId || incoming.sequence < current.sequence) return current;
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
    || task.failureKind === 'provider_authentication'
    || task.failureKind === 'provider_configuration'
    || task.failureKind === 'model_unavailable'
    || Boolean(task.transportRecovery)
    || (task.mode === 'orchestrator' && task.dispatchGrouped && task.attempt >= 2)
  )
  && (task.status === 'failed' || task.status === 'interrupted')
  && envelope?.resumable
  && envelope.action === null
);

const childIndexMembershipChanged = (
  current: ManagedTaskProjectedRecord | undefined,
  next: ManagedTaskProjectedRecord,
  currentEnvelope: ManagedTaskProjectedEnvelope | undefined,
  nextEnvelope: ManagedTaskProjectedEnvelope | undefined,
) => (
  !current || current.childSessionId !== next.childSessionId
  || isManualRecoveryTask(current, currentEnvelope) !== isManualRecoveryTask(next, nextEnvelope)
);

const isLaterChildTask = (task: ManagedTaskProjectedRecord, previous: ManagedTaskProjectedRecord | undefined) => (
  !previous || task.sequence > previous.sequence
  || (task.sequence === previous.sequence && task.taskId.localeCompare(previous.taskId) > 0)
);

const reconcileChildIndex = (
  current: Readonly<Record<string, string>>,
  selected: ReadonlyMap<string, ManagedTaskProjectedRecord>,
  childSessionIds: Set<string>,
) => {
  let next: Record<string, string> | null = null;
  for (const childSessionId of childSessionIds) {
    const taskId = selected.get(childSessionId)?.taskId;
    if (current[childSessionId] === taskId) continue;
    next ??= { ...current };
    if (taskId) next[childSessionId] = taskId;
    else delete next[childSessionId];
  }
  return next ?? current;
};

type ChildTaskIndexes = Pick<ManagedOrchestrationStore, 'latestTaskIdByChildSessionId' | 'manualRecoveryTaskIdByChildSessionId'>;

const withChildTaskIndexes = (
  current: ChildTaskIndexes,
  tasksById: Readonly<Record<string, ManagedTaskProjectedRecord>>,
  resultEnvelopesByTaskId: Readonly<Record<string, ManagedTaskProjectedEnvelope>>,
  childSessionIds: Set<string>,
): ChildTaskIndexes => {
  if (childSessionIds.size === 0) return {
    latestTaskIdByChildSessionId: current.latestTaskIdByChildSessionId,
    manualRecoveryTaskIdByChildSessionId: current.manualRecoveryTaskIdByChildSessionId,
  };
  const latest = new Map<string, ManagedTaskProjectedRecord>();
  const recovery = new Map<string, ManagedTaskProjectedRecord>();
  // One traversal serves every affected child and both indexes, including
  // fallback to an earlier attempt after acknowledgement or compaction.
  for (const task of Object.values(tasksById)) {
    const childId = task.childSessionId;
    if (!childId || !childSessionIds.has(childId)) continue;
    if (isLaterChildTask(task, latest.get(childId))) latest.set(childId, task);
    if (isManualRecoveryTask(task, resultEnvelopesByTaskId[task.taskId])
      && isLaterChildTask(task, recovery.get(childId))) recovery.set(childId, task);
  }
  return {
    latestTaskIdByChildSessionId: reconcileChildIndex(current.latestTaskIdByChildSessionId, latest, childSessionIds),
    manualRecoveryTaskIdByChildSessionId: reconcileChildIndex(current.manualRecoveryTaskIdByChildSessionId, recovery, childSessionIds),
  };
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
          const nextTask = mergeTask(currentTask, task);
          if (nextTask !== currentTask) {
            mutableTasksById ??= { ...state.tasksById };
            mutableTasksById[task.taskId] = nextTask;
            if (!currentTask) affectedRoots.add(nextTask.rootSessionId);
          }

          const currentEnvelope = (mutableEnvelopesByTaskId ?? state.resultEnvelopesByTaskId)[task.taskId];
          const nextEnvelope = envelope && envelopeMatchesTask(task, envelope)
            ? mergeEnvelope(currentEnvelope, envelope) : currentEnvelope;
          if (nextEnvelope && nextEnvelope !== currentEnvelope) {
            mutableEnvelopesByTaskId ??= { ...state.resultEnvelopesByTaskId };
            mutableEnvelopesByTaskId[task.taskId] = nextEnvelope;
          }
          if (childIndexMembershipChanged(currentTask, nextTask, currentEnvelope, nextEnvelope)) {
            if (currentTask?.childSessionId) affectedChildSessionIds.add(currentTask.childSessionId);
            if (nextTask.childSessionId) affectedChildSessionIds.add(nextTask.childSessionId);
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
          ...withChildTaskIndexes(state, tasksById, resultEnvelopesByTaskId, affectedChildSessionIds),
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
          ...withChildTaskIndexes(state, tasksById, resultEnvelopesByTaskId, affectedChildSessionIds),
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
        // Contract-built and older-host events carry the `openchamber:*` alias.
        const type = canonicalEventType(event.type);
        if (type === 'devryan:managed-orchestration-warning') {
          const properties = isRecord(event.properties) ? event.properties : null;
          const message = typeof properties?.message === 'string' ? properties.message.trim() : '';
          const boundedMessage = truncateManagedText(message, MAX_MANAGED_TASK_FAILURE_BYTES);
          if (boundedMessage) set((state) => state.recoveryWarning === boundedMessage
            ? state
            : { ...state, recoveryWarning: boundedMessage });
          return;
        }
        if (type === 'devryan:managed-task-removed') {
          const properties = isRecord(event.properties) ? event.properties : null;
          if (properties) removeCompactedTask(properties);
          return;
        }
        if (type !== 'devryan:managed-task') return;
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
        set((state) => ({
          ...state, isLoadingSnapshot: true, snapshotError: null,
          snapshotStateByScope: state.snapshotStateByScope[scopeKey] === 'confirmed'
            ? state.snapshotStateByScope : { ...state.snapshotStateByScope, [scopeKey]: 'loading' },
        }));
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
                const currentEnvelope = (mutableEnvelopesByTaskId ?? state.resultEnvelopesByTaskId)[task.taskId];
                const nextEnvelope = envelope ? mergeEnvelope(currentEnvelope, envelope) : currentEnvelope;
                if (nextEnvelope && nextEnvelope !== currentEnvelope) {
                  mutableEnvelopesByTaskId ??= { ...state.resultEnvelopesByTaskId };
                  mutableEnvelopesByTaskId[task.taskId] = nextEnvelope;
                }
                if (childIndexMembershipChanged(currentTask, nextTask, currentEnvelope, nextEnvelope)) {
                  if (currentTask?.childSessionId) affectedChildSessionIds.add(currentTask.childSessionId);
                  if (nextTask.childSessionId) affectedChildSessionIds.add(nextTask.childSessionId);
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
                ...withChildTaskIndexes(state, tasksById, resultEnvelopesByTaskId, affectedChildSessionIds),
                pendingActionByTaskId: mutablePendingActions ?? state.pendingActionByTaskId,
                actionErrorByTaskId: mutableActionErrors ?? state.actionErrorByTaskId,
                snapshotStateByScope: state.snapshotStateByScope[scopeKey] === 'confirmed'
                  ? state.snapshotStateByScope
                  : { ...state.snapshotStateByScope, [scopeKey]: snapshot.available && snapshot.bridgeReady && !snapshot.recoveryWarning ? 'confirmed' : 'unavailable' },
                available: snapshot.available === true,
                bridgeReady: snapshot.bridgeReady === true,
                recoveryWarning: snapshot.recoveryWarning,
                snapshotError: null,
              };
            });
            removedTaskIds.forEach(markTaskRemoved);
          } catch (error) {
            if (generation === loadGeneration) {
              set((state) => ({
                ...state, snapshotError: errorMessage(error),
                snapshotStateByScope: state.snapshotStateByScope[scopeKey] === 'confirmed'
                  ? state.snapshotStateByScope : { ...state.snapshotStateByScope, [scopeKey]: 'unavailable' },
              }));
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
            const responseRecord = response;
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
            const acknowledgement = isRecord(response) ? response : {};
            const nextEnvelope = parseEnvelope(acknowledgement.resultEnvelope);
            if (
              !nextEnvelope
              || !envelopeMatchesTask(task, nextEnvelope)
              || nextEnvelope.envelopeId !== envelope.envelopeId
              || nextEnvelope.sequence < envelope.sequence
              || nextEnvelope.action !== action
              || nextEnvelope.acknowledgedAt === null
            ) {
              throw new TypeError('Managed orchestration response did not match the requested result action');
            }
            const followUpProjection = acknowledgement.followUpTask === null
              ? null
              : parseProjection(acknowledgement.followUpTask);
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
 * unacknowledged: the scheduler labels the next start with that wave. The
 * finer fields let the chat predict a provisional start's wave the way the
 * scheduler will at submit time: an active wave (`activeWaveIds`) cannot close
 * before then, while a wave only awaiting acknowledgement closes as soon as the
 * listed results are dispositioned, which the transcript can show before the
 * acknowledgement event lands. `waveIdByDispatchCallId` names the wave of a
 * start whose task the store already holds while its tool part has no output.
 * Display only.
 */
export type ManagedDispatchWaveIndex = {
  waveIdByTaskId: ReadonlyMap<string, string>;
  waveIdByDispatchCallId: ReadonlyMap<string, string>;
  openWaveIds: ReadonlySet<string>;
  activeWaveIds: ReadonlySet<string>;
  awaitingAcknowledgementTaskIdsByWaveId: ReadonlyMap<string, readonly string[]>;
};

const EMPTY_DISPATCH_WAVE_INDEX: ManagedDispatchWaveIndex = Object.freeze({
  waveIdByTaskId: new Map<string, string>(),
  waveIdByDispatchCallId: new Map<string, string>(),
  openWaveIds: new Set<string>(),
  activeWaveIds: new Set<string>(),
  awaitingAcknowledgementTaskIdsByWaveId: new Map<string, readonly string[]>(),
});

const buildDispatchWaveIndex = (state: ManagedOrchestrationStore): ManagedDispatchWaveIndex => {
  const waveIdByTaskId = new Map<string, string>();
  const waveIdByDispatchCallId = new Map<string, string>();
  const openWaveIds = new Set<string>();
  const activeWaveIds = new Set<string>();
  const awaitingAcknowledgementTaskIdsByWaveId = new Map<string, string[]>();
  for (const task of Object.values(state.tasksById)) {
    const waveId = task.dispatchWaveId ?? null;
    if (!waveId) continue;
    waveIdByTaskId.set(task.taskId, waveId);
    if (task.dispatchCallId) waveIdByDispatchCallId.set(task.dispatchCallId, waveId);
    if (!isTerminalManagedTaskStatus(task.status)) {
      openWaveIds.add(waveId);
      activeWaveIds.add(waveId);
      continue;
    }
    const envelope = state.resultEnvelopesByTaskId[task.taskId];
    if (envelope && envelope.action !== null) continue;
    openWaveIds.add(waveId);
    const awaiting = awaitingAcknowledgementTaskIdsByWaveId.get(waveId);
    if (awaiting) awaiting.push(task.taskId);
    else awaitingAcknowledgementTaskIdsByWaveId.set(waveId, [task.taskId]);
  }
  if (waveIdByTaskId.size === 0) return EMPTY_DISPATCH_WAVE_INDEX;
  for (const taskIds of awaitingAcknowledgementTaskIdsByWaveId.values()) taskIds.sort();
  return {
    waveIdByTaskId,
    waveIdByDispatchCallId,
    openWaveIds,
    activeWaveIds,
    awaitingAcknowledgementTaskIdsByWaveId,
  };
};

const isSameStringMap = (current: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>) => {
  if (current.size !== next.size) return false;
  for (const [key, value] of next) {
    if (current.get(key) !== value) return false;
  }
  return true;
};

const isSameStringSet = (current: ReadonlySet<string>, next: ReadonlySet<string>) => {
  if (current.size !== next.size) return false;
  for (const value of next) {
    if (!current.has(value)) return false;
  }
  return true;
};

const isSameDispatchWaveIndex = (current: ManagedDispatchWaveIndex, next: ManagedDispatchWaveIndex) => {
  if (current === next) return true;
  if (
    !isSameStringMap(current.waveIdByTaskId, next.waveIdByTaskId)
    || !isSameStringMap(current.waveIdByDispatchCallId, next.waveIdByDispatchCallId)
    || !isSameStringSet(current.openWaveIds, next.openWaveIds)
    || !isSameStringSet(current.activeWaveIds, next.activeWaveIds)
    || current.awaitingAcknowledgementTaskIdsByWaveId.size !== next.awaitingAcknowledgementTaskIdsByWaveId.size
  ) return false;
  for (const [waveId, taskIds] of next.awaitingAcknowledgementTaskIdsByWaveId) {
    const currentTaskIds = current.awaitingAcknowledgementTaskIdsByWaveId.get(waveId);
    if (!currentTaskIds || currentTaskIds.length !== taskIds.length) return false;
    if (taskIds.some((taskId, index) => currentTaskIds[index] !== taskId)) return false;
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
  hasConfirmedSnapshotForRoot: (rootSessionId: string) => (state: ManagedOrchestrationStore) => (
    state.snapshotStateByScope['*'] === 'confirmed' || state.snapshotStateByScope[rootSessionId] === 'confirmed'
  ),
  isLoadingSnapshotForRoot: (rootSessionId: string) => (state: ManagedOrchestrationStore) => (
    state.snapshotStateByScope['*'] === 'loading' || state.snapshotStateByScope[rootSessionId] === 'loading'
  ),
  delegationPhaseForRoot: (rootSessionId: string) => (
    state: ManagedOrchestrationStore
  ): ManagedRootDelegationPhase => {
    const taskIds = state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS;
    let hasStartingTask = false;
    for (const taskId of taskIds) {
      const task = state.tasksById[taskId];
      if (!task) continue;
      if (task.status === 'running') return 'waiting';
      if (task.status === 'queued' || task.status === 'starting') {
        hasStartingTask = true;
        continue;
      }
    }
    if (hasStartingTask) return 'starting';
    return null;
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
  /** Resolve a dispatch's current same-child attempt even after its old hops were pruned. */
  taskIdForRecovery: (taskId: string, fallback?: {
    rootSessionId: string;
    dispatchCallId: string | null;
    childSessionId: string | null;
    directory: string;
  }) => (state: ManagedOrchestrationStore): string | undefined => {
    const original = state.tasksById[taskId];
    const identity = original ?? fallback;
    if (!identity) return undefined;
    const childSessionId = identity.childSessionId;
    const latestId = childSessionId ? state.latestTaskIdByChildSessionId[childSessionId] : undefined;
    const latest = latestId ? state.tasksById[latestId] : undefined;
    if (
      latest && latest.rootSessionId === identity.rootSessionId
      && latest.directory === identity.directory
      && (latest.taskId === taskId || (
        (latest.executionKind === 'resume' || latest.executionKind === 'recover_in_place' || latest.executionKind === 'retry_in_place')
        && Boolean(identity.dispatchCallId)
        && latest.dispatchCallId === identity.dispatchCallId
        && (!original || latest.sequence > original.sequence)
      ))
    ) return latest.taskId;
    return original?.taskId;
  },
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
