import type { Part, ToolPart } from '@opencode-ai/sdk/v2';

import { isManagedTaskToolName } from './message/parts/toolRenderUtils';

type ManagedTaskPayload = {
  task?: { taskId?: unknown };
  followUpTask?: { task?: { taskId?: unknown } };
};

export type PendingManagedTaskDispatch = {
  partId: string;
  agent: string;
  label: string;
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

const taskIdFromPart = (part: ToolPart): string | null => {
  if (!isManagedTaskToolName(part.tool)) return null;
  const state = part.state as Record<string, unknown> | undefined;
  const input = state?.input as Record<string, unknown> | undefined;
  const action = typeof input?.action === 'string' ? input.action.trim() : '';
  if (action !== 'start' && action !== 'retry' && action !== 'resume') return null;
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
  if (action !== 'start' || (status !== 'pending' && status !== 'running')) return null;

  const agent = typeof input?.agent === 'string' ? input.agent.trim() : '';
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  const normalizedAgent = agent || 'agent';
  return {
    partId: part.id,
    agent: normalizedAgent,
    label: label || `Managed ${normalizedAgent} task`,
  };
};

export const resolveManagedTaskDispatch = (parts: readonly Part[]) => {
  const taskIds: string[] = [];
  const pendingDispatches: PendingManagedTaskDispatch[] = [];
  let anchorPartId: string | null = null;
  const seen = new Set<string>();

  for (const part of parts) {
    if (part.type !== 'tool' || !isManagedTaskToolName((part as ToolPart).tool)) continue;
    const taskId = taskIdFromPart(part as ToolPart);
    if (taskId) {
      if (!seen.has(taskId)) {
        anchorPartId ??= part.id;
        seen.add(taskId);
        taskIds.push(taskId);
      }
      continue;
    }

    const pendingDispatch = pendingDispatchFromPart(part as ToolPart);
    if (!pendingDispatch) continue;
    anchorPartId ??= part.id;
    pendingDispatches.push(pendingDispatch);
  }

  return { anchorPartId, taskIds, pendingDispatches };
};
