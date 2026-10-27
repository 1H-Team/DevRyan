import { selectRequiredCheckTasks, validateTaskPrerequisites } from '@devryan/orchestration-runtime';

export async function verifyTaskPrerequisites(task, { listTasks, project }) {
  validateTaskPrerequisites(task.taskPrerequisites);
  if (!task.taskPrerequisites?.length) return true;
  if (!task.dispatchObjectiveId) return false;
  const selected = selectRequiredCheckTasks(listTasks(task.rootSessionId), task.dispatchObjectiveId);
  for (const ref of task.taskPrerequisites) {
    const producer = selected.find(item => item.taskId === ref.taskId && item.rootSessionId === task.rootSessionId
      && item.directory === task.directory && item.dispatchObjectiveId === task.dispatchObjectiveId && item.status === 'completed');
    const definition = producer?.requiredChecks?.find(check => check.name === ref.checkName);
    if (!definition || JSON.stringify(definition.paths) !== JSON.stringify(ref.paths)) return false;
    const check = (await project(producer)).find(entry => entry.name === ref.checkName);
    if (check?.status !== 'passed' || check.coverage.contentHash !== ref.contentHash) return false;
  }
  return true;
}
