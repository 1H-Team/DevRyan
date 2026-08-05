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
