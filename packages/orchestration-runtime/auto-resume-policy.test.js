import { describe, expect, test } from 'bun:test';

import {
  AUTO_RESUME_BACKOFF_MS,
  AUTO_RESUME_HOST_RETRY_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  AUTO_RESUME_MAX_HOST_FAILURES,
  AUTO_RESUME_MAX_LINEAGE_MS,
  AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW,
  AUTO_RESUME_MIN_DELAY_MS,
  AUTO_RESUME_RESET_JITTER_MS,
  buildAutoResumeAcknowledgeParams,
  createLineageId,
  initialAutoResumeState,
  isAutoResumeActive,
  isAutoResumeEligible,
  planAutoResumeAttempt,
  recordProviderRejection,
} from './auto-resume-policy.js';
import { createManagedTaskRecord } from './contract.js';
import { createManagedTaskResultEnvelope } from './result-envelope.js';

const MINUTE = 60 * 1_000;
const NOW = 1_000_000;

const parkedTask = (overrides = {}) => ({
  ...createManagedTaskRecord({
    taskId: 'dvr_task_parked',
    idempotencyKey: 'parked',
    rootSessionId: 'ses_root',
    dispatchGroupId: 'msg_parent',
    parentTaskId: null,
    directory: '/workspace',
    sequence: 1,
    mode: 'orchestrator',
    providerId: 'anthropic',
    modelId: 'claude-opus',
    agent: 'explorer',
    variant: 'high',
    label: 'Parked',
    prompt: 'Do the work.',
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: NOW - MINUTE,
    timeoutAt: null,
  }),
  status: 'failed',
  childSessionId: 'ses_child',
  leaseToken: 'dvr_lease_1',
  startedAt: NOW - MINUTE,
  finishedAt: NOW,
  failureReason: "You've hit your session limit · resets 7:30pm",
  partial: true,
  recoverablePreview: 'partial',
  ...overrides,
});

const parkedEnvelope = (task, overrides = {}) => ({
  ...createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: NOW, resumable: true }),
  ...overrides,
});

const freshState = (overrides = {}) => ({
  ...initialAutoResumeState({ now: NOW, enabled: true, providerResetAt: null }),
  ...overrides,
});

describe('auto-resume policy constants and identities', () => {
  test('exports the approved budget', () => {
    expect(AUTO_RESUME_MAX_ATTEMPTS).toBe(8);
    expect(AUTO_RESUME_MAX_LINEAGE_MS).toBe(6 * 60 * MINUTE);
    expect(AUTO_RESUME_BACKOFF_MS).toEqual([15 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
    expect(AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW).toBe(2);
    expect(AUTO_RESUME_MAX_HOST_FAILURES).toBe(5);
    expect(AUTO_RESUME_RESET_JITTER_MS).toBe(15_000);
    expect(AUTO_RESUME_MIN_DELAY_MS).toBe(5_000);
    expect(AUTO_RESUME_HOST_RETRY_MS).toBe(60_000);
  });

  test('derives one lineage id from the root task id', () => {
    expect(createLineageId('dvr_task_abc123')).toBe('dvr_lineage_abc123');
    expect(() => createLineageId('ses_root')).toThrow('rootTaskId must be a managed task id');
  });

  test('eligibility requires an unacknowledged definite usage limit that needs manual recovery', () => {
    const task = parkedTask();
    expect(isAutoResumeEligible(task, parkedEnvelope(task))).toBe(true);
    expect(isAutoResumeEligible(task, parkedEnvelope(task, { action: 'retry_in_place' }))).toBe(false);
    expect(isAutoResumeEligible(task, parkedEnvelope(task, { resumable: false }))).toBe(false);
    const disconnected = parkedTask({ failureReason: 'provider disconnected' });
    expect(isAutoResumeEligible(disconnected, parkedEnvelope(disconnected))).toBe(false);
    const retired = parkedTask({ failureReason: 'Model not found: opencode/retired' });
    expect(isAutoResumeEligible(retired, parkedEnvelope(retired))).toBe(false);
    expect(isAutoResumeEligible(task, null)).toBe(false);
  });

  test('active means enabled and still planning, scheduled, or attempting', () => {
    for (const state of ['planning', 'scheduled', 'attempting']) {
      expect(isAutoResumeActive({ autoResume: freshState({ state }) })).toBe(true);
      expect(isAutoResumeActive({ autoResume: freshState({ state, enabled: false }) })).toBe(false);
    }
    for (const state of ['superseded', 'succeeded', 'ended', 'cancelled', 'exhausted', 'acknowledged']) {
      expect(isAutoResumeActive({ autoResume: freshState({ state }) })).toBe(false);
    }
    expect(isAutoResumeActive({ autoResume: null })).toBe(false);
    expect(isAutoResumeActive(null)).toBe(false);
  });
});

describe('auto-resume state bookkeeping', () => {
  test('starts a fresh budget and records a future reset hint from OpenCode status', () => {
    expect(initialAutoResumeState({ now: NOW, enabled: true, providerResetAt: NOW + MINUTE })).toEqual({
      revision: 1,
      enabled: true,
      state: 'planning',
      cancelGeneration: 0,
      lineageStartedAt: NOW,
      expiresAt: NOW + AUTO_RESUME_MAX_LINEAGE_MS,
      attemptCount: 0,
      noSignalProbes: 0,
      rejectionsInWindow: 0,
      windowResetAt: null,
      nextAttemptAt: null,
      resetAt: NOW + MINUTE,
      resetSource: 'opencode_status',
      target: null,
      lastAttemptTaskId: null,
      lastAttemptAt: null,
      lastError: null,
      hostFailures: 0,
      reason: null,
    });
    expect(initialAutoResumeState({ now: NOW, enabled: false, providerResetAt: NOW - 1 })).toMatchObject({
      enabled: false,
      resetAt: null,
      resetSource: null,
    });
  });

  test('inherits the budget only from the attempting prior that produced this task', () => {
    const prior = freshState({
      state: 'attempting',
      cancelGeneration: 2,
      lineageStartedAt: NOW - 2 * MINUTE,
      expiresAt: NOW + MINUTE,
      attemptCount: 3,
      noSignalProbes: 2,
      rejectionsInWindow: 1,
      windowResetAt: NOW + 10 * MINUTE,
      resetAt: NOW + 10 * MINUTE,
      resetSource: 'meridian_quota',
      lastAttemptTaskId: 'dvr_task_follow',
      lastAttemptAt: NOW - MINUTE,
      hostFailures: 1,
    });
    const inherited = initialAutoResumeState({
      now: NOW,
      enabled: true,
      providerResetAt: null,
      prior,
      taskId: 'dvr_task_follow',
    });
    expect(inherited).toMatchObject({
      state: 'planning',
      cancelGeneration: 2,
      lineageStartedAt: NOW - 2 * MINUTE,
      expiresAt: NOW + MINUTE,
      attemptCount: 3,
      noSignalProbes: 2,
      rejectionsInWindow: 1,
      windowResetAt: NOW + 10 * MINUTE,
      resetAt: NOW + 10 * MINUTE,
      resetSource: 'meridian_quota',
      lastAttemptTaskId: 'dvr_task_follow',
      hostFailures: 1,
      revision: 1,
    });
    expect(initialAutoResumeState({
      now: NOW, enabled: true, providerResetAt: null, prior, taskId: 'dvr_task_other',
    })).toMatchObject({ cancelGeneration: 0, attemptCount: 0, expiresAt: NOW + AUTO_RESUME_MAX_LINEAGE_MS });
    expect(initialAutoResumeState({
      now: NOW,
      enabled: true,
      providerResetAt: null,
      prior: { ...prior, state: 'acknowledged', reason: 'manual_retry' },
      taskId: 'dvr_task_follow',
    })).toMatchObject({ cancelGeneration: 0, attemptCount: 0, hostFailures: 0 });
  });

  test('counts rejections per reset window and no-signal probes for the backoff ladder', () => {
    const first = recordProviderRejection(freshState(), { now: NOW, providerResetAt: NOW + 30 * MINUTE });
    expect(first).toMatchObject({
      rejectionsInWindow: 1,
      windowResetAt: NOW + 30 * MINUTE,
      noSignalProbes: 0,
      resetAt: NOW + 30 * MINUTE,
      resetSource: 'opencode_status',
    });
    const second = recordProviderRejection(first, { now: NOW + MINUTE, providerResetAt: null });
    expect(second).toMatchObject({
      rejectionsInWindow: 2,
      windowResetAt: NOW + 30 * MINUTE,
      noSignalProbes: 1,
      resetAt: NOW + 30 * MINUTE,
    });
    const afterWindow = recordProviderRejection(second, {
      now: NOW + 31 * MINUTE,
      providerResetAt: NOW + 60 * MINUTE,
    });
    expect(afterWindow).toMatchObject({
      rejectionsInWindow: 1,
      windowResetAt: NOW + 60 * MINUTE,
      noSignalProbes: 1,
      resetAt: NOW + 60 * MINUTE,
    });
    const sameReportedReset = recordProviderRejection(afterWindow, {
      now: NOW + 61 * MINUTE,
      providerResetAt: NOW + 60 * MINUTE,
    });
    expect(sameReportedReset).toMatchObject({ rejectionsInWindow: 2, noSignalProbes: 2, resetAt: null });
    expect(recordProviderRejection(freshState(), { now: NOW, providerResetAt: null })).toMatchObject({
      rejectionsInWindow: 1,
      windowResetAt: null,
      noSignalProbes: 1,
      resetAt: null,
      resetSource: null,
    });
  });
});

describe('auto-resume attempt planning', () => {
  const task = parkedTask();
  const backup = { providerId: 'openai', modelId: 'gpt-5.6', variant: 'medium' };

  test('exhausts on the attempt and time caps before anything else', () => {
    expect(planAutoResumeAttempt({
      now: NOW, task, state: freshState({ attemptCount: AUTO_RESUME_MAX_ATTEMPTS }), backup,
    })).toEqual({ state: 'exhausted', reason: 'attempt_cap' });
    expect(planAutoResumeAttempt({
      now: NOW + AUTO_RESUME_MAX_LINEAGE_MS, task, state: freshState(), backup,
    })).toEqual({ state: 'exhausted', reason: 'time_cap' });
    expect(planAutoResumeAttempt({
      now: NOW, task, state: freshState({ rejectionsInWindow: 3, windowResetAt: NOW + MINUTE }), backup,
    })).toEqual({ state: 'exhausted', reason: 'window_rejections' });
  });

  test('waits for the reset window on the original after two rejections in one window', () => {
    const state = freshState({ rejectionsInWindow: 2, windowResetAt: NOW + 20 * MINUTE });
    expect(planAutoResumeAttempt({ now: NOW, task, state, backup })).toEqual({
      state: 'scheduled',
      nextAttemptAt: NOW + 20 * MINUTE + AUTO_RESUME_RESET_JITTER_MS,
      target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
      resetAt: NOW + 20 * MINUTE,
      resetSource: 'opencode_status',
    });
    // A window that already reset no longer blocks the backup.
    expect(planAutoResumeAttempt({
      now: NOW + 21 * MINUTE, task, state, backup,
    })).toMatchObject({ target: { kind: 'backup' } });
  });

  test('tries a distinct, compatible, unbroken backup immediately', () => {
    const state = freshState({ resetAt: NOW + 40 * MINUTE, resetSource: 'opencode_status' });
    expect(planAutoResumeAttempt({ now: NOW, task, state, backup })).toEqual({
      state: 'scheduled',
      nextAttemptAt: NOW,
      target: { kind: 'backup', providerId: 'openai', modelId: 'gpt-5.6', variant: 'medium' },
      resetAt: NOW + 40 * MINUTE,
      resetSource: 'opencode_status',
    });
    const original = (plan) => expect(plan).toMatchObject({ target: { kind: 'original' } });
    original(planAutoResumeAttempt({
      now: NOW, task, state, backup: { providerId: 'anthropic', modelId: 'claude-opus', variant: null },
    }));
    original(planAutoResumeAttempt({
      now: NOW,
      task: parkedTask({ readOnly: true }),
      state,
      backup: { providerId: 'cursor-acp', modelId: 'composer', variant: null },
    }));
    original(planAutoResumeAttempt({
      now: NOW,
      task,
      state,
      backup,
      breakerUntil: (providerId) => (providerId === 'openai' ? NOW + MINUTE : null),
    }));
    expect(planAutoResumeAttempt({
      now: NOW,
      task,
      state,
      backup,
      breakerUntil: (providerId) => (providerId === 'openai' ? NOW - 1 : null),
    })).toMatchObject({ target: { kind: 'backup' } });
  });

  test('returns to the original after the earliest known reset plus jitter', () => {
    const state = freshState({ resetAt: NOW + 40 * MINUTE, resetSource: 'opencode_status' });
    expect(planAutoResumeAttempt({ now: NOW, task, state })).toEqual({
      state: 'scheduled',
      nextAttemptAt: NOW + 40 * MINUTE + AUTO_RESUME_RESET_JITTER_MS,
      target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
      resetAt: NOW + 40 * MINUTE,
      resetSource: 'opencode_status',
    });
    expect(planAutoResumeAttempt({
      now: NOW, task, state, providerReset: { resetAt: NOW + 10 * MINUTE, limited: true },
    })).toMatchObject({
      nextAttemptAt: NOW + 10 * MINUTE + AUTO_RESUME_RESET_JITTER_MS,
      resetAt: NOW + 10 * MINUTE,
      resetSource: 'meridian_quota',
    });
    expect(planAutoResumeAttempt({
      now: NOW, task, state, providerReset: { resetAt: NOW + 10 * MINUTE, limited: false },
    })).toMatchObject({ resetAt: NOW + 40 * MINUTE, resetSource: 'opencode_status' });
    expect(planAutoResumeAttempt({
      now: NOW,
      task,
      state: freshState(),
      breakerUntil: (providerId) => (providerId === 'anthropic'
        ? { until: NOW + 5 * MINUTE, source: 'meridian_quota' }
        : null),
    })).toMatchObject({
      nextAttemptAt: NOW + 5 * MINUTE + AUTO_RESUME_RESET_JITTER_MS,
      resetAt: NOW + 5 * MINUTE,
      resetSource: 'meridian_quota',
    });
    // A reset that is imminent still honours the minimum delay.
    expect(planAutoResumeAttempt({
      now: NOW, task, state: freshState({ resetAt: NOW - 1_000 + AUTO_RESUME_MIN_DELAY_MS, resetSource: 'opencode_status' }),
    })).toMatchObject({ nextAttemptAt: NOW + AUTO_RESUME_MIN_DELAY_MS + AUTO_RESUME_RESET_JITTER_MS - 1_000 });
  });

  test('backs off 15/30/60/60 minutes without a reset signal', () => {
    const delays = [1, 2, 3, 4].map((noSignalProbes) => {
      const plan = planAutoResumeAttempt({ now: NOW, task, state: freshState({ noSignalProbes }) });
      expect(plan).toMatchObject({ state: 'scheduled', resetSource: 'backoff', target: { kind: 'original' } });
      expect(plan.resetAt).toBe(plan.nextAttemptAt);
      return plan.nextAttemptAt - NOW;
    });
    expect(delays).toEqual([15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 60 * MINUTE]);
    expect(planAutoResumeAttempt({ now: NOW, task, state: freshState({ noSignalProbes: 0 }) }).nextAttemptAt)
      .toBe(NOW + 15 * MINUTE);
  });

  test('exhausts on the time cap when the next attempt would land past the lineage budget', () => {
    expect(planAutoResumeAttempt({
      now: NOW,
      task,
      state: freshState({ expiresAt: NOW + 10 * MINUTE, resetAt: NOW + 20 * MINUTE, resetSource: 'opencode_status' }),
    })).toEqual({ state: 'exhausted', reason: 'time_cap' });
    expect(planAutoResumeAttempt({
      now: NOW, task, state: freshState({ expiresAt: NOW + 10 * MINUTE, noSignalProbes: 1 }),
    })).toEqual({ state: 'exhausted', reason: 'time_cap' });
  });

  test('plans against the lineage origin when the parked task ran on the backup', () => {
    const onBackup = parkedTask({ providerId: 'openai', modelId: 'gpt-5.6', variant: 'medium' });
    const origin = { providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' };
    // The backup just got limited, so its breaker is open; the plan must go back
    // to the execution the lineage started on, not to the task's own model.
    expect(planAutoResumeAttempt({
      now: NOW,
      task: onBackup,
      state: freshState({ noSignalProbes: 1 }),
      backup,
      origin,
      breakerUntil: (providerId) => (providerId === 'openai' ? NOW + 30 * MINUTE : null),
    })).toMatchObject({
      nextAttemptAt: NOW + 15 * MINUTE,
      resetSource: 'backoff',
      target: { kind: 'original', providerId: 'anthropic', modelId: 'claude-opus', variant: 'high' },
    });
    // Without the origin the task's own execution would be treated as "original".
    expect(planAutoResumeAttempt({
      now: NOW,
      task: onBackup,
      state: freshState({ noSignalProbes: 1 }),
      backup,
      breakerUntil: (providerId) => (providerId === 'openai' ? NOW + 30 * MINUTE : null),
    })).toMatchObject({
      nextAttemptAt: NOW + 30 * MINUTE + AUTO_RESUME_RESET_JITTER_MS,
      target: { kind: 'original', providerId: 'openai' },
    });
  });

  test('builds the deterministic acknowledgement for the scheduled target', () => {
    const envelope = parkedEnvelope(task, {
      autoResume: freshState({
        state: 'attempting',
        cancelGeneration: 3,
        attemptCount: 2,
        target: { kind: 'backup', providerId: 'openai', modelId: 'gpt-5.6', variant: null },
      }),
    });
    expect(buildAutoResumeAcknowledgeParams({ task, envelope })).toEqual({
      taskId: 'dvr_task_parked',
      rootSessionId: 'ses_root',
      directory: '/workspace',
      action: 'retry_in_place',
      idempotencyKey: 'auto-resume:dvr_task_parked:3:2',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: null,
      autoResumeGeneration: 3,
    });
    expect(() => buildAutoResumeAcknowledgeParams({ task, envelope: parkedEnvelope(task) }))
      .toThrow('auto-resume attempts require a scheduled target');
  });
});
