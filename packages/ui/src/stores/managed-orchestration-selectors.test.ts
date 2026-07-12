import { describe, expect, test } from 'bun:test';
import { createManagedTaskRecord, toManagedTaskEvent } from '@openchamber/orchestration-runtime';

import { createManagedOrchestrationStore, managedOrchestrationSelectors } from './useManagedOrchestrationStore';

const task = (taskId: string, rootSessionId: string, sequence: number) => toManagedTaskEvent(createManagedTaskRecord({
  taskId,
  idempotencyKey: taskId,
  rootSessionId,
  parentTaskId: null,
  directory: '/workspace',
  sequence,
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: taskId,
  prompt: taskId,
  attempt: 1,
  priorTaskId: null,
  executionKind: 'start',
  createdAt: sequence,
  timeoutAt: null,
})).properties.task;

describe('managed orchestration selectors', () => {
  test('keeps root and task selectors referentially isolated', () => {
    const store = createManagedOrchestrationStore();
    const rootSelector = managedOrchestrationSelectors.taskIdsForRoot('ses_root');
    const taskSelector = managedOrchestrationSelectors.task('dvr_task_1');
    store.getState().ingestEvent({
      type: 'openchamber:managed-task',
      properties: { owner: 'devryan', directory: '/workspace', task: task('dvr_task_1', 'ses_root', 1) },
    });
    const rootIds = rootSelector(store.getState());
    const selectedTask = taskSelector(store.getState());

    store.getState().ingestEvent({
      type: 'openchamber:managed-task',
      properties: { owner: 'devryan', directory: '/workspace', task: task('dvr_task_2', 'ses_other', 2) },
    });

    expect(rootSelector(store.getState())).toBe(rootIds);
    expect(taskSelector(store.getState())).toBe(selectedTask);
    expect(managedOrchestrationSelectors.taskIdsForRoot('ses_missing')(store.getState())).toBe(
      managedOrchestrationSelectors.emptyTaskIds,
    );
  });

  test('derives deterministic queue positions without returning a collection', () => {
    const store = createManagedOrchestrationStore();
    for (const candidate of [task('dvr_task_3', 'ses_root', 3), task('dvr_task_1', 'ses_root', 1), task('dvr_task_2', 'ses_root', 2)]) {
      store.getState().ingestEvent({
        type: 'openchamber:managed-task',
        properties: { owner: 'devryan', directory: '/workspace', task: candidate },
      });
    }
    expect(managedOrchestrationSelectors.queuePosition('dvr_task_1')(store.getState())).toBe(1);
    expect(managedOrchestrationSelectors.queuePosition('dvr_task_2')(store.getState())).toBe(2);
    expect(managedOrchestrationSelectors.queuePosition('dvr_task_3')(store.getState())).toBe(3);
  });
});
