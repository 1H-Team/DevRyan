import type { Part, ToolPart } from '@opencode-ai/sdk/v2';
import type { ManagedTaskStatus } from '@openchamber/orchestration-runtime';

import { isManagedTaskToolName } from './message/parts/toolRenderUtils';

type ManagedTaskPayload = {
  task?: { taskId?: unknown; dispatchCallId?: unknown };
  followUpTask?: { task?: { taskId?: unknown; dispatchCallId?: unknown } };
};

const MANAGED_DISPATCH_ACTIONS = new Set(['start', 'retry']);
const MANAGED_CONTROL_ACTIONS = new Set([
  'status',
  'wait',
  'cancel',
  'continue',
  'resume',
  'recover_in_place',
  'abandon',
]);

export type PendingManagedTaskDispatch = {
  partId: string;
  dispatchCallId: string | null;
  agent: string;
  label: string;
  status: 'preparing' | 'error';
  errorMessage?: string;
};

export type ManagedTaskDispatchFallback = {
  partId: string;
  taskId: string;
  dispatchCallId: string | null;
  agent: string;
  label: string;
  status: ManagedTaskStatus;
  childSessionId: string | null;
  directory: string;
};

export type ManagedTaskTurnProjection = {
  ownerMessageId: string;
  /**
   * Scheduler wave label shared by every task in this card, or null when the
   * card holds unlabeled work (old ledgers, builder dispatches, a store that
   * has not loaded yet) or only provisional starts.
   */
  waveId: string | null;
  taskIds: string[];
  pendingDispatches: PendingManagedTaskDispatch[];
  fallbackTasks: ManagedTaskDispatchFallback[];
};

export type ManagedTaskTurnMessage = {
  messageId: string;
  parts: readonly Part[];
};

export type ManagedTaskTurnProjectionOptions = {
  /**
   * Persisted `dispatchWaveId` of a task, read from the orchestration store.
   * Return null/undefined when the task is unknown or unlabeled.
   */
  getTaskWaveId?: (taskId: string) => string | null | undefined;
  /**
   * True while any task of the wave is non-terminal or its result is still
   * unacknowledged, which is exactly when the scheduler would label the next
   * start with the same wave.
   */
  isWaveOpen?: (waveId: string) => boolean;
};

/**
 * Group key for tasks the store cannot place in a wave. Every unlabeled task
 * of one turn shares this key, so ledgers written before waves existed keep
 * rendering one card per turn anchored at the first dispatching message.
 */
const UNLABELED_TURN_GROUP_KEY = 'turn';
const messageGroupKey = (messageId: string) => `message:${messageId}`;
const normalizeWaveId = (value: string | null | undefined): string | null => (
  typeof value === 'string' && value.startsWith('dvr_wave_') ? value : null
);

const appendTo = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
};

const MANAGED_TASK_STATUSES = new Set<ManagedTaskStatus>([
  'queued',
  'starting',
  'running',
  'completed',
  'failed',
  'aborted',
  'interrupted',
]);

const MANAGED_START_FAILURE_STATUSES = new Set([
  'error',
  'failed',
  'aborted',
  'cancelled',
  'canceled',
  'timeout',
  'timedout',
]);

const readErrorMessage = (value: unknown): string => {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as { message?: unknown }).message === 'string'
      ? (value as { message: string }).message
      : '';
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const permissionRulesIndex = normalized.search(/\s+Here are some of the relevant rules\b/i);
  const withoutRules = permissionRulesIndex >= 0
    ? normalized.slice(0, permissionRulesIndex)
    : normalized;
  return withoutRules.slice(0, 240);
};

const parsePayload = (output: unknown): ManagedTaskPayload | null => {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output as ManagedTaskPayload;
  }
  if (typeof output !== 'string' || !output.trim()) return null;
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ManagedTaskPayload
      : null;
  } catch {
    return null;
  }
};

const fallbackFromTask = (
  partId: string,
  value: unknown,
): ManagedTaskDispatchFallback | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
  const dispatchCallId = typeof task.dispatchCallId === 'string'
    ? task.dispatchCallId.trim()
    : task.dispatchCallId === null || task.dispatchCallId === undefined
      ? null
      : undefined;
  const agent = typeof task.agent === 'string' ? task.agent.trim() : '';
  const label = typeof task.label === 'string' ? task.label.trim() : '';
  const status = typeof task.status === 'string' ? task.status.trim() : '';
  const directory = typeof task.directory === 'string' ? task.directory.trim() : '';
  const childSessionId = typeof task.childSessionId === 'string'
    ? task.childSessionId.trim()
    : task.childSessionId === null
      ? null
      : undefined;
  if (
    !taskId.startsWith('dvr_task_')
    || dispatchCallId === undefined
    || !agent
    || !label
    || !MANAGED_TASK_STATUSES.has(status as ManagedTaskStatus)
    || !directory
    || childSessionId === undefined
  ) return null;
  return {
    partId,
    taskId,
    dispatchCallId: dispatchCallId || null,
    agent,
    label,
    status: status as ManagedTaskStatus,
    childSessionId: childSessionId || null,
    directory,
  };
};

export const resolveManagedTaskFallbacks = (
  parts: readonly Part[],
): ManagedTaskDispatchFallback[] => {
  const latestByTaskId = new Map<string, ManagedTaskDispatchFallback>();
  for (const part of parts) {
    if (part.type !== 'tool' || !isManagedTaskToolName((part as ToolPart).tool)) continue;
    const state = (part as ToolPart).state as Record<string, unknown> | undefined;
    const payload = parsePayload(state?.output);
    if (!payload) continue;
    const candidates = [
      payload.task,
      payload.followUpTask?.task,
    ];
    for (const candidate of candidates) {
      const fallback = fallbackFromTask(part.id, candidate);
      if (fallback) latestByTaskId.set(fallback.taskId, fallback);
    }
  }
  return Array.from(latestByTaskId.values());
};

const taskIdFromPart = (part: ToolPart): string | null => {
  if (!isManagedTaskToolName(part.tool)) return null;
  const state = part.state as Record<string, unknown> | undefined;
  const input = state?.input as Record<string, unknown> | undefined;
  const action = typeof input?.action === 'string' ? input.action.trim() : '';
  if (action !== 'start' && action !== 'retry') return null;
  const payload = parsePayload(state?.output);
  const candidate = action === 'start'
    ? payload?.task?.taskId
    : payload?.followUpTask?.task?.taskId;
  return typeof candidate === 'string' && candidate.startsWith('dvr_task_') ? candidate : null;
};

const pendingDispatchFromPart = (part: ToolPart): PendingManagedTaskDispatch | null => {
  if (!isManagedTaskToolName(part.tool)) return null;
  const state = part.state as Record<string, unknown> | undefined;
  const input = state?.input as Record<string, unknown> | undefined;
  const action = typeof input?.action === 'string' ? input.action.trim() : '';
  const status = typeof state?.status === 'string' ? state.status.trim() : '';
  if (action !== 'start') return null;

  const agent = typeof input?.agent === 'string' ? input.agent.trim() : '';
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  const dispatchCallId = typeof part.callID === 'string' ? part.callID.trim() : '';
  const normalizedAgent = agent || 'agent';
  if (status === 'pending' || status === 'running') {
    return {
      partId: part.id,
      dispatchCallId: dispatchCallId || null,
      agent: normalizedAgent,
      label: label || `Managed ${normalizedAgent} task`,
      status: 'preparing',
    };
  }
  if (!MANAGED_START_FAILURE_STATUSES.has(status.toLowerCase().replace(/[\s_-]+/g, ''))) {
    return null;
  }
  return {
    partId: part.id,
    dispatchCallId: dispatchCallId || null,
    agent: normalizedAgent,
    label: label || `Managed ${normalizedAgent} task`,
    status: 'error',
    errorMessage: readErrorMessage(state?.error),
  };
};

export const resolveManagedTaskDispatch = (parts: readonly Part[]) => {
  const projectedContentParts: Part[] = [];
  const taskIds: string[] = [];
  const pendingDispatches: PendingManagedTaskDispatch[] = [];
  const seen = new Set<string>();
  let hasManagedDispatchAction = false;
  let hasManagedControlAction = false;
  let hasUnknownManagedAction = false;
  let hasNonManagedTool = false;

  for (const part of parts) {
    if (part.type !== 'tool' || !isManagedTaskToolName((part as ToolPart).tool)) {
      projectedContentParts.push(part);
      if (part.type === 'tool') hasNonManagedTool = true;
      continue;
    }
    const state = (part as ToolPart).state as Record<string, unknown> | undefined;
    const input = state?.input as Record<string, unknown> | undefined;
    const action = typeof input?.action === 'string' ? input.action.trim() : '';
    if (MANAGED_DISPATCH_ACTIONS.has(action)) hasManagedDispatchAction = true;
    else if (MANAGED_CONTROL_ACTIONS.has(action)) hasManagedControlAction = true;
    else hasUnknownManagedAction = true;

    const taskId = taskIdFromPart(part as ToolPart);
    if (taskId) {
      if (!seen.has(taskId)) {
        seen.add(taskId);
        taskIds.push(taskId);
      }
      continue;
    }

    const pendingDispatch = pendingDispatchFromPart(part as ToolPart);
    if (!pendingDispatch) continue;
    pendingDispatches.push(pendingDispatch);
  }

  const suppressManagedControlReasoning = hasManagedControlAction
    && !hasManagedDispatchAction
    && !hasUnknownManagedAction
    && !hasNonManagedTool;
  const contentParts = suppressManagedControlReasoning
    ? projectedContentParts.filter((part) => part.type !== 'reasoning')
    : projectedContentParts;

  return { contentParts, taskIds, pendingDispatches };
};

/**
 * One Agent Dispatch card per parallel wave.
 *
 * Every managed start in the turn is first pinned to the assistant message
 * that issued it (a provisional start keeps its `callID`, so authoritative
 * output arriving in a later message still counts for the original message).
 * Starts are then grouped by the scheduler's `dispatchWaveId`: a card is owned
 * by the first message that dispatched into its wave and collects every later
 * start of that wave, however many assistant messages the fan-out spans.
 * Provisional starts join the latest wave while it is open (the scheduler will
 * label them with it), otherwise they stay at their own message. Tasks the
 * store cannot label share one per-turn card at the first dispatching message,
 * which is how ledgers written before waves existed keep rendering.
 *
 * Display only: nothing here decides whether or when a task launches.
 */
export const resolveManagedTaskTurnProjection = (
  messages: readonly ManagedTaskTurnMessage[],
  options: ManagedTaskTurnProjectionOptions = {},
): ManagedTaskTurnProjection[] => {
  const getTaskWaveId = options.getTaskWaveId ?? (() => null);
  const isWaveOpen = options.isWaveOpen ?? (() => false);

  // Pass 1: where each start was issued.
  const messageOrder: string[] = [];
  const seenMessageIds = new Set<string>();
  const dispatchMessageIdByTaskId = new Map<string, string>();
  const messageIdByDispatchCallId = new Map<string, string>();
  const pendingDispatchesByMessageId = new Map<string, PendingManagedTaskDispatch[]>();
  const seenPendingPartIds = new Set<string>();
  const allParts: Part[] = [];

  for (const message of messages) {
    if (!seenMessageIds.has(message.messageId)) {
      seenMessageIds.add(message.messageId);
      messageOrder.push(message.messageId);
    }
    allParts.push(...message.parts);
    const dispatch = resolveManagedTaskDispatch(message.parts);

    for (const taskId of dispatch.taskIds) {
      if (!dispatchMessageIdByTaskId.has(taskId)) {
        dispatchMessageIdByTaskId.set(taskId, message.messageId);
      }
    }

    for (const pendingDispatch of dispatch.pendingDispatches) {
      if (seenPendingPartIds.has(pendingDispatch.partId)) continue;
      seenPendingPartIds.add(pendingDispatch.partId);
      if (pendingDispatch.dispatchCallId && !messageIdByDispatchCallId.has(pendingDispatch.dispatchCallId)) {
        messageIdByDispatchCallId.set(pendingDispatch.dispatchCallId, message.messageId);
      }
      appendTo(pendingDispatchesByMessageId, message.messageId, pendingDispatch);
    }
  }

  // Pass 2: authoritative output re-homes a task to the message of its
  // provisional start (matched by dispatch call) and retires that provisional row.
  const fallbackTaskByTaskId = new Map<string, ManagedTaskDispatchFallback>();
  const authoritativeDispatchCallIds = new Set<string>();

  for (const fallbackTask of resolveManagedTaskFallbacks(allParts)) {
    const provisionalMessageId = fallbackTask.dispatchCallId
      ? messageIdByDispatchCallId.get(fallbackTask.dispatchCallId)
      : undefined;
    const dispatchMessageId = provisionalMessageId ?? dispatchMessageIdByTaskId.get(fallbackTask.taskId);
    if (!dispatchMessageId) continue;

    if (fallbackTask.dispatchCallId && provisionalMessageId) {
      authoritativeDispatchCallIds.add(fallbackTask.dispatchCallId);
    }
    dispatchMessageIdByTaskId.set(fallbackTask.taskId, dispatchMessageId);
    fallbackTaskByTaskId.set(fallbackTask.taskId, fallbackTask);
  }

  const taskIdsByDispatchMessageId = new Map<string, string[]>();
  for (const [taskId, messageId] of dispatchMessageIdByTaskId) {
    appendTo(taskIdsByDispatchMessageId, messageId, taskId);
  }

  // Pass 3: group by wave. A group's owner is the first message that dispatched into it.
  const projectionsByGroupKey = new Map<string, ManagedTaskTurnProjection>();
  const ensureProjection = (groupKey: string, messageId: string, waveId: string | null) => {
    const existing = projectionsByGroupKey.get(groupKey);
    if (existing) return existing;
    const projection: ManagedTaskTurnProjection = {
      ownerMessageId: messageId,
      waveId,
      taskIds: [],
      pendingDispatches: [],
      fallbackTasks: [],
    };
    projectionsByGroupKey.set(groupKey, projection);
    return projection;
  };

  let latestWaveId: string | null = null;
  for (const messageId of messageOrder) {
    for (const taskId of taskIdsByDispatchMessageId.get(messageId) ?? []) {
      const waveId = normalizeWaveId(getTaskWaveId(taskId));
      const projection = ensureProjection(waveId ?? UNLABELED_TURN_GROUP_KEY, messageId, waveId);
      projection.taskIds.push(taskId);
      const fallbackTask = fallbackTaskByTaskId.get(taskId);
      if (fallbackTask) projection.fallbackTasks.push(fallbackTask);
      if (waveId) latestWaveId = waveId;
    }

    for (const pendingDispatch of pendingDispatchesByMessageId.get(messageId) ?? []) {
      if (pendingDispatch.dispatchCallId && authoritativeDispatchCallIds.has(pendingDispatch.dispatchCallId)) {
        continue;
      }
      // No wave seen yet: the start belongs with the turn's unlabeled work. A
      // still-open wave will label this start too, so it joins that card; after
      // the wave closed the start will open a new wave at its own message.
      const groupKey = latestWaveId === null
        ? UNLABELED_TURN_GROUP_KEY
        : isWaveOpen(latestWaveId)
          ? latestWaveId
          : messageGroupKey(messageId);
      ensureProjection(groupKey, messageId, groupKey === latestWaveId ? latestWaveId : null)
        .pendingDispatches
        .push(pendingDispatch);
    }
  }

  // Pass 4: one card per owner message. Groups were created in message order,
  // so merging in insertion order keeps the cards chronological.
  const projectionsByOwnerMessageId = new Map<string, ManagedTaskTurnProjection>();
  for (const projection of projectionsByGroupKey.values()) {
    const existing = projectionsByOwnerMessageId.get(projection.ownerMessageId);
    if (!existing) {
      projectionsByOwnerMessageId.set(projection.ownerMessageId, projection);
      continue;
    }
    existing.waveId = existing.waveId ?? projection.waveId;
    existing.taskIds.push(...projection.taskIds);
    existing.pendingDispatches.push(...projection.pendingDispatches);
    existing.fallbackTasks.push(...projection.fallbackTasks);
  }

  return Array.from(projectionsByOwnerMessageId.values()).filter((projection) => (
    projection.taskIds.length > 0 || projection.pendingDispatches.length > 0
  ));
};
