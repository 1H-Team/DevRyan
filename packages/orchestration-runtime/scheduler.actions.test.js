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

const createTerminalHarness = async ({
  failureReason = 'provider failed after useful work',
  inPlaceRetryResult = { status: 'completed', recoverablePreview: 'continued with replacement model' },
  resumable = true,
  resumeResult = { status: 'completed', recoverablePreview: 'resumed result' },
  submitOverrides = {},
} = {}) => {
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
          failureReason,
          partial: true,
          recoverablePreview: 'useful partial output',
          canonicalRefs: [{ type: 'message', id: `msg_${task.taskId}` }],
          resumable,
        };
      },
      async resume(task, control) {
        resumes.push(task);
        await control.markAccepted();
        return resumeResult;
      },
      async retryInPlace(task, control) {
        inPlaceRetries.push(task);
        await control.markAccepted();
        return inPlaceRetryResult;
      },
      async abort() { return { aborted: true }; },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return {}; },
    },
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    now: () => 1_000 + taskCounter,
  });
  const original = await scheduler.submit(input(submitOverrides));
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

  test('allows one grouped agent retry, rejects another, and leaves manual retry in place available', async () => {
    const { inPlaceRetries, original, scheduler, starts } = await createTerminalHarness({
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });

    const firstRecovery = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'grouped-retry-1',
    });
    const failedRecovery = await scheduler.waitForTask(firstRecovery.followUpTask.taskId);

    expect(failedRecovery).toMatchObject({ attempt: 2, executionKind: 'retry', status: 'failed' });
    await expect(scheduler.acknowledgeResult(failedRecovery.taskId, {
      action: 'retry',
      idempotencyKey: 'grouped-retry-2',
    })).rejects.toMatchObject({ code: 'managed_retry_limit_reached' });
    await expect(scheduler.acknowledgeResult(failedRecovery.taskId, {
      action: 'resume',
      idempotencyKey: 'grouped-resume-2',
    })).rejects.toMatchObject({ code: 'managed_retry_limit_reached' });
    expect(scheduler.getResultEnvelope(failedRecovery.taskId).action).toBeNull();
    expect(starts).toHaveLength(2);

    const manualRecovery = await scheduler.acknowledgeResult(failedRecovery.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'manual-retry-in-place',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    const settled = await scheduler.waitForTask(manualRecovery.followUpTask.taskId);

    expect(manualRecovery.followUpTask).toMatchObject({
      attempt: 3,
      childSessionId: failedRecovery.childSessionId,
      executionKind: 'retry_in_place',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    expect(inPlaceRetries).toHaveLength(1);
    expect(settled.status).toBe('completed');
  });

  test('allows one grouped agent resume and rejects a second resume', async () => {
    const { original, scheduler } = await createTerminalHarness({
      resumeResult: {
        status: 'failed',
        failureReason: 'provider still unavailable',
        resumable: true,
      },
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });

    const firstRecovery = await scheduler.acknowledgeResult(original.taskId, {
      action: 'resume',
      idempotencyKey: 'grouped-resume-1',
    });
    const failedRecovery = await scheduler.waitForTask(firstRecovery.followUpTask.taskId);

    expect(failedRecovery).toMatchObject({ attempt: 2, executionKind: 'resume', status: 'failed' });
    await expect(scheduler.acknowledgeResult(failedRecovery.taskId, {
      action: 'resume',
      idempotencyKey: 'grouped-resume-2',
    })).rejects.toMatchObject({ code: 'managed_retry_limit_reached' });
    expect(scheduler.getResultEnvelope(failedRecovery.taskId).action).toBeNull();
  });

  test('keeps ungrouped retries outside the grouped agent retry ceiling', async () => {
    const { original, scheduler } = await createTerminalHarness();

    const firstRecovery = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'ungrouped-retry-1',
    });
    const failedRecovery = await scheduler.waitForTask(firstRecovery.followUpTask.taskId);
    const secondRecovery = await scheduler.acknowledgeResult(failedRecovery.taskId, {
      action: 'retry',
      idempotencyKey: 'ungrouped-retry-2',
    });

    expect(secondRecovery.followUpTask).toMatchObject({ attempt: 3, executionKind: 'retry' });
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

  test('leaves provider usage limits unacknowledged until a selected manual retry', async () => {
    const { inPlaceRetries, original, scheduler, starts } = await createTerminalHarness({
      failureReason: "You've hit your session limit · resets 7:30pm",
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });
    const originalStartCount = starts.length;

    for (const action of ['continue', 'retry', 'resume', 'recover_in_place', 'abandon']) {
      await expect(scheduler.acknowledgeResult(original.taskId, {
        action,
        idempotencyKey: `provider-limit-${action}`,
      })).rejects.toMatchObject({ code: 'manual_model_recovery_required' });
    }
    expect(scheduler.getResultEnvelope(original.taskId)).toMatchObject({ action: null });
    expect(inPlaceRetries).toHaveLength(0);

    await expect(scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'provider-limit-missing-thinking',
      providerId: 'openai',
      modelId: 'gpt-5.4',
    })).rejects.toMatchObject({ code: 'missing_recovery_model' });

    const action = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'provider-limit-manual-recovery',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    const settled = await scheduler.waitForTask(action.followUpTask.taskId);

    expect(action.followUpTask).toMatchObject({
      attempt: 2,
      childSessionId: original.childSessionId,
      executionKind: 'retry_in_place',
      priorTaskId: original.taskId,
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    expect(starts).toHaveLength(originalStartCount);
    expect(inPlaceRetries).toHaveLength(1);
    expect(settled.status).toBe('completed');
  });

  test('derives one durable parent continuation after delayed provider recovery', async () => {
    const { original, scheduler } = await createTerminalHarness({
      failureReason: 'Anthropic rate limit reached for Claude Opus',
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });
    const action = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'provider-limit-delayed-recovery',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'xhigh',
    });
    const recovered = await scheduler.waitForTask(action.followUpTask.taskId);

    expect(scheduler.listReadyProviderRecoveryContinuations()).toEqual([{
      sourceTaskId: original.taskId,
      taskId: recovered.taskId,
      rootSessionId: 'ses_root',
      childSessionId: original.childSessionId,
      directory: '/workspace',
    }]);
    expect(scheduler.listReadyProviderRecoveryContinuations({
      sessionId: original.childSessionId,
    })).toHaveLength(1);
    expect(scheduler.listReadyProviderRecoveryContinuations({
      sessionId: 'ses_unrelated',
    })).toEqual([]);

    await scheduler.acknowledgeResult(recovered.taskId, {
      action: 'continue',
      idempotencyKey: 'collect-recovered-result',
    });
    expect(scheduler.listReadyProviderRecoveryContinuations()).toEqual([]);
  });

  test('does not wake a parent for ungrouped or repeatedly provider-limited recovery work', async () => {
    const ungrouped = await createTerminalHarness({
      failureReason: 'Monthly usage limit reached',
    });
    const ungroupedRecovery = await ungrouped.scheduler.acknowledgeResult(ungrouped.original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'ungrouped-provider-recovery',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: null,
    });
    await ungrouped.scheduler.waitForTask(ungroupedRecovery.followUpTask.taskId);
    expect(ungrouped.scheduler.listReadyProviderRecoveryContinuations()).toEqual([]);

    const limitedAgain = await createTerminalHarness({
      failureReason: 'Monthly usage limit reached',
      inPlaceRetryResult: {
        status: 'failed',
        failureReason: 'OpenAI rate limit reached',
        partial: true,
        resumable: true,
      },
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });
    const repeatedRecovery = await limitedAgain.scheduler.acknowledgeResult(limitedAgain.original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'repeated-provider-recovery',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'medium',
    });
    await limitedAgain.scheduler.waitForTask(repeatedRecovery.followUpTask.taskId);
    expect(limitedAgain.scheduler.listReadyProviderRecoveryContinuations()).toEqual([]);
  });

  test('rejects new automatic in-place recovery while retaining its durable enum', async () => {
    const { original, scheduler } = await createTerminalHarness();

    await expect(scheduler.acknowledgeResult(original.taskId, {
      action: 'recover_in_place',
      idempotencyKey: 'invalid-provider-limit-recovery',
      providerId: 'openai',
      modelId: 'gpt-5.4',
    })).rejects.toMatchObject({ code: 'manual_model_recovery_required' });
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
