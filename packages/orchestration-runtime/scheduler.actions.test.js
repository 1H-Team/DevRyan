import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler, USER_STOPPED_RECOVERY } from './scheduler.js';

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
  schedulerOptions = {},
  startResult = null,
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
        return startResult ?? {
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
    ...schedulerOptions,
  });
  const original = await scheduler.submit(input(submitOverrides));
  await scheduler.waitForTask(original.taskId);
  return { inPlaceRetries, original: scheduler.getTask(original.taskId), resumes, scheduler, starts };
};

describe('managed follow-up timeout windows', () => {
  const NINETY_MINUTES = 90 * 60 * 1_000;

  const createWindowHarness = async (submitOverrides = {}) => {
    let taskCounter = 0;
    let leaseCounter = 0;
    let clock = 1_000;
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(task, control) {
          await control.setChildSessionId(`ses_child_${task.taskId}`);
          await control.markAccepted();
          return {
            status: 'failed',
            failureReason: 'Managed task timed out at 2000',
            partial: true,
            recoverablePreview: 'useful partial output',
            canonicalRefs: [],
            resumable: true,
          };
        },
        async resume(task, control) { await control.markAccepted(); return { status: 'completed' }; },
        async retryInPlace(task, control) { await control.markAccepted(); return { status: 'completed' }; },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => `dvr_task_${++taskCounter}`,
      createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
      now: () => clock,
    });
    const original = await scheduler.submit(input({
      timeoutAt: clock + NINETY_MINUTES,
      ...submitOverrides,
    }));
    await scheduler.waitForTask(original.taskId);
    return {
      scheduler,
      original: scheduler.getTask(original.taskId),
      advance: (ms) => { clock += ms; },
      readClock: () => clock,
    };
  };

  for (const action of ['retry', 'resume', 'retry_in_place']) {
    test(`a ${action} follow-up inherits the source task's window`, async () => {
      const { scheduler, original, advance, readClock } = await createWindowHarness();
      advance(60 * 60 * 1_000);
      const result = await scheduler.acknowledgeResult(original.taskId, {
        action,
        idempotencyKey: `window-${action}`,
        providerId: 'openai',
        modelId: 'gpt-5.6',
        variant: 'medium',
        // What the transport supplies today: a bare 30-minute default.
        timeoutAt: readClock() + 30 * 60 * 1_000,
      });
      expect(result.followUpTask.timeoutAt - readClock()).toBe(NINETY_MINUTES);
    });
  }

  test('an explicitly longer requested window wins over the inherited one', async () => {
    const { scheduler, original, advance, readClock } = await createWindowHarness();
    advance(1_000);
    const requested = readClock() + 4 * 60 * 60 * 1_000;
    const result = await scheduler.acknowledgeResult(original.taskId, {
      action: 'resume',
      idempotencyKey: 'window-explicit',
      timeoutAt: requested,
    });
    expect(result.followUpTask.timeoutAt).toBe(requested);
  });

  test('a source task without a deadline leaves the requested window untouched', async () => {
    const { scheduler, original, advance, readClock } = await createWindowHarness({ timeoutAt: null });
    advance(1_000);
    const requested = readClock() + 30 * 60 * 1_000;
    const result = await scheduler.acknowledgeResult(original.taskId, {
      action: 'resume',
      idempotencyKey: 'window-no-source-deadline',
      timeoutAt: requested,
    });
    expect(result.followUpTask.timeoutAt).toBe(requested);
  });
});

describe('managed scheduler parent actions', () => {
  test.each(['retry', 'resume'])('%s creation and source acknowledgement share one durable commit', async action => {
    let saved, failSave = false;
    const writes = [];
    const h = await createTerminalHarness({ schedulerOptions: { persistence: {
      load: async () => saved,
      save: async state => { if (failSave) throw Error('save refused'); saved = structuredClone(state); writes.push(saved); },
    } } });
    try {
      let checks = 0;
      await expect(h.scheduler.acknowledgeResult(h.original.taskId, { action, idempotencyKey: 'revoked-followup',
        authorize: async () => { if (++checks === 3) throw Error('revoked'); } })).rejects.toThrow('revoked');
      expect(checks).toBe(3);
      expect(h.scheduler.getSnapshot().tasks).toHaveLength(1);
      expect(h.scheduler.getResultEnvelope(h.original.taskId).action).toBeNull();
      expect(h.starts).toHaveLength(1); expect(h.resumes).toHaveLength(0);
      failSave = true;
      await expect(h.scheduler.acknowledgeResult(h.original.taskId, { action, idempotencyKey: 'failed-save' })).rejects.toThrow('save refused');
      expect(h.scheduler.getSnapshot().tasks).toHaveLength(1);
      expect(h.scheduler.getResultEnvelope(h.original.taskId).action).toBeNull();
      failSave = false;
      const result = await h.scheduler.acknowledgeResult(h.original.taskId, { action, idempotencyKey: 'successful-followup' });
      expect(writes.filter(state => state.tasks.length > 1).every(state => state.resultEnvelopes.find(row => row.taskId === h.original.taskId).followUpTaskId === result.followUpTask.taskId)).toBe(true);
      const repeated = await h.scheduler.acknowledgeResult(h.original.taskId, { action, idempotencyKey: 'different-retry-key' });
      expect(repeated.followUpTask.taskId).toBe(result.followUpTask.taskId);
      expect(h.scheduler.getSnapshot().tasks).toHaveLength(2);
    } finally { failSave = false; await h.scheduler.shutdown(); }
  });
  test('retries as one linked attempt and deduplicates repeated action requests', async () => {
    const { original, scheduler, starts } = await createTerminalHarness({
      submitOverrides: { readOnly: true },
    });

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
    expect(first.followUpTask.readOnly).toBe(true);
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

  test('rejects a read-only retry that overrides Explorer with Designer', async () => {
    const { original, scheduler, starts } = await createTerminalHarness({
      submitOverrides: { readOnly: true, agent: 'explorer' },
    });

    await expect(scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      agent: 'designer',
      idempotencyKey: 'retry-as-designer',
    })).rejects.toMatchObject({
      code: 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED',
    });

    expect(scheduler.getResultEnvelope(original.taskId).action).toBeNull();
    expect(starts).toHaveLength(1);
  });

  test('v2 acknowledgement binds action identity across repeated calls and rejects revoked final authority',async()=>{
   const {original,scheduler}=await createTerminalHarness();
   const identity='a'.repeat(64),options={action:'continue',idempotencyKey:'stable',acknowledgementIdentity:identity};
   await expect(scheduler.acknowledgeResult(original.taskId,{...options,authorize:async()=>{throw Error('Cancelled at final save');}})).rejects.toThrow('Cancelled at final save');
   expect(scheduler.getResultEnvelope(original.taskId).action).toBeNull();
   await scheduler.acknowledgeResult(original.taskId,options);
   expect((await scheduler.acknowledgeResult(original.taskId,{...options,idempotencyKey:'new-authorized-step'})).envelope.acknowledgementIdentity).toBe(identity);
   for(const changed of [{...options,acknowledgementIdentity:'b'.repeat(64)},{...options,acknowledgementIdentity:undefined},{...options,action:'abandon'}])
    await expect(scheduler.acknowledgeResult(original.taskId,changed)).rejects.toMatchObject({code:'result_already_acknowledged'});
  });

  test('parks a second grouped failure for user-selected manual recovery', async () => {
    const { inPlaceRetries, original, scheduler, starts } = await createTerminalHarness({
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });

    const firstRecovery = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'grouped-retry-1',
    });
    const failedRecovery = await scheduler.waitForTask(firstRecovery.followUpTask.taskId);

    expect(failedRecovery).toMatchObject({ attempt: 2, executionKind: 'retry', status: 'failed' });
    for (const action of ['continue', 'retry', 'resume', 'recover_in_place', 'abandon']) {
      await expect(scheduler.acknowledgeResult(failedRecovery.taskId, {
        action,
        idempotencyKey: `grouped-final-${action}`,
      })).rejects.toMatchObject({ code: 'manual_model_recovery_required' });
    }
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

  test('allows one grouped agent resume and parks a second failure for manual recovery', async () => {
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
    })).rejects.toMatchObject({ code: 'manual_model_recovery_required' });
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
      recoveryLineageId: 'dvr_lineage_1',
    });
    expect(original.recoveryLineageId).toBeNull();
    expect(starts).toHaveLength(originalStartCount);
    expect(inPlaceRetries).toHaveLength(1);
    expect(inPlaceRetries[0].childSessionId).toBe(original.childSessionId);
    expect(settled.status).toBe('completed');
    expect(action.envelope.action).toBe('retry_in_place');
    expect(action.envelope.autoResume).toBeNull();
  });

  test('follow-ups of a follow-up share the root lineage id', async () => {
    const { original, scheduler } = await createTerminalHarness({
      inPlaceRetryResult: {
        status: 'failed',
        failureReason: 'provider failed again',
        partial: true,
        resumable: true,
      },
    });
    const first = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'lineage-1',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    await scheduler.waitForTask(first.followUpTask.taskId);
    const second = await scheduler.acknowledgeResult(first.followUpTask.taskId, {
      action: 'resume',
      idempotencyKey: 'lineage-2',
    });
    expect(first.followUpTask.recoveryLineageId).toBe('dvr_lineage_1');
    expect(second.followUpTask.recoveryLineageId).toBe('dvr_lineage_1');
  });

  test('leaves provider usage limits unacknowledged until a selected manual retry', async () => {
    const { inPlaceRetries, original, scheduler, starts } = await createTerminalHarness({
      failureReason: "You've hit your session limit · resets 7:30pm",
      submitOverrides: { dispatchGroupId: 'msg_parent', readOnly: true },
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
      readOnly: true,
      recoveryLineageId: 'dvr_lineage_1',
    });
    expect(starts).toHaveLength(originalStartCount);
    expect(inPlaceRetries).toHaveLength(1);
    expect(settled.status).toBe('completed');
  });

  test('a manual retry of an auto-resuming provider limit records the acknowledged state', async () => {
    const { original, scheduler } = await createTerminalHarness({
      failureReason: "You've hit your session limit · resets 7:30pm",
      submitOverrides: { dispatchGroupId: 'msg_parent' },
      schedulerOptions: {
        autoResume: {
          resolveBackupExecution: () => null,
          attempt: async () => ({ outcome: 'deferred', retryAfterMs: 60_000, reason: 'test' }),
        },
      },
    });
    expect(scheduler.getResultEnvelope(original.taskId).autoResume).toMatchObject({
      enabled: true,
      cancelGeneration: 0,
    });

    const action = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'manual-over-auto',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });

    expect(action.envelope.autoResume).toMatchObject({
      state: 'acknowledged',
      reason: 'manual_retry',
      cancelGeneration: 1,
      nextAttemptAt: null,
    });
    expect(action.followUpTask.recoveryLineageId).toBe('dvr_lineage_1');
    await scheduler.waitForTask(action.followUpTask.taskId);
    expect(scheduler.getDiagnostics().pendingAutoResumeCount).toBe(0);
    await scheduler.shutdown();
  });

  test('retries provider prompt rejection once in a fresh child with a rewritten prompt', async () => {
    const failureReason = 'The model provider could not complete this turn: Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt.';
    const { original, scheduler, starts } = await createTerminalHarness({
      failureReason,
      submitOverrides: {
        dispatchGroupId: 'msg_parent',
        variant: 'xhigh',
      },
    });

    for (const action of ['resume', 'recover_in_place', 'retry_in_place']) {
      await expect(scheduler.acknowledgeResult(original.taskId, {
        action,
        idempotencyKey: `prompt-rejection-${action}`,
        providerId: 'openai',
        modelId: 'gpt-5.6',
        variant: 'high',
      })).rejects.toMatchObject({ code: 'provider_prompt_rejection_requires_fresh_retry' });
    }
    await expect(scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'prompt-rejection-missing-override',
    })).rejects.toMatchObject({ code: 'provider_prompt_rejection_requires_reframed_prompt' });
    await expect(scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'prompt-rejection-same-override',
      prompt: `  ${original.prompt}  `,
    })).rejects.toMatchObject({ code: 'provider_prompt_rejection_requires_reframed_prompt' });

    const rewrittenPrompt = [
      'Outcome: Complete the original task.',
      'Starting points: inspect the existing workspace changes first.',
      'Requirements: preserve all correct partial work and finish the requested behavior.',
      'Verification: run the focused tests.',
      'Return: summarize changes and verification.',
    ].join('\n');
    const recovery = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'prompt-rejection-clean-retry',
      prompt: rewrittenPrompt,
    });
    const finalRejected = await scheduler.waitForTask(recovery.followUpTask.taskId);

    expect(recovery.followUpTask).toMatchObject({
      attempt: 2,
      priorTaskId: original.taskId,
      executionKind: 'retry',
      providerId: original.providerId,
      modelId: original.modelId,
      variant: 'xhigh',
      prompt: rewrittenPrompt,
    });
    expect(recovery.followUpTask.childSessionId).not.toBe(original.childSessionId);
    expect(starts).toHaveLength(2);
    expect(finalRejected).toMatchObject({ status: 'failed', failureReason, attempt: 2 });
    expect(scheduler.listReadyProviderRecoveryContinuations()).toHaveLength(1);

    await expect(scheduler.acknowledgeResult(finalRejected.taskId, {
      action: 'retry',
      idempotencyKey: 'prompt-rejection-third-attempt',
      prompt: `${rewrittenPrompt}\nDo not repeat the prior prompt.`,
    })).rejects.toMatchObject({ code: 'managed_retry_limit_reached' });
    await expect(scheduler.acknowledgeResult(finalRejected.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'prompt-rejection-final-in-place',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'high',
    })).rejects.toMatchObject({ code: 'provider_prompt_rejection_requires_fresh_retry' });

    const disposition = await scheduler.acknowledgeResult(finalRejected.taskId, {
      action: 'abandon',
      idempotencyKey: 'prompt-rejection-final-abandon',
    });
    expect(disposition.envelope.action).toBe('abandon');
    expect(disposition.followUpTask).toBeNull();
    expect(scheduler.listReadyProviderRecoveryContinuations()).toEqual([]);
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
      dispatchGroupId: original.dispatchGroupId,
      taskId: recovered.taskId,
      rootSessionId: 'ses_root',
      childSessionId: original.childSessionId,
      directory: '/workspace',
      kind: 'collect',
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

  test('derives a durable parent continuation for an uncollected ordinary completion', async () => {
    const { original, scheduler } = await createTerminalHarness({
      startResult: {
        status: 'completed',
        recoverablePreview: 'ordinary completed result',
      },
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });

    expect(scheduler.listReadyProviderRecoveryContinuations()).toEqual([{
      sourceTaskId: null,
      dispatchGroupId: original.dispatchGroupId,
      taskId: original.taskId,
      rootSessionId: 'ses_root',
      childSessionId: original.childSessionId,
      directory: '/workspace',
      kind: 'collect',
    }]);

    await scheduler.acknowledgeResult(original.taskId, {
      action: 'continue',
      idempotencyKey: 'collect-ordinary-result',
    });
    expect(scheduler.listReadyProviderRecoveryContinuations()).toEqual([]);
  });

  test('collection proof requires an unacknowledged recovered result and its current scoped lease', async () => {
    let time = 1000;
    const { scheduler, original } = await createTerminalHarness({ submitOverrides: { dispatchGroupId: 'msg_parent' },
      schedulerOptions: { now: () => time, providerRecoveryContinuationLeaseMs: 60_000 } });
    time = 2000;
    const recovery = await scheduler.acknowledgeResult(original.taskId, { action: 'retry_in_place', idempotencyKey: 'user-recovery',
      providerId: 'openai', modelId: 'gpt-5.6', variant: null });
    await scheduler.waitForTask(recovery.followUpTask.taskId);
    const scope = { taskId: recovery.followUpTask.taskId, rootSessionId: 'ses_root', directory: '/workspace', claimantId: 'plugin-one' };
    expect(await scheduler.verifyRecoveredCollection(scope)).toBeNull();
    await scheduler.claimProviderRecoveryContinuation(scope);
    expect(await scheduler.verifyRecoveredCollection(scope)).toMatchObject({ taskId: scope.taskId, dispatchGroupId: 'msg_parent',
      attempt: 2, createdAt: 2000, finishedAt: 2000 });
    for (const wrong of [{ claimantId: 'plugin-other' }, { rootSessionId: 'ses_other' }, { directory: '/other' }]) {
      expect(await scheduler.verifyRecoveredCollection({ ...scope, ...wrong })).toBeNull();
    }
    time = 62_000;
    expect(await scheduler.verifyRecoveredCollection(scope)).toBeNull();
    await scheduler.claimProviderRecoveryContinuation(scope);
    await scheduler.acknowledgeResult(scope.taskId, { action: 'continue', idempotencyKey: 'collected' });
    expect(await scheduler.verifyRecoveredCollection(scope)).toBeNull();
    scheduler.shutdown();
  });

  test('ordinary completed work is not proof of a user recovery', async () => {
    const { scheduler, original } = await createTerminalHarness({ submitOverrides: { dispatchGroupId: 'msg_parent' },
      startResult: { status: 'completed' } });
    const scope = { taskId: original.taskId, rootSessionId: 'ses_root', directory: '/workspace', claimantId: 'plugin-one' };
    await scheduler.claimProviderRecoveryContinuation(scope);
    expect(await scheduler.verifyRecoveredCollection(scope)).toBeNull();
    scheduler.shutdown();
  });

  test('claims a collectable parent continuation exactly once until release or acknowledgement', async () => {
    const { original, scheduler } = await createTerminalHarness({
      startResult: { status: 'completed', recoverablePreview: 'ordinary child result' },
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });
    const scope = {
      taskId: original.taskId,
      rootSessionId: original.rootSessionId,
      directory: original.directory,
    };

    await expect(scheduler.claimProviderRecoveryContinuation({
      ...scope,
      claimantId: 'plugin-one',
    })).resolves.toMatchObject({ claimed: true });
    await expect(scheduler.claimProviderRecoveryContinuation({
      ...scope,
      claimantId: 'plugin-two',
    })).resolves.toMatchObject({ claimed: false });
    await expect(scheduler.releaseProviderRecoveryContinuation({
      ...scope,
      claimantId: 'plugin-two',
    })).resolves.toEqual({ released: false });
    await expect(scheduler.releaseProviderRecoveryContinuation({
      ...scope,
      claimantId: 'plugin-one',
    })).resolves.toEqual({ released: true });
    await expect(scheduler.claimProviderRecoveryContinuation({
      ...scope,
      claimantId: 'plugin-two',
    })).resolves.toMatchObject({ claimed: true });

    await scheduler.acknowledgeResult(original.taskId, {
      action: 'continue',
      idempotencyKey: 'claim-acknowledged',
    });
    await expect(scheduler.claimProviderRecoveryContinuation({
      ...scope,
      claimantId: 'plugin-three',
    })).resolves.toEqual({ claimed: false, expiresAt: null });
    expect(scheduler.getDiagnostics().activeProviderRecoveryContinuationClaimCount).toBe(0);
  });

  test('allows another recovery continuation claimant after the lease expires', async () => {
    let clock = 1_000;
    const { original, scheduler } = await createTerminalHarness({
      startResult: { status: 'completed', recoverablePreview: 'ordinary child result' },
      submitOverrides: { dispatchGroupId: 'msg_parent' },
      schedulerOptions: {
        now: () => clock,
        providerRecoveryContinuationLeaseMs: 60_000,
      },
    });
    const scope = {
      taskId: original.taskId,
      rootSessionId: original.rootSessionId,
      directory: original.directory,
    };

    await expect(scheduler.claimProviderRecoveryContinuation({
      ...scope,
      claimantId: 'plugin-one',
    })).resolves.toEqual({ claimed: true, expiresAt: 61_000 });
    clock = 61_000;
    await expect(scheduler.claimProviderRecoveryContinuation({
      ...scope,
      claimantId: 'plugin-two',
    })).resolves.toEqual({ claimed: true, expiresAt: 121_000 });
  });

  test('never offers ungrouped or parked recovery work for collection', async () => {
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
    const repeated = await limitedAgain.scheduler.waitForTask(repeatedRecovery.followUpTask.taskId);
    // Parked for the user's Model Recovery choice: omitted so the parent is not
    // woken to collect or narrate it. The envelope stays unacknowledged.
    expect(repeated).toMatchObject({
      status: 'failed',
      failureReason: 'OpenAI rate limit reached',
    });
    expect(limitedAgain.scheduler.listReadyProviderRecoveryContinuations()).toEqual([]);
  });

  test('omits a deadline-exceeded parked result from continuation scans', async () => {
    const { original, scheduler } = await createTerminalHarness({
      failureReason: 'Managed task timed out at 1500',
      inPlaceRetryResult: {
        status: 'failed',
        failureReason: 'Managed task timed out at 4500',
        partial: true,
        resumable: true,
      },
      submitOverrides: { dispatchGroupId: 'msg_parent' },
    });
    const recovery = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'deadline-parked-recovery',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'medium',
    });
    await scheduler.waitForTask(recovery.followUpTask.taskId);

    expect(scheduler.listReadyProviderRecoveryContinuations()).toEqual([]);

    const parkedTaskId = recovery.followUpTask.taskId;
    await scheduler.acknowledgeResult(parkedTaskId, {
      action: 'retry_in_place',
      idempotencyKey: 'deadline-parked-user-retry',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'medium',
    });
    expect(scheduler.listReadyProviderRecoveryContinuations().some(
      (continuation) => continuation.taskId === parkedTaskId,
    )).toBe(false);
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

test('user stopped task requires explicit UI disposition and resumes once in the same child', async () => {
  const h = await createTerminalHarness({startResult:{status:'aborted',terminationIntent:'user_stopped',
    failureReason:'Stopped by the user',partial:true,recoverablePreview:'saved work',resumable:true},
    submitOverrides:{dispatchGroupId:'msg_dispatch',dispatchCallId:'call_dispatch'}});
  try {
    const original=h.scheduler.getTask(h.original.taskId);
    expect(original.terminationIntent).toBe('user_stopped');
    for(const action of ['continue','abandon','resume','retry','retry_in_place']) {
      await expect(h.scheduler.acknowledgeResult(original.taskId,{action,idempotencyKey:`agent-${action}`,
        providerId:'openai',modelId:'gpt-5.5',variant:'high'})).rejects.toMatchObject({code:'user_stopped_recovery_required'});
    }
    const options={action:'retry_in_place',idempotencyKey:'user-resume',providerId:'openai',modelId:'gpt-5.5',variant:'high',[USER_STOPPED_RECOVERY]:true};
    const [a,b]=await Promise.all([h.scheduler.acknowledgeResult(original.taskId,options),h.scheduler.acknowledgeResult(original.taskId,options)]);
    expect(a.followUpTask.taskId).toBe(b.followUpTask.taskId);
    expect(a.followUpTask).toMatchObject({childSessionId:original.childSessionId,priorTaskId:original.taskId,prompt:original.prompt,providerId:'openai',modelId:'gpt-5.5',variant:'high',attempt:2});
    await h.scheduler.waitForTask(a.followUpTask.taskId);
    expect(h.inPlaceRetries).toHaveLength(1);
    expect(h.scheduler.getTask(original.taskId)).toEqual(original);
  } finally {await h.scheduler.shutdown();}
});

test('durable stop request survives restart before terminal settlement and withdrawal is request scoped', async () => {
  let saved = null;
  const persistence = { async load() { return saved; }, async save(value) { saved = structuredClone(value); } };
  const executor = {
    async start(task, control) { await control.setChildSessionId('ses_crash_stop'); await control.markAccepted(); return new Promise(() => {}); },
    async abort() { return { aborted: true }; },
    async reconcile() { return { state: 'transient' }; },
    async readRecoverableResult() { return {}; },
    async shutdown() {},
  };
  const scheduler = createManagedTaskScheduler({ executor, persistence, now: () => 1000 });
  let restarted;
  try {
    const task = await scheduler.submit(input());
    await scheduler.flush();
    const stop = await scheduler.recordOperatorStop({ sessionId: 'ses_crash_stop', directory: '/workspace', requestedAt: 2000 });
    expect(stop?.taskId).toBe(task.taskId);
    expect(scheduler.getTask(task.taskId)).toMatchObject({ operatorStop: { state: 'pending' }, status: 'running' });
    expect(scheduler.getTask(task.taskId).terminationIntent).toBeUndefined();
    await expect(scheduler.acknowledgeResult(task.taskId, { action: 'retry_in_place', idempotencyKey: 'premature' }))
      .rejects.toMatchObject({ code: 'operator_stop_pending' });
    expect(await scheduler.withdrawOperatorStop({ ...stop, requestedAt: 1999 })).toBe(false);
    expect(await scheduler.withdrawOperatorStop({ ...stop, requestId: 'another_request' })).toBe(false);
    await scheduler.shutdown();
    restarted = createManagedTaskScheduler({ executor, persistence, now: () => 2001 });
    await restarted.initialize();
    expect(restarted.readOperatorStop({ sessionId: 'ses_crash_stop', directory: '/workspace', after: 1000 })).toEqual({ sessionId: 'ses_crash_stop', requestedAt: 2000, state: 'pending', durable: true });
    expect(restarted.readOperatorStop({ sessionId: 'ses_crash_stop', directory: '/other' })).toBeNull();
    expect(await restarted.withdrawOperatorStop(stop)).toBe(true);
    expect(restarted.readOperatorStop({ sessionId: 'ses_crash_stop' })).toBeNull();
    expect(restarted.getTask(task.taskId).terminationIntent).toBeUndefined();
  } finally { await scheduler.shutdown(); await restarted?.shutdown(); }
});


test('explicit user dismissal remains available after unconfirmed stop also meets provider recovery policy', async () => {
  const h = await createTerminalHarness({ startResult: { status: 'interrupted', terminationIntent: 'user_stopped',
    failureReason: 'Usage limit reached', partial: true, recoverablePreview: 'partial', resumable: true } });
  try {
    await expect(h.scheduler.acknowledgeResult(h.original.taskId, { action: 'abandon', idempotencyKey: 'model-dismiss' }))
      .rejects.toMatchObject({ code: 'user_stopped_recovery_required' });
    const result = await h.scheduler.acknowledgeResult(h.original.taskId, { action: 'abandon', idempotencyKey: 'user-dismiss', [USER_STOPPED_RECOVERY]: true });
    expect(result.envelope.action).toBe('abandon'); expect(result.followUpTask).toBeNull();
  } finally { await h.scheduler.shutdown(); }
});

for (const response of ['accepted', 'rejected']) test(`late ${response} HTTP stop resolves private pending receipt on an independently terminal task`, async () => {
  const h = await createTerminalHarness({ failureReason: 'Usage limit reached' });
  const terminal = h.scheduler.getTask(h.original.taskId), envelope = h.scheduler.getResultEnvelope(h.original.taskId);
  await h.scheduler.shutdown();
  const stop = { sessionId: terminal.childSessionId, taskId: terminal.taskId, leaseToken: terminal.leaseToken, requestedAt: 2000, requestId: 'late-stop' };
  const task = { ...terminal, operatorStop: { leaseToken: terminal.leaseToken, requestedAt: 2000, requestId: 'late-stop', state: 'pending' } };
  const scheduler = createManagedTaskScheduler({ now: () => 2001, persistence: {
    async load() { return { version: 1, tasks: [task], resultEnvelopes: [envelope] }; }, async save() {},
  }, executor: { async start() { throw new Error('No task may start while stop is pending'); } } });
  try {
    await scheduler.initialize();
    await expect(scheduler.acknowledgeResult(task.taskId, { action: 'retry_in_place', idempotencyKey: 'pending-ui', [USER_STOPPED_RECOVERY]: true,
      providerId: 'openai', modelId: 'replacement', variant: null })).rejects.toMatchObject({ code: 'operator_stop_pending' });
    expect(await scheduler.withdrawOperatorStop({ ...stop, requestId: 'wrong' })).toBe(false);
    if (response === 'accepted') {
      expect(await scheduler.acceptOperatorStop(stop)).toBe(true);
      const resolved = scheduler.getTask(task.taskId), { operatorStop, ...outcome } = resolved;
      expect(operatorStop.state).toBe('accepted'); expect(outcome).toEqual(terminal);
      const { toManagedTaskEvent, hasAcceptedUserStop } = await import('./contract.js');
      expect(hasAcceptedUserStop(resolved)).toBe(true);
      expect(toManagedTaskEvent(resolved, envelope).properties.task).toMatchObject({ agentRetryAvailable: false, userStoppedRecoveryAvailable: true });
      expect(await scheduler.withdrawOperatorStop(stop)).toBe(false);
      await expect(scheduler.acknowledgeResult(task.taskId, { action: 'continue', idempotencyKey: 'model-continue' }))
        .rejects.toMatchObject({ code: 'user_stopped_recovery_required' });
    } else {
      expect(await scheduler.withdrawOperatorStop(stop)).toBe(true);
      expect(scheduler.getTask(task.taskId)).toEqual(terminal);
      expect(await scheduler.acceptOperatorStop(stop)).toBe(false);
    }
    expect(scheduler.getResultEnvelope(task.taskId)).toEqual(envelope);
  } finally { await scheduler.shutdown(); }
});

test('restart expires a lost pending HTTP stop into explicit uncertain recovery without provider work', async () => {
  const h = await createTerminalHarness();
  const previous = h.scheduler.getTask(h.original.taskId);
  await h.scheduler.shutdown();
  const task = { ...previous, status: 'running', finishedAt: null, failureReason: null,
    operatorStop: { requestedAt: 2000, requestId: 'lost-response', leaseToken: previous.leaseToken, state: 'pending' } };
  const scheduler = createManagedTaskScheduler({ now: () => 8000, abortTimeoutMs: 5000,
    persistence: { async load() { return { version: 1, tasks: [task], resultEnvelopes: [] }; }, async save() {} },
    executor: { async start() { throw new Error('must not dispatch'); }, async reconcile() { return { state: 'transient' }; } },
  });
  try {
    await scheduler.initialize();
    const result = await scheduler.waitForTask(task.taskId, { timeoutMs: 1000 });
    expect(result).toMatchObject({ status: 'interrupted', operatorStop: { state: 'uncertain' },
      failureReason: 'Stop request outcome could not be confirmed' });
    expect(result.terminationIntent).toBeUndefined();
    const envelope = scheduler.getResultEnvelope(task.taskId);
    expect(envelope.resumable).toBe(true);
    const { toManagedTaskEvent } = await import('./contract.js');
    expect(toManagedTaskEvent(result, envelope).properties.task).toMatchObject({
      stoppedRecoveryAvailable: true, agentRetryAvailable: false,
    });
    expect(toManagedTaskEvent(result, envelope).properties.task.terminationIntent).toBeUndefined();
    await expect(scheduler.acknowledgeResult(task.taskId, { action: 'continue', idempotencyKey: 'model-continue' }))
      .rejects.toMatchObject({ code: 'user_stopped_recovery_required' });
    const response = await scheduler.acknowledgeResult(task.taskId, { action: 'abandon', idempotencyKey: 'user-dismiss', [USER_STOPPED_RECOVERY]: true });
    expect(response.envelope.action).toBe('abandon');
  } finally { await scheduler.shutdown(); }
});

for (const response of ['accepted', 'rejected']) test(`a late ${response} response fences an already queued expiry settlement`, async () => {
  const h = await createTerminalHarness();
  const previous = h.scheduler.getTask(h.original.taskId); await h.scheduler.shutdown();
  const stop = { sessionId: previous.childSessionId, taskId: previous.taskId, leaseToken: previous.leaseToken,
    requestedAt: 2000, requestId: 'racing-expiry' };
  const task = { ...previous, status: 'running', finishedAt: null, failureReason: null,
    operatorStop: { requestedAt: 2000, requestId: stop.requestId, leaseToken: previous.leaseToken, state: 'pending' } };
  let resolveUncertain, responsePromise, queued = false;
  const uncertain = new Promise(resolve => { resolveUncertain = resolve; });
  const scheduler = createManagedTaskScheduler({ now: () => 8000, abortTimeoutMs: 5000,
    persistence: {
      async load() { return { version: 1, tasks: [task], resultEnvelopes: [] }; },
      async save(state) {
        if (queued || state.tasks[0]?.operatorStop?.state !== 'uncertain') return;
        queued = true;
        responsePromise = response === 'accepted' ? scheduler.acceptOperatorStop(stop) : scheduler.withdrawOperatorStop(stop);
        resolveUncertain();
      },
    }, executor: { async start() { throw new Error('must not dispatch'); }, async reconcile() { return { state: 'transient' }; } },
  });
  try {
    await scheduler.initialize(); await uncertain;
    expect(await responsePromise).toBe(true); await scheduler.flush();
    const current = scheduler.getTask(task.taskId);
    expect(current.status).toBe('running'); expect(scheduler.getResultEnvelope(task.taskId)).toBeNull();
    if (response === 'accepted') expect(current.operatorStop.state).toBe('accepted');
    else expect(current.operatorStop).toBeUndefined();
  } finally { await scheduler.shutdown(); }
});


test('native capability refusal cannot enter model retry or automatic continuation', async () => {
  const { scheduler, original, starts, resumes, inPlaceRetries } = await createTerminalHarness({
    failureReason: 'admission.prompt: the native permission action for tool todoread is unavailable',
  });
  try {
    for (const action of ['retry', 'resume', 'retry_in_place', 'recover_in_place']) {
      await expect(scheduler.acknowledgeResult(original.taskId, { action, idempotencyKey: `capability-${action}`,
        providerId: 'openai', modelId: 'replacement', prompt: 'Retry the assignment',
      })).rejects.toMatchObject({ code: 'runtime_capability_repair_required' });
    }
    expect(starts).toHaveLength(1);
    expect(resumes).toHaveLength(0);
    expect(inPlaceRetries).toHaveLength(0);
    await scheduler.acknowledgeResult(original.taskId, { action: 'continue', idempotencyKey: 'capability-collected' });
  } finally { await scheduler.shutdown(); }
});
