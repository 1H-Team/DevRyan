import type { ManagedTaskEventRecord } from '@openchamber/orchestration-runtime';

export const navigateToManagedTaskChild = (
  task: ManagedTaskEventRecord,
  navigate: (sessionId: string, directory: string) => void,
): boolean => {
  if (!task.childSessionId) return false;
  navigate(task.childSessionId, task.directory);
  return true;
};
