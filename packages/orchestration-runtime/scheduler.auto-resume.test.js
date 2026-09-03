import { describe, expect, test } from 'bun:test';

import {
  AUTO_RESUME_HOST_RETRY_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  AUTO_RESUME_MAX_HOST_FAILURES,
  AUTO_RESUME_MAX_LINEAGE_MS,
  AUTO_RESUME_RESET_JITTER_MS,
} from './auto-resume-policy.js';
import { createManagedTaskRecord } from './contract.js';
import { createManagedTaskResultEnvelope } from './result-envelope.js';
import { createManagedTaskScheduler } from './scheduler.js';

const MINUTE = 60_000;
const START = 1_000_000;
const LIMIT = "You've hit your session limit · resets 7:30pm";
const BACKUP = { providerId: 'openai', modelId: 'gpt-5.6', variant: 'medium' };

const limited = (providerResetAt = null) => ({
  status: 'failed',
  failureReason: LIMIT,
  partial: true,
  recoverablePreview: 'partial work',
  canonicalRefs: [],
  resumable: true,
  providerResetAt,
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const createManualTimers = (readClock) => {
  const timers = new Map();
  let nextId = 0;
  return {
    timers,
    scheduleTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay, dueAt: readClock() + delay });
      return id;
    },
    cancelTimeout(id) {
      timers.delete(id);
    },
    fireDue() {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= readClock())
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0]);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      return due.length;
    },
    delays() {
      return [...timers.values()].map((timer) => timer.delay).sort((left, right) => left - right);
    },
  };
};

const input = (overrides = {}) => ({
  idempotencyKey: `original-${overrides.prompt ?? 'default'}`,
  rootSessionId: 'ses_root',
  dispatchGroupId: 'msg_parent',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'anthropic',
  modelId: 'claude-opus',
  agent: 'explorer',
  variant: 'high',
  label: 'Original task',
  prompt: 'Perform the original task.',
  timeoutAt: null,
  ...overrides,
});

const createHarness = ({
  backup = BACKUP,
  providerReset = null,
  attemptOutcome = null,
  startResult = limited(),
  retryResults = [],
  persistence,
  autoResumeOptions = {},
  schedulerOptions = {},
  executorOverrides = {},
} = {}) => {
  let clock = START;
  const timers = createManualTimers(() => clock);
  // Restart harnesses persist dvr_task_1..n; new ids must not collide with them.
  let taskCounter = persistence ? 10 : 0;
  let leaseCounter = persistence ? 10 : 0;
  const attempts = [];
  const inPlaceRetries = [];
  const hostAttempt = async (params) => {
    attempts.push(params);
    if (attemptOutcome) return await attemptOutcome(params, harness);
    const result = await scheduler.acknowledgeResult(params.taskId, {
      action: params.action,
      idempotencyKey: params.idempotencyKey,
      providerId: params.providerId,
      modelId: params.modelId,
      variant: params.variant,
      autoResumeGeneration: params.autoResumeGeneration,
    });
    return { outcome: 'started', followUpTaskId: result.followUpTask?.taskId ?? null };
  };
  const scheduler = createManagedTaskScheduler({
    executor: {
      async start(task, control) {
        await control.setChildSessionId(`ses_child_${task.taskId}`);
        await control.markAccepted();
        return typeof startResult === 'function' ? await startResult(task, control) : startResult;
      },
      async retryInPlace(task, control) {
        inPlaceRetries.push(task);
        await control.markAccepted();
        const next = retryResults.shift();
        if (typeof next === 'function') return await next(task, control);
        return next ?? { status: 'completed', recoverablePreview: 'done' };
      },
      async resume(task, control) {
        await control.markAccepted();
        return { status: 'completed', recoverablePreview: 'resumed' };
      },
      async abort() { return { aborted: true }; },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return {}; },
      ...executorOverrides,
    },
    ...(persistence ? { persistence } : {}),
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    now: () => clock,
    scheduleTimeout: timers.scheduleTimeout,
    cancelTimeout: timers.cancelTimeout,
    autoResume: {
      resolveOwnerKey: async () => 'owner-a',
      resolveBackupExecution: async () => backup,
      resolveProviderReset: async (query) => (
        typeof providerReset === 'function' ? providerReset(query) : providerReset
      ),
      attempt: hostAttempt,
      ...autoResumeOptions,
    },
    ...schedulerOptions,
  });
  const settle = async () => {
    for (let round = 0; round < 12; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await scheduler.flush();
  };
  const step = async () => {
    const fired = timers.fireDue();
    await settle();
    return fired;
  };
  const runDue = async () => {
    for (let round = 0; round < 12; round += 1) {
      if ((await step()) === 0) return;
    }
  };
  const advance = async (ms) => {
    clock += ms;
    await runDue();
  };
  const park = async (overrides = {}) => {
    const task = await scheduler.submit(input(overrides));
    await scheduler.waitForTask(task.taskId);
    await settle();
    return scheduler.getTask(task.taskId);
  };
  const state = (taskId) => scheduler.getResultEnvelope(taskId)?.autoResume ?? null;
  const harness = {
    scheduler,
    timers,
    attempts,
    inPlaceRetries,
    settle,
    step,
    runDue,
    advance,
    park,
    state,
    readClock: () => clock,
    setClock: (value) => { clock = value; },
  };
  return harness;
};

const record = (index, overrides = {}) => ({
  ...createManagedTaskRecord({
    taskId: `dvr_task_${index}`,
    idempotencyKey: `restart-${index}`,
    rootSessionId: 'ses_root',
    dispatchGroupId: 'msg_parent',
    parentTaskId: null,
    directory: '/workspace',
    sequence: index,
    mode: 'orchestrator',
    providerId: 'anthropic',
    modelId: 'claude-opus',
    agent: 'explorer',
    variant: 'high',
    label: `Restart ${index}`,
    prompt: `Restart task ${index}.`,
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: START - 10 * MINUTE + index,
    timeoutAt: null,
  }),
  status: 'failed',
  childSessionId: `ses_child_${index}`,
  leaseToken: `dvr_lease_${index}`,
  startedAt: START - 9 * MINUTE,
  finishedAt: START - 5 * MINUTE,
  failureReason: LIMIT,
  partial: true,
  recoverablePreview: 'partial work',
  ...overrides,
});

const persistedState = (overrides = {}) => ({
  revision: 3,
  enabled: true,
  state: 'planning',
  cancelGeneration: 0,
  lineageStartedAt: START - 5 * MINUTE,
  expiresAt: START - 5 * MINUTE + AUTO_RESUME_MAX_LINEAGE_MS,
  attemptCount: 0,
  noSignalProbes: 1,
  rejectionsInWindow: 1,
  windowResetAt: null,
  nextAttemptAt: null,
  resetAt: null,
  resetSource: null,
  target: null,
  lastAttemptTaskId: null,
  lastAttemptAt: null,
  lastError: null,
  hostFailures: 0,
  reason: null,
  ...overrides,
});

const snapshotPersistence = (snapshot) => ({
  async load() { return snapshot; },
  async save() {},
});

describe('managed scheduler auto-resume lifecycle', () => {
  test('parks a definite usage limit, plans, and tries the backup immediately', async () => {
    const gate = deferred();
    const harness = createHarness({ retryResults: [() => gate.promise] });
    const { scheduler } = harness;

    const original = await harness.park();
    const envelope = scheduler.getResultEnvelope(original.taskId);
    expect(envelope.providerResetAt).toBeNull();
    expect(envelope.autoResume).toMatchObject({
      revision: 1,
      enabled: true,
      state: 'planning',
      cancelGeneration: 0,
      attemptCount: 0,
      rejectionsInWindow: 1,
      noSignalProbes: 1,
      lineageStartedAt: START,
      expiresAt: START + AUTO_RESUME_MAX_LINEAGE_MS,
    });
    expect(harness.timers.delays()).toEqual([0]);

    await harness.step();
    expect(harness.state(original.taskId)).toMatchObject({
      revision: 2,
      state: 'scheduled',
      nextAttemptAt: START,
      target: { kind: 'backup', providerId: 'openai', modelId: 'gpt-5.6', variant: 'medium' },
    });
    // No reset is known yet, so no breaker is armed; the probe entry appears with the attempt.
    expect(scheduler.getDiagnostics()).toMatchObject({ pendingAutoResumeCount: 1, providerBreakerCount: 0 });

    await harness.step();
    expect(scheduler.getDiagnostics().providerBreakerCount).toBe(1);
    expect(harness.attempts).toEqual([{
      taskId: original.taskId,
      rootSessionId: 'ses_root',
      directory: '/workspace',
      action: 'retry_in_place',
      idempotencyKey: `auto-resume:${original.taskId}:0:1`,
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'medium',
      autoResumeGeneration: 0,
    }]);
    const acknowledged = scheduler.getResultEnvelope(original.taskId);
    expect(acknowledged).toMatchObject({ action: 'retry_in_place', followUpTaskId: 'dvr_task_2' });
    expect(acknowledged.autoResume).toMatchObject({
      state: 'attempting',
      attemptCount: 1,
      lastAttemptAt: START,
      lastAttemptTaskId: 'dvr_task_2',
    });
    expect(scheduler.getTask('dvr_task_2')).toMatchObject({
      executionKind: 'retry_in_place',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'medium',
      priorTaskId: original.taskId,
      recoveryLineageId: `dvr_lineage_${original.taskId.slice('dvr_task_'.length)}`,
      childSessionId: original.childSessionId,
    });

    gate.resolve({ status: 'completed', recoverablePreview: 'finished on the backup' });
    await scheduler.waitForTask('dvr_task_2');
    await harness.settle();
    expect(harness.state(original.taskId)).toMatchObject({ state: 'succeeded', lastAttemptTaskId: 'dvr_task_2' });
    expect(scheduler.getResultEnvelope('dvr_task_2').autoResume).toBeNull();
    expect(scheduler.getDiagnostics()).toMatchObject({ pendingAutoResumeCount: 0, providerBreakerCount: 0 });
    expect(harness.timers.timers.size).toBe(0);
  });

  test('waits for the provider reset on the original when there is no backup', async () => {
    const resetAt = START + 30 * MINUTE;
    const harness = createHarness({ backup: null, startResult: limited(resetAt) });
    const { scheduler } = harness;

    const original = await harness.park();
    expect(scheduler.getResultEnvelope(original.taskId).providerResetAt).toBe(resetAt);
    await harness.step();
    expect(harness.state(original.taskId)).toMatchObject({
      state: 'scheduled',
      nextAttemptAt: resetAt + AUTO_RESUME_RESET_JITTER_MS,
      resetAt,
      resetSource: 'opencode_status',
      target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
    });
    expect(harness.timers.delays()).toEqual([30 * MINUTE + AUTO_RESUME_RESET_JITTER_MS]);

    await harness.advance(29 * MINUTE);
    expect(harness.attempts).toHaveLength(0);
    await harness.advance(MINUTE + AUTO_RESUME_RESET_JITTER_MS);
    expect(harness.attempts).toHaveLength(1);
    expect(harness.attempts[0]).toMatchObject({ providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' });
    expect(harness.state(original.taskId)).toMatchObject({ state: 'succeeded' });
  });

  test('backs off 15/30/60/60 minutes across a lineage without reset signals', async () => {
    const harness = createHarness({
      backup: null,
      retryResults: [limited(), limited(), limited(), limited()],
    });
    const { scheduler } = harness;
    const original = await harness.park();
    await harness.step();

    const delays = [];
    let current = original.taskId;
    for (let round = 0; round < 4; round += 1) {
      const scheduled = harness.state(current);
      expect(scheduled.state).toBe('scheduled');
      delays.push(scheduled.nextAttemptAt - harness.readClock());
      expect(scheduled.resetSource).toBe('backoff');
      await harness.advance(scheduled.nextAttemptAt - harness.readClock());
      const followUpTaskId = scheduler.getResultEnvelope(current).followUpTaskId;
      expect(followUpTaskId).not.toBeNull();
      expect(harness.state(current)).toMatchObject({ state: 'superseded', lastAttemptTaskId: followUpTaskId });
      current = followUpTaskId;
    }
    expect(delays).toEqual([15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 60 * MINUTE]);
    expect(harness.state(current)).toMatchObject({
      attemptCount: 4,
      noSignalProbes: 5,
      cancelGeneration: 0,
      lineageStartedAt: START,
      expiresAt: START + AUTO_RESUME_MAX_LINEAGE_MS,
    });
    expect(scheduler.getTask(current)).toMatchObject({
      attempt: 5,
      recoveryLineageId: 'dvr_lineage_1',
    });
  });

  test('exhausts the lineage at eight attempts and at the six-hour budget', async () => {
    const harness = createHarness({
      backup: null,
      startResult: (task, control) => limited(harness.readClock() + MINUTE),
      retryResults: Array.from({ length: AUTO_RESUME_MAX_ATTEMPTS }, () => (
        () => limited(harness.readClock() + MINUTE)
      )),
    });
    let current = (await harness.park()).taskId;
    for (let round = 0; round < AUTO_RESUME_MAX_ATTEMPTS; round += 1) {
      await harness.runDue();
      await harness.advance(MINUTE + AUTO_RESUME_RESET_JITTER_MS);
      current = harness.scheduler.getResultEnvelope(current).followUpTaskId;
      expect(current).not.toBeNull();
    }
    await harness.runDue();
    expect(harness.state(current)).toMatchObject({
      state: 'exhausted',
      reason: 'attempt_cap',
      attemptCount: AUTO_RESUME_MAX_ATTEMPTS,
    });
    expect(harness.attempts).toHaveLength(AUTO_RESUME_MAX_ATTEMPTS);

    const late = createHarness({ backup: null, startResult: limited(START + 7 * 60 * MINUTE) });
    const parked = await late.park();
    await late.step();
    expect(late.state(parked.taskId)).toMatchObject({ state: 'exhausted', reason: 'time_cap' });
    expect(late.timers.timers.size).toBe(0);
    expect(late.scheduler.getDiagnostics().pendingAutoResumeCount).toBe(0);
  });

  test('after two rejections in one window it waits for the original reset instead of probing again', async () => {
    const resetAt = START + 30 * MINUTE;
    const harness = createHarness({
      startResult: limited(resetAt),
      retryResults: [limited(START + 2 * 60 * MINUTE)],
    });
    const { scheduler } = harness;
    const original = await harness.park();
    await harness.runDue();

    const followUpTaskId = scheduler.getResultEnvelope(original.taskId).followUpTaskId;
    expect(scheduler.getTask(followUpTaskId)).toMatchObject({ providerId: 'openai', status: 'failed' });
    expect(harness.state(original.taskId)).toMatchObject({ state: 'superseded' });
    expect(harness.state(followUpTaskId)).toMatchObject({
      state: 'scheduled',
      rejectionsInWindow: 2,
      windowResetAt: resetAt,
      resetAt,
      nextAttemptAt: resetAt + AUTO_RESUME_RESET_JITTER_MS,
      target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
    });
    expect(scheduler.getDiagnostics().providerBreakerCount).toBe(2);
  });

  test('a provider breaker parks a second task on the same provider and staggers probes', async () => {
    const gate = deferred();
    const resetAt = START + 30 * MINUTE;
    const harness = createHarness({
      backup: null,
      startResult: (task) => (task.prompt.includes('first') ? limited(resetAt) : limited()),
      retryResults: [() => gate.promise, { status: 'completed' }],
      autoResumeOptions: { probeStaggerMs: 60_000 },
    });
    const { scheduler } = harness;

    const first = await harness.park({ prompt: 'first task', idempotencyKey: 'first' });
    await harness.step();
    const second = await harness.park({ prompt: 'second task', idempotencyKey: 'second' });
    await harness.step();
    expect(harness.state(first.taskId)).toMatchObject({ nextAttemptAt: resetAt + AUTO_RESUME_RESET_JITTER_MS });
    // No reset hint of its own, yet it inherits the breaker instead of a blind backoff.
    expect(harness.state(second.taskId)).toMatchObject({
      state: 'scheduled',
      nextAttemptAt: resetAt + AUTO_RESUME_RESET_JITTER_MS,
      resetAt,
      resetSource: 'opencode_status',
    });

    await harness.advance(30 * MINUTE + AUTO_RESUME_RESET_JITTER_MS);
    expect(harness.attempts).toHaveLength(1);
    expect(harness.attempts[0].taskId).toBe(first.taskId);
    expect(harness.state(first.taskId)).toMatchObject({ state: 'attempting', attemptCount: 1 });
    expect(harness.state(second.taskId)).toMatchObject({
      state: 'scheduled',
      attemptCount: 0,
      nextAttemptAt: harness.readClock() + 60_000,
    });

    gate.resolve({ status: 'completed', recoverablePreview: 'probe succeeded' });
    await scheduler.waitForTask(scheduler.getResultEnvelope(first.taskId).followUpTaskId);
    await harness.settle();
    expect(harness.state(first.taskId)).toMatchObject({ state: 'succeeded' });
    expect(scheduler.getDiagnostics().providerBreakerCount).toBe(0);

    await harness.advance(60_000);
    expect(harness.attempts).toHaveLength(2);
    expect(harness.attempts[1].taskId).toBe(second.taskId);
    expect(harness.state(second.taskId)).toMatchObject({ state: 'succeeded' });
  });

  test('assistant output clears the breaker even when the attempt later fails for another reason', async () => {
    const harness = createHarness({
      backup: null,
      startResult: limited(START + 10 * MINUTE),
      retryResults: [async (task, control) => {
        await control.recordProgress({ childPromptedAt: harness.readClock() });
        await control.recordProgress({ firstAssistantPartAt: harness.readClock() + 1 });
        return { status: 'failed', failureReason: 'provider disconnected', partial: true, resumable: true };
      }],
    });
    const { scheduler } = harness;
    const original = await harness.park();
    await harness.step();
    expect(scheduler.getDiagnostics().providerBreakerCount).toBe(1);
    await harness.advance(10 * MINUTE + AUTO_RESUME_RESET_JITTER_MS);

    const followUpTaskId = scheduler.getResultEnvelope(original.taskId).followUpTaskId;
    expect(scheduler.getTask(followUpTaskId)).toMatchObject({
      status: 'failed',
      childPromptedAt: START + 10 * MINUTE + AUTO_RESUME_RESET_JITTER_MS,
      firstAssistantPartAt: START + 10 * MINUTE + AUTO_RESUME_RESET_JITTER_MS + 1,
    });
    expect(harness.state(original.taskId)).toMatchObject({ state: 'ended' });
    expect(scheduler.getResultEnvelope(followUpTaskId).autoResume).toBeNull();
    expect(scheduler.getDiagnostics().providerBreakerCount).toBe(0);
  });
});

describe('managed scheduler auto-resume controls', () => {
  test('toggling off cancels the pending attempt and bumps the generation; toggling on re-plans', async () => {
    const harness = createHarness({ backup: null, startResult: limited(START + 30 * MINUTE) });
    const { scheduler } = harness;
    const original = await harness.park();
    await harness.step();
    expect(harness.timers.timers.size).toBe(1);

    const disabled = await scheduler.setResultAutoResume(original.taskId, { enabled: false });
    expect(disabled.envelope.autoResume).toMatchObject({
      enabled: false,
      state: 'cancelled',
      reason: 'user',
      cancelGeneration: 1,
      nextAttemptAt: null,
      revision: 3,
    });
    expect(harness.timers.timers.size).toBe(0);
    await expect(scheduler.setResultAutoResume(original.taskId, { enabled: false }))
      .resolves.toMatchObject({ envelope: { autoResume: { revision: 3 } } });
    await harness.advance(60 * MINUTE);
    expect(harness.attempts).toHaveLength(0);

    const enabled = await scheduler.setResultAutoResume(original.taskId, { enabled: true });
    expect(enabled.envelope.autoResume).toMatchObject({
      enabled: true,
      state: 'planning',
      cancelGeneration: 2,
      reason: null,
      revision: 4,
    });
    await harness.runDue();
    // The original reset hint is an hour stale, so the re-plan falls back to the
    // no-signal ladder instead of firing immediately.
    expect(harness.state(original.taskId)).toMatchObject({
      state: 'scheduled',
      resetSource: 'backoff',
      nextAttemptAt: harness.readClock() + 15 * MINUTE,
    });
    await harness.advance(15 * MINUTE);
    expect(harness.attempts).toHaveLength(1);
    expect(harness.attempts[0]).toMatchObject({
      idempotencyKey: `auto-resume:${original.taskId}:2:1`,
      autoResumeGeneration: 2,
    });
    expect(harness.state(original.taskId)).toMatchObject({ state: 'succeeded' });
    await expect(scheduler.setResultAutoResume(original.taskId, { enabled: false }))
      .rejects.toMatchObject({ code: 'result_already_acknowledged' });
  });

  test('re-enabling past the lineage budget exhausts on the time cap', async () => {
    const harness = createHarness({ backup: null });
    const { scheduler } = harness;
    const original = await harness.park();
    await scheduler.setResultAutoResume(original.taskId, { enabled: false });
    harness.setClock(START + AUTO_RESUME_MAX_LINEAGE_MS + 1);
    const enabled = await scheduler.setResultAutoResume(original.taskId, { enabled: true });
    expect(enabled.envelope.autoResume).toMatchObject({ state: 'exhausted', reason: 'time_cap', enabled: true });
    expect(harness.timers.timers.size).toBe(0);
  });

  test('refuses auto-resume for results that are not parked provider limits', async () => {
    const harness = createHarness({
      startResult: { status: 'failed', failureReason: 'provider disconnected', partial: true, resumable: true },
    });
    const original = await harness.park();
    expect(harness.scheduler.getResultEnvelope(original.taskId).autoResume).toBeNull();
    await expect(harness.scheduler.setResultAutoResume(original.taskId, { enabled: true }))
      .rejects.toMatchObject({ code: 'auto_resume_not_applicable' });
    await expect(harness.scheduler.setResultAutoResume('dvr_task_missing', { enabled: true }))
      .rejects.toMatchObject({ code: 'result_not_found' });
  });

  test('rejects an attempt whose generation is stale', async () => {
    const harness = createHarness({
      backup: null,
      attemptOutcome: async (params, { scheduler }) => {
        await scheduler.setResultAutoResume(params.taskId, { enabled: false });
        await expect(scheduler.acknowledgeResult(params.taskId, {
          action: 'retry_in_place',
          idempotencyKey: params.idempotencyKey,
          providerId: params.providerId,
          modelId: params.modelId,
          variant: params.variant,
          autoResumeGeneration: params.autoResumeGeneration,
        })).rejects.toMatchObject({ code: 'auto_resume_stale' });
        return { outcome: 'rejected', code: 'stale', message: 'stale generation' };
      },
    });
    const original = await harness.park();
    await harness.runDue();
    await harness.advance(15 * MINUTE);
    expect(harness.attempts).toHaveLength(1);
    expect(harness.scheduler.getResultEnvelope(original.taskId)).toMatchObject({ action: null });
    expect(harness.state(original.taskId)).toMatchObject({
      state: 'cancelled',
      cancelGeneration: 1,
      hostFailures: 0,
    });
    expect(harness.scheduler.listTasks()).toHaveLength(1);
    await expect(harness.scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'wrong-generation',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: null,
      autoResumeGeneration: 7,
    })).rejects.toMatchObject({ code: 'auto_resume_stale' });
  });

  test('deferred and rejected attempts are re-armed without spending the attempt budget', async () => {
    const outcomes = [
      { outcome: 'deferred', retryAfterMs: 5_000, reason: 'browser lease held' },
      { outcome: 'rejected', code: 'host_busy', message: 'gateway unavailable' },
      new Error('attempt hook crashed'),
    ];
    const harness = createHarness({
      backup: null,
      attemptOutcome: async () => {
        const next = outcomes.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    const original = await harness.park();
    await harness.runDue();
    await harness.advance(15 * MINUTE);
    expect(harness.attempts).toHaveLength(1);
    expect(harness.state(original.taskId)).toMatchObject({
      state: 'scheduled',
      attemptCount: 0,
      hostFailures: 0,
      nextAttemptAt: harness.readClock() + 5_000,
    });

    await harness.advance(5_000);
    expect(harness.attempts).toHaveLength(2);
    expect(harness.state(original.taskId)).toMatchObject({
      state: 'scheduled',
      attemptCount: 0,
      hostFailures: 1,
      lastError: { code: 'host_busy', message: 'gateway unavailable', at: harness.readClock() },
      nextAttemptAt: harness.readClock() + AUTO_RESUME_HOST_RETRY_MS,
    });

    await harness.advance(AUTO_RESUME_HOST_RETRY_MS);
    expect(harness.attempts).toHaveLength(3);
    expect(harness.state(original.taskId)).toMatchObject({
      state: 'scheduled',
      attemptCount: 0,
      hostFailures: 2,
      lastError: { code: 'attempt_failed', message: 'attempt hook crashed' },
    });
    expect(harness.scheduler.getResultEnvelope(original.taskId).action).toBeNull();
    expect(harness.scheduler.getDiagnostics().providerBreakerCount).toBe(0);
  });

  test('exhausts after repeated host failures', async () => {
    const harness = createHarness({
      backup: null,
      attemptOutcome: async () => ({ outcome: 'rejected', code: 'host_busy', message: 'no' }),
    });
    const original = await harness.park();
    await harness.runDue();
    await harness.advance(15 * MINUTE);
    for (let round = 1; round < AUTO_RESUME_MAX_HOST_FAILURES; round += 1) {
      await harness.advance(AUTO_RESUME_HOST_RETRY_MS);
    }
    expect(harness.attempts).toHaveLength(AUTO_RESUME_MAX_HOST_FAILURES);
    expect(harness.state(original.taskId)).toMatchObject({
      state: 'exhausted',
      reason: 'host_failures',
      hostFailures: AUTO_RESUME_MAX_HOST_FAILURES,
      attemptCount: 0,
    });
    expect(harness.timers.timers.size).toBe(0);
  });

  test('a concurrent human retry collapses onto one follow-up and voids the automatic generation', async () => {
    const harness = createHarness({
      backup: null,
      attemptOutcome: async (params, { scheduler }) => {
        const manual = scheduler.acknowledgeResult(params.taskId, {
          action: 'retry_in_place',
          idempotencyKey: 'human-retry',
          providerId: 'openai',
          modelId: 'gpt-5.6',
          variant: 'high',
        });
        const automatic = scheduler.acknowledgeResult(params.taskId, {
          action: params.action,
          idempotencyKey: params.idempotencyKey,
          providerId: params.providerId,
          modelId: params.modelId,
          variant: params.variant,
          autoResumeGeneration: params.autoResumeGeneration,
        }).catch((error) => error);
        const [human, auto] = await Promise.all([manual, automatic]);
        if (!(auto instanceof Error)) expect(auto.followUpTask.taskId).toBe(human.followUpTask.taskId);
        return { outcome: 'started', followUpTaskId: human.followUpTask.taskId };
      },
    });
    const original = await harness.park();
    await harness.runDue();
    await harness.advance(15 * MINUTE);

    expect(harness.scheduler.listTasks()).toHaveLength(2);
    const envelope = harness.scheduler.getResultEnvelope(original.taskId);
    expect(envelope).toMatchObject({ action: 'retry_in_place', followUpTaskId: 'dvr_task_2' });
    expect(envelope.autoResume).toMatchObject({
      state: 'acknowledged',
      reason: 'manual_retry',
      cancelGeneration: 1,
    });
    expect(harness.scheduler.getTask('dvr_task_2')).toMatchObject({
      providerId: 'openai',
      variant: 'high',
      recoveryLineageId: 'dvr_lineage_1',
    });
  });

  test('a manual retry records the acknowledged state and restarts the budget for the next park', async () => {
    const harness = createHarness({ backup: null, retryResults: [limited()] });
    const { scheduler } = harness;
    const original = await harness.park();
    await harness.step();
    const manual = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'human-retry',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: 'high',
    });
    expect(manual.envelope.autoResume).toMatchObject({
      state: 'acknowledged',
      reason: 'manual_retry',
      cancelGeneration: 1,
      attemptCount: 0,
    });
    expect(harness.timers.timers.size).toBe(0);
    await scheduler.waitForTask(manual.followUpTask.taskId);
    await harness.settle();
    expect(harness.state(manual.followUpTask.taskId)).toMatchObject({
      state: 'planning',
      cancelGeneration: 0,
      attemptCount: 0,
      noSignalProbes: 1,
      lineageStartedAt: harness.readClock(),
    });
    await harness.step();
    // The manual choice is the new lineage origin.
    expect(harness.state(manual.followUpTask.taskId).target).toEqual({
      kind: 'original', providerId: 'openai', modelId: 'gpt-5.6', variant: 'high',
    });
  });

  test('cancelling a parked task and deleting its session switch auto-resume off', async () => {
    const harness = createHarness({ backup: null });
    const { scheduler } = harness;
    const first = await harness.park({ prompt: 'first', idempotencyKey: 'first' });
    const second = await harness.park({ prompt: 'second', idempotencyKey: 'second' });
    await harness.step();

    const cancelled = await scheduler.cancelTask(first.taskId);
    expect(cancelled.status).toBe('failed');
    expect(harness.state(first.taskId)).toMatchObject({ state: 'cancelled', reason: 'cancelled', cancelGeneration: 1 });

    await expect(scheduler.cancelAutoResumeForSession('ses_root', 'bogus'))
      .rejects.toMatchObject({ code: 'invalid_auto_resume_reason' });
    await expect(scheduler.cancelAutoResumeForSession(second.childSessionId, 'session_deleted'))
      .resolves.toEqual({ cancelledTaskIds: [second.taskId] });
    expect(harness.state(second.taskId)).toMatchObject({ state: 'cancelled', reason: 'session_deleted' });
    await expect(scheduler.cancelAutoResumeForSession('ses_root', 'cancelled'))
      .resolves.toEqual({ cancelledTaskIds: [] });
    expect(harness.timers.timers.size).toBe(0);
    await harness.advance(60 * MINUTE);
    expect(harness.attempts).toHaveLength(0);
  });
});

describe('managed scheduler auto-resume restart re-arm', () => {
  const parkedSnapshot = (autoResume, extraTasks = []) => {
    const task = record(1);
    const envelope = {
      ...createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: task.finishedAt, resumable: true }),
      autoResume,
    };
    return { version: 1, tasks: [task, ...extraTasks], resultEnvelopes: [envelope] };
  };

  test('re-plans a planning state after the startup grace', async () => {
    const harness = createHarness({
      backup: null,
      persistence: snapshotPersistence(parkedSnapshot(persistedState())),
      autoResumeOptions: { startupGraceMs: 15_000 },
    });
    await harness.scheduler.initialize();
    expect(harness.timers.delays()).toEqual([15_000]);
    await harness.advance(15_000);
    expect(harness.state('dvr_task_1')).toMatchObject({ state: 'scheduled', revision: 4 });
    expect(harness.scheduler.getDiagnostics().providerBreakerCount).toBe(0);
  });

  test('re-arms a far scheduled attempt as-is and re-plans one due inside the grace', async () => {
    const far = createHarness({
      backup: null,
      persistence: snapshotPersistence(parkedSnapshot(persistedState({
        state: 'scheduled',
        nextAttemptAt: START + 30 * MINUTE,
        resetAt: START + 30 * MINUTE - AUTO_RESUME_RESET_JITTER_MS,
        resetSource: 'opencode_status',
        target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
      }))),
    });
    await far.scheduler.initialize();
    expect(far.timers.delays()).toEqual([30 * MINUTE]);
    expect(far.state('dvr_task_1')).toMatchObject({ state: 'scheduled', revision: 3 });
    expect(far.scheduler.getDiagnostics().providerBreakerCount).toBe(1);
    await far.advance(30 * MINUTE);
    expect(far.attempts).toHaveLength(1);
    expect(far.state('dvr_task_1')).toMatchObject({ state: 'succeeded' });

    const near = createHarness({
      backup: null,
      persistence: snapshotPersistence(parkedSnapshot(persistedState({
        state: 'scheduled',
        nextAttemptAt: START + 5_000,
        target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
      }))),
      autoResumeOptions: { startupGraceMs: 15_000 },
    });
    await near.scheduler.initialize();
    expect(near.timers.delays()).toEqual([15_000]);
    await near.advance(5_000);
    expect(near.attempts).toHaveLength(0);
    await near.advance(10_000);
    expect(near.state('dvr_task_1')).toMatchObject({ state: 'scheduled', revision: 4 });
  });

  test('reverts an attempting state without a follow-up to planning', async () => {
    const harness = createHarness({
      backup: null,
      persistence: snapshotPersistence(parkedSnapshot(persistedState({
        state: 'attempting',
        attemptCount: 2,
        lastAttemptAt: START - MINUTE,
        target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
      }))),
      autoResumeOptions: { startupGraceMs: 15_000 },
    });
    await harness.scheduler.initialize();
    expect(harness.state('dvr_task_1')).toMatchObject({ state: 'planning', attemptCount: 1, revision: 4 });
    expect(harness.timers.delays()).toEqual([15_000]);
    await harness.advance(15_000);
    expect(harness.state('dvr_task_1')).toMatchObject({ state: 'scheduled' });
  });

  test('heals an attempting state whose follow-up already exists', async () => {
    const attempting = persistedState({
      state: 'attempting',
      attemptCount: 1,
      lastAttemptAt: START - MINUTE,
      target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
    });
    const followUp = (overrides) => record(2, {
      idempotencyKey: 'auto-resume:dvr_task_1:0:1',
      attempt: 2,
      priorTaskId: 'dvr_task_1',
      executionKind: 'retry_in_place',
      recoveryLineageId: 'dvr_lineage_1',
      ...overrides,
    });

    const settled = createHarness({
      backup: null,
      persistence: snapshotPersistence(parkedSnapshot(attempting, [followUp({
        status: 'completed',
        failureReason: null,
        partial: false,
      })])),
    });
    await settled.scheduler.initialize();
    expect(settled.scheduler.getResultEnvelope('dvr_task_1')).toMatchObject({
      action: 'retry_in_place',
      followUpTaskId: 'dvr_task_2',
      autoResume: { state: 'succeeded', lastAttemptTaskId: 'dvr_task_2' },
    });
    expect(settled.timers.timers.size).toBe(0);
    expect(settled.attempts).toHaveLength(0);

    const live = createHarness({
      backup: null,
      persistence: snapshotPersistence(parkedSnapshot(attempting, [followUp({
        status: 'running',
        finishedAt: null,
        failureReason: null,
        partial: false,
        recoverablePreview: '',
      })])),
      executorOverrides: {
        async reconcile() {
          return { state: 'terminal', result: { status: 'completed', recoverablePreview: 'finished while down' } };
        },
      },
    });
    await live.scheduler.initialize();
    await live.settle();
    expect(live.scheduler.getTask('dvr_task_2').status).toBe('completed');
    expect(live.scheduler.getResultEnvelope('dvr_task_1')).toMatchObject({
      action: 'retry_in_place',
      followUpTaskId: 'dvr_task_2',
      autoResume: { state: 'succeeded', lastAttemptTaskId: 'dvr_task_2' },
    });
    expect(live.attempts).toHaveLength(0);
  });

  test('never fires for pre-upgrade envelopes and stays inert without an attempt hook', async () => {
    const legacy = createHarness({
      backup: null,
      persistence: snapshotPersistence(parkedSnapshot(null)),
    });
    await legacy.scheduler.initialize();
    expect(legacy.timers.timers.size).toBe(0);
    expect(legacy.scheduler.getResultEnvelope('dvr_task_1').autoResume).toBeNull();
    await legacy.advance(60 * MINUTE);
    expect(legacy.attempts).toHaveLength(0);
    expect(legacy.scheduler.getDiagnostics()).toMatchObject({ pendingAutoResumeCount: 0, providerBreakerCount: 0 });

    const inert = createHarness({
      backup: null,
      autoResumeOptions: { attempt: undefined },
    });
    const original = await inert.park();
    expect(inert.scheduler.getResultEnvelope(original.taskId)).toMatchObject({ providerResetAt: null, autoResume: null });
    expect(inert.timers.timers.size).toBe(0);
    await expect(inert.scheduler.setResultAutoResume(original.taskId, { enabled: true }))
      .rejects.toMatchObject({ code: 'auto_resume_not_applicable' });
  });
});
