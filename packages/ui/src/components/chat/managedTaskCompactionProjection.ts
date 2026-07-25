import {
  isTerminalManagedTaskStatus,
  type ManagedTaskEventRecord,
} from '@openchamber/orchestration-runtime';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import type { ManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';

type CompactionMessage = {
  info: Message;
  parts: Part[];
};

const EMPTY_TASK_IDS: readonly string[] = Object.freeze([]);

const isValidTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const getPartText = (part: Part): string => {
  const text = (part as { text?: unknown }).text;
  if (typeof text === 'string') {
    return text;
  }
  const content = (part as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
};

export const hasCompactionPart = (message: Pick<CompactionMessage, 'parts'>): boolean => (
  message.parts.some((part) => part?.type === 'compaction')
);

export const isCompactionBoundaryMessage = (
  message: Pick<CompactionMessage, 'parts'>,
): boolean => (
  hasCompactionPart(message)
  || message.parts.some((part) => part?.type === 'text' && getPartText(part).trim() === '/compact')
);

export const getLatestCompactionBoundaryAt = (
  messages: readonly CompactionMessage[],
): number | null => {
  let latestBoundaryAt: number | null = null;

  for (const message of messages) {
    if (!isCompactionBoundaryMessage(message)) {
      continue;
    }

    const createdAt = message.info.time?.created;
    if (!isValidTimestamp(createdAt)) {
      continue;
    }

    if (latestBoundaryAt === null || createdAt > latestBoundaryAt) {
      latestBoundaryAt = createdAt;
    }
  }

  return latestBoundaryAt;
};

const lineageCrossesCompactionBoundary = (
  state: ManagedOrchestrationStore,
  taskId: string,
  boundaryAt: number,
): boolean => {
  const visitedTaskIds = new Set<string>();
  let currentTaskId: string | null = taskId;

  while (currentTaskId) {
    if (visitedTaskIds.has(currentTaskId)) {
      return false;
    }
    visitedTaskIds.add(currentTaskId);

    const task: ManagedTaskEventRecord | undefined = state.tasksById[currentTaskId];
    if (!task) {
      return false;
    }
    if (task.createdAt <= boundaryAt) {
      return true;
    }

    currentTaskId = task.priorTaskId;
  }

  return false;
};

const isUndispositionedTask = (
  state: ManagedOrchestrationStore,
  taskId: string,
): boolean => {
  const task = state.tasksById[taskId];
  if (!task) {
    return false;
  }
  if (!isTerminalManagedTaskStatus(task.status)) {
    return true;
  }

  const envelope = state.resultEnvelopesByTaskId[taskId];
  return !envelope || envelope.action === null;
};

export const selectCompactionCarryoverTaskIds = (
  state: ManagedOrchestrationStore,
  rootSessionId: string,
  boundaryAt: number | null,
): readonly string[] => {
  if (!rootSessionId || !isValidTimestamp(boundaryAt)) {
    return EMPTY_TASK_IDS;
  }

  const taskIds = state.taskIdsByRootId[rootSessionId] ?? EMPTY_TASK_IDS;
  if (taskIds.length === 0) {
    return EMPTY_TASK_IDS;
  }

  const carryoverTaskIds = taskIds.filter((taskId) => {
    const task = state.tasksById[taskId];
    return task?.rootSessionId === rootSessionId
      && isUndispositionedTask(state, taskId)
      && lineageCrossesCompactionBoundary(state, taskId, boundaryAt);
  });

  return carryoverTaskIds.length > 0 ? carryoverTaskIds : EMPTY_TASK_IDS;
};
