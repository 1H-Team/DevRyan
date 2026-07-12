import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';

const input = {
  idempotencyKey: 'publication-task',
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: 'Publication task',
  prompt: 'Test reentrant publication.',
  timeoutAt: null,
};

describe('managed scheduler event publication', () => {
  test('does not hold the mutation lock while an async publisher calls the scheduler', async () => {
    let scheduler;
    const published = [];
    scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) {
          await control.markAccepted();
          return { status: 'completed' };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      publishEvent: async (event) => {
        published.push(event.properties.task.status);
        await scheduler.releaseModeLease('ses_unrelated', 'orchestrator');
      },
      createTaskId: () => 'dvr_task_publication',
      createLeaseToken: () => 'dvr_lease_publication',
      now: () => 1_000,
    });

    const submitted = await Promise.race([
      scheduler.submit(input),
      new Promise((_, reject) => setTimeout(() => reject(new Error('submit deadlocked')), 200)),
    ]);
    await scheduler.waitForTask(submitted.taskId);
    await scheduler.flush();

    expect(published).toEqual(['queued', 'starting', 'running', 'completed']);
  });
});
