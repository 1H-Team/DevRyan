import { describe, expect, test } from 'bun:test';

import { createManagedTaskRecord } from './contract.js';
import {
  assertManagedTaskTransition,
  canTransitionManagedTaskStatus,
} from './transitions.js';

const task = (status = 'queued') => ({
  ...createManagedTaskRecord({
    taskId: 'dvr_task_transition',
    idempotencyKey: 'transition',
    rootSessionId: 'ses_root',
    parentTaskId: null,
    directory: '/workspace',
    sequence: 1,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: 'Transition test',
    prompt: 'Test transitions.',
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: 1_000,
    timeoutAt: null,
  }),
  status,
});

describe('managed task transitions', () => {
  test('allows only the explicit lifecycle graph', () => {
    expect(canTransitionManagedTaskStatus('queued', 'starting')).toBe(true);
    expect(canTransitionManagedTaskStatus('queued', 'aborted')).toBe(true);
    expect(canTransitionManagedTaskStatus('starting', 'running')).toBe(true);
    expect(canTransitionManagedTaskStatus('starting', 'failed')).toBe(true);
    expect(canTransitionManagedTaskStatus('starting', 'aborted')).toBe(true);
    expect(canTransitionManagedTaskStatus('starting', 'interrupted')).toBe(true);
    expect(canTransitionManagedTaskStatus('running', 'completed')).toBe(true);
    expect(canTransitionManagedTaskStatus('running', 'failed')).toBe(true);
    expect(canTransitionManagedTaskStatus('running', 'aborted')).toBe(true);
    expect(canTransitionManagedTaskStatus('running', 'interrupted')).toBe(true);

    expect(canTransitionManagedTaskStatus('queued', 'running')).toBe(false);
    expect(canTransitionManagedTaskStatus('starting', 'completed')).toBe(false);
    expect(canTransitionManagedTaskStatus('running', 'queued')).toBe(false);
    expect(canTransitionManagedTaskStatus('completed', 'running')).toBe(false);
  });

  test('permits same-status metadata updates before terminal settlement', () => {
    const previous = task('starting');
    const next = {
      ...previous,
      childSessionId: 'ses_child',
      leaseToken: 'dvr_lease_1',
    };

    expect(assertManagedTaskTransition(previous, next)).toBe(next);
  });

  test('makes every terminal record immutable', () => {
    for (const status of ['completed', 'failed', 'aborted', 'interrupted']) {
      const previous = {
        ...task(status),
        finishedAt: 2_000,
      };
      expect(() => assertManagedTaskTransition(previous, {
        ...previous,
        failureReason: 'changed later',
      })).toThrow(`terminal task ${previous.taskId} is immutable`);
    }
  });

  test('rejects identity and queue-snapshot mutation at every lifecycle stage', () => {
    const previous = task('starting');
    for (const [field, value] of [
      ['owner', 'provider'],
      ['taskId', 'dvr_task_other'],
      ['rootSessionId', 'ses_other'],
      ['dispatchGroupId', 'msg_other'],
      ['directory', '/other'],
      ['mode', 'builder'],
      ['providerId', 'cursor-acp'],
      ['modelId', 'composer'],
      ['agent', 'fixer'],
      ['prompt', 'new work'],
      ['attempt', 2],
    ]) {
      expect(() => assertManagedTaskTransition(previous, {
        ...previous,
        [field]: value,
      })).toThrow(`${field} is immutable`);
    }
  });
});
