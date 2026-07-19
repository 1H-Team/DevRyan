import type { ManagedTaskEventRecord } from '@openchamber/orchestration-runtime';

const MANAGED_TASK_ROW_BATCH = 24;
const SAME_CHILD_EXECUTION_KINDS = new Set(['resume', 'recover_in_place', 'retry_in_place']);

export const collapseManagedTaskLineages = (
  taskIds: readonly string[],
  getTask: (taskId: string) => ManagedTaskEventRecord | undefined,
): readonly string[] => {
  const hiddenTaskIds = new Set<string>();
  const availableTaskIds = new Set(taskIds);
  for (const taskId of taskIds) {
    const task = getTask(taskId);
    if (
      !task?.priorTaskId
      || !SAME_CHILD_EXECUTION_KINDS.has(task.executionKind)
      || !availableTaskIds.has(task.priorTaskId)
    ) continue;
    hiddenTaskIds.add(task.priorTaskId);
  }
  return hiddenTaskIds.size > 0
    ? taskIds.filter((taskId) => !hiddenTaskIds.has(taskId))
    : taskIds;
};

type ManagedTaskWindow = {
  hiddenCount: number;
  visibleTaskIds: readonly string[];
  agentGroups?: Array<{ agent: string; taskIds: string[] }>;
};

export const getManagedTaskWindow = (
  taskIds: readonly string[],
  visibleLimit = MANAGED_TASK_ROW_BATCH,
  getAgent?: (taskId: string) => string | undefined,
): ManagedTaskWindow => {
  const hiddenCount = Math.max(0, taskIds.length - visibleLimit);
  const visibleTaskIds = hiddenCount > 0 ? taskIds.slice(-visibleLimit) : taskIds;
  const window = {
    hiddenCount,
    visibleTaskIds,
  };
  if (!getAgent) return window;

  const groups = new Map<string, { agent: string; taskIds: string[] }>();
  for (const taskId of visibleTaskIds) {
    const agent = getAgent(taskId)?.trim();
    if (!agent) continue;
    const key = agent.toLocaleLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.taskIds.push(taskId);
    } else {
      groups.set(key, { agent, taskIds: [taskId] });
    }
  }

  return {
    ...window,
    agentGroups: Array.from(groups.values()),
  };
};

export const shouldRenderManagedTaskList = (input: {
  available: boolean | null;
  taskCount: number;
  recoveryWarning: string | null;
  snapshotError: string | null;
}) => !(
  (input.available === false && !input.recoveryWarning && !input.snapshotError)
  || (input.taskCount === 0 && !input.recoveryWarning && !input.snapshotError)
);

export { MANAGED_TASK_ROW_BATCH };
