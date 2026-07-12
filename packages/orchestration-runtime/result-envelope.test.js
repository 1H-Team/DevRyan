import { describe, expect, test } from 'bun:test';

import { createManagedTaskRecord } from './contract.js';
import {
  createManagedTaskResultEnvelope,
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
    });
    expect(validateManagedTaskResultEnvelope(envelope)).toBe(envelope);
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
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
