import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';

const input = (overrides = {}) => ({
  idempotencyKey: 'original',
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: 'Original task',
  prompt: 'Perform the original task.',
  timeoutAt: null,
  ...overrides,
});

const createTerminalHarness = async ({ resumable = true } = {}) => {
  let taskCounter = 0;
  let leaseCounter = 0;
  const starts = [];
  const resumes = [];
  const inPlaceRetries = [];
  const scheduler = createManagedTaskScheduler({
    executor: {
      async start(task, control) {
        starts.push(task);
        await control.setChildSessionId(`ses_child_${task.taskId}`);
        await control.markAccepted();
        return {
          status: 'failed',
          failureReason: 'provider failed after useful work',
          partial: true,
          recoverablePreview: 'useful partial output',
          canonicalRefs: [{ type: 'message', id: `msg_${task.taskId}` }],
          resumable,
        };
      },
      async resume(task, control) {
        resumes.push(task);
        await control.markAccepted();
        return { status: 'completed', recoverablePreview: 'resumed result' };
      },
      async retryInPlace(task, control) {
        inPlaceRetries.push(task);
        await control.markAccepted();
        return { status: 'completed', recoverablePreview: 'continued with replacement model' };
      },
      async abort() { return { aborted: true }; },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return {}; },
    },
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    now: () => 1_000 + taskCounter,
  });
  const original = await scheduler.submit(input());
  await scheduler.waitForTask(original.taskId);
  return { inPlaceRetries, original: scheduler.getTask(original.taskId), resumes, scheduler, starts };
};

describe('managed scheduler parent actions', () => {
  test('retries as one linked attempt and deduplicates repeated action requests', async () => {
    const { original, scheduler, starts } = await createTerminalHarness();

    const first = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'retry-action-1',
    });
    const second = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'retry-action-1',
    });

    expect(first.followUpTask.taskId).toBe(second.followUpTask.taskId);
    expect(first.followUpTask.executionKind).toBe('retry');
    expect(first.followUpTask.priorTaskId).toBe(original.taskId);
    expect(first.followUpTask.attempt).toBe(2);
    const retryStarts = starts.filter((task) => task.executionKind === 'retry');
    expect(retryStarts).toHaveLength(1);
    expect(retryStarts[0].childSessionId).toBeNull();
    expect(first.followUpTask.childSessionId).not.toBe(original.childSessionId);
    expect(first.envelope.action).toBe('retry');
    expect(first.envelope.followUpTaskId).toBe(first.followUpTask.taskId);

    await expect(scheduler.acknowledgeResult(original.taskId, {
      action: 'abandon',
      idempotencyKey: 'different-action',
    })).rejects.toThrow('result is already acknowledged with retry');
  });

  test('resumes the canonical child without replaying start', async () => {
    const { original, resumes, scheduler, starts } = await createTerminalHarness();
    const originalStartCount = starts.length;

    const action = await scheduler.acknowledgeResult(original.taskId, {
      action: 'resume',
      idempotencyKey: 'resume-action-1',
    });
    const settled = await scheduler.waitForTask(action.followUpTask.taskId);

    expect(action.followUpTask.executionKind).toBe('resume');
    expect(action.followUpTask.childSessionId).toBe(original.childSessionId);
    expect(starts).toHaveLength(originalStartCount);
    expect(resumes).toHaveLength(1);
    expect(resumes[0].prompt).toBe(original.prompt);
    expect(settled.status).toBe('completed');
  });

  test('retries in place on the canonical child with the selected model', async () => {
    const { inPlaceRetries, original, scheduler, starts } = await createTerminalHarness();
    const originalStartCount = starts.length;

    const action = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'retry-in-place-action-1',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    const settled = await scheduler.waitForTask(action.followUpTask.taskId);

    expect(action.followUpTask).toMatchObject({
      childSessionId: original.childSessionId,
      executionKind: 'retry_in_place',
      priorTaskId: original.taskId,
      attempt: 2,
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    expect(starts).toHaveLength(originalStartCount);
    expect(inPlaceRetries).toHaveLength(1);
    expect(inPlaceRetries[0].childSessionId).toBe(original.childSessionId);
    expect(settled.status).toBe('completed');
    expect(action.envelope.action).toBe('retry_in_place');
  });

  test('rejects resume when the terminal result is not resumable', async () => {
    const { original, scheduler } = await createTerminalHarness({ resumable: false });

    await expect(scheduler.acknowledgeResult(original.taskId, {
      action: 'resume',
      idempotencyKey: 'resume-unavailable',
    })).rejects.toThrow('result cannot be resumed');
  });

  test('acknowledges continue or abandon without creating work', async () => {
    const { original, scheduler, starts } = await createTerminalHarness();
    const startCount = starts.length;

    const action = await scheduler.acknowledgeResult(original.taskId, {
      action: 'continue',
      idempotencyKey: 'continue-action',
    });

    expect(action.followUpTask).toBeNull();
    expect(action.envelope.action).toBe('continue');
    expect(action.envelope.acknowledgedAt).not.toBeNull();
    expect(starts).toHaveLength(startCount);
  });
});
