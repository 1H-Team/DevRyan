import { describe, expect, test } from 'bun:test';

import { createManagedTaskRecord } from './contract.js';
import {
  createManagedTaskResultEnvelope,
  validateManagedTaskAutoResume,
  validateManagedTaskResultEnvelope,
} from './result-envelope.js';

const terminalTask = (overrides = {}) => ({
  ...createManagedTaskRecord({
    taskId: 'dvr_task_result',
    idempotencyKey: 'result',
    rootSessionId: 'ses_root',
    parentTaskId: null,
    directory: '/workspace',
    sequence: 7,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: 'Result task',
    prompt: 'Return a result.',
    attempt: 2,
    priorTaskId: 'dvr_task_prior',
    executionKind: 'retry',
    createdAt: 1_000,
    timeoutAt: null,
  }),
  status: 'failed',
  childSessionId: 'ses_child',
  leaseToken: 'dvr_lease_1',
  startedAt: 1_100,
  finishedAt: 2_000,
  failureReason: 'provider disconnected',
  partial: true,
  recoverablePreview: 'Useful partial result',
  canonicalRefs: [
    { type: 'message', id: 'msg_1' },
    { type: 'tool', id: 'tool_1' },
  ],
  ...overrides,
});

describe('managed task result envelopes', () => {
  test('preserves partial output, failure, lineage, and canonical references', () => {
    const envelope = createManagedTaskResultEnvelope(terminalTask(), {
      sequence: 11,
      createdAt: 2_000,
      resumable: true,
    });

    expect(envelope).toEqual({
      owner: 'devryan',
      envelopeId: 'dvr_result_result_11',
      taskId: 'dvr_task_result',
      rootSessionId: 'ses_root',
      parentTaskId: null,
      childSessionId: 'ses_child',
      directory: '/workspace',
      sequence: 11,
      status: 'failed',
      partial: true,
      failureReason: 'provider disconnected',
      attempt: 2,
      priorTaskId: 'dvr_task_prior',
      executionKind: 'retry',
      recoverablePreview: 'Useful partial result',
      canonicalRefs: [
        { type: 'message', id: 'msg_1' },
        { type: 'tool', id: 'tool_1' },
      ],
      resumable: true,
      createdAt: 2_000,
      acknowledgedAt: null,
      action: null,
      followUpTaskId: null,
      providerResetAt: null,
      autoResume: null,
    });
    expect(validateManagedTaskResultEnvelope(envelope)).toBe(envelope);
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  test('records the provider reset hint and tolerates pre-upgrade envelopes without slice-2 fields', () => {
    const envelope = createManagedTaskResultEnvelope(terminalTask(), {
      sequence: 1,
      createdAt: 2_000,
      resumable: true,
      providerResetAt: 9_000,
    });
    expect(envelope.providerResetAt).toBe(9_000);
    expect(envelope.autoResume).toBeNull();

    const legacy = { ...envelope };
    delete legacy.providerResetAt;
    delete legacy.autoResume;
    expect(validateManagedTaskResultEnvelope(legacy)).toBe(legacy);
    expect(() => validateManagedTaskResultEnvelope({ ...envelope, providerResetAt: -5 }))
      .toThrow('result providerResetAt must be a non-negative finite timestamp or null');
    expect(() => validateManagedTaskResultEnvelope({ ...envelope, autoResume: 'soon' }))
      .toThrow('autoResume must be an object or null');
  });

  test('normalizes auto-resume state and rejects malformed shapes', () => {
    expect(validateManagedTaskAutoResume(null)).toBeNull();
    expect(validateManagedTaskAutoResume(undefined)).toBeNull();

    const minimal = {
      revision: 1,
      enabled: true,
      state: 'planning',
      cancelGeneration: 0,
      lineageStartedAt: 1_000,
      expiresAt: 1_000 + 6 * 60 * 60 * 1_000,
    };
    const normalized = validateManagedTaskAutoResume(minimal);
    expect(normalized).toEqual({
      ...minimal,
      attemptCount: 0,
      noSignalProbes: 0,
      rejectionsInWindow: 0,
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
    });
    expect(normalized).not.toBe(minimal);

    const full = {
      ...minimal,
      state: 'scheduled',
      attemptCount: 2,
      nextAttemptAt: 5_000,
      resetAt: 4_000,
      resetSource: 'meridian_quota',
      target: { kind: 'backup', providerId: 'openai', modelId: 'gpt-5.6', variant: null, extra: true },
      lastAttemptTaskId: 'dvr_task_2',
      lastError: { code: 'host_busy', message: 'browser lease held', at: 4_500 },
      reason: null,
    };
    expect(validateManagedTaskAutoResume(full)).toMatchObject({
      target: { kind: 'backup', providerId: 'openai', modelId: 'gpt-5.6', variant: null },
      lastError: { code: 'host_busy', message: 'browser lease held', at: 4_500 },
    });
    expect(validateManagedTaskAutoResume(full).target).not.toHaveProperty('extra');

    expect(() => validateManagedTaskAutoResume({ ...minimal, state: 'paused' }))
      .toThrow('autoResume.state must be one of');
    expect(() => validateManagedTaskAutoResume({ ...minimal, revision: 0 }))
      .toThrow('autoResume.revision must be a positive safe integer');
    expect(() => validateManagedTaskAutoResume({ ...minimal, enabled: 'yes' }))
      .toThrow('autoResume.enabled must be a boolean');
    expect(() => validateManagedTaskAutoResume({ ...minimal, resetSource: 'guess' }))
      .toThrow('autoResume.resetSource must be one of');
    expect(() => validateManagedTaskAutoResume({ ...minimal, reason: 'bored' }))
      .toThrow('autoResume.reason must be one of');
    expect(() => validateManagedTaskAutoResume({ ...minimal, target: { kind: 'other', providerId: 'x', modelId: 'y' } }))
      .toThrow('autoResume.target.kind must be one of');
    expect(() => validateManagedTaskAutoResume({ ...minimal, lastError: { code: '', message: 'x', at: 1 } }))
      .toThrow('autoResume.lastError.code is required');
    expect(() => validateManagedTaskAutoResume({ ...minimal, attemptCount: -1 }))
      .toThrow('autoResume.attemptCount must be a non-negative safe integer');
  });

  test('never manufactures completed state from useful failed output', () => {
    const envelope = createManagedTaskResultEnvelope(terminalTask({
      recoverablePreview: 'A complete-looking answer',
      partial: true,
    }), {
      sequence: 1,
      createdAt: 2_000,
      resumable: false,
    });

    expect(envelope.status).toBe('failed');
    expect(envelope.partial).toBe(true);
  });

  test('rejects nonterminal tasks and non-DevRyan result identities', () => {
    expect(() => createManagedTaskResultEnvelope(terminalTask({
      status: 'running',
      finishedAt: null,
    }), {
      sequence: 1,
      createdAt: 2_000,
      resumable: false,
    })).toThrow('result envelopes require a terminal task');

    const envelope = createManagedTaskResultEnvelope(terminalTask(), {
      sequence: 1,
      createdAt: 2_000,
      resumable: false,
    });
    expect(() => validateManagedTaskResultEnvelope({ ...envelope, owner: 'provider' }))
      .toThrow('result owner must be devryan');
  });
});
