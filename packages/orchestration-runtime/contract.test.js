import { describe, expect, test } from 'bun:test';

import {
  MANAGED_TASK_OWNER,
  MANAGED_TASK_STATUSES,
  MAX_MANAGED_TASK_LABEL_BYTES,
  MAX_MANAGED_TASK_PROMPT_BYTES,
  createManagedTaskRecord,
  isTerminalManagedTaskStatus,
  truncateManagedText,
  toManagedTaskEvent,
  toManagedTaskRemovalEvent,
  validateManagedTaskRecord,
} from './contract.js';
import * as contract from './contract.js';

const validInput = (overrides = {}) => ({
  taskId: 'dvr_task_01',
  idempotencyKey: 'root-1:research-auth',
  rootSessionId: 'ses_root',
  dispatchGroupId: 'msg_parent_01',
  parentTaskId: null,
  directory: '/workspace',
  sequence: 1,
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: 'Inspect authentication flow',
  prompt: 'Inspect the authentication flow and report relevant files.',
  attempt: 1,
  priorTaskId: null,
  executionKind: 'start',
  createdAt: 1_000,
  timeoutAt: null,
  ...overrides,
});

describe('managed orchestration contract', () => {
  test('formats one shared display name without changing durable labels', () => {
    expect(typeof contract.formatManagedTaskDisplayName).toBe('function');
    expect(contract.formatManagedTaskDisplayName('  workspace-surface_map  ')).toBe('Workspace surface map');
    expect(contract.formatManagedTaskDisplayName('Already Humanized')).toBe('Already Humanized');
    expect(contract.formatManagedTaskDisplayName('---')).toBe('');
    expect(contract.formatManagedTaskDisplayName('')).toBe('');

    const task = createManagedTaskRecord(validInput({ label: 'workspace-surface_map' }));
    expect(task.label).toBe('workspace-surface_map');
  });

  test('defines a distinct DevRyan owner and the complete status set', () => {
    expect(MANAGED_TASK_OWNER).toBe('devryan');
    expect(MANAGED_TASK_STATUSES).toEqual([
      'queued',
      'starting',
      'running',
      'completed',
      'failed',
      'aborted',
      'interrupted',
    ]);

    expect(isTerminalManagedTaskStatus('completed')).toBe(true);
    expect(isTerminalManagedTaskStatus('failed')).toBe(true);
    expect(isTerminalManagedTaskStatus('aborted')).toBe(true);
    expect(isTerminalManagedTaskStatus('interrupted')).toBe(true);
    expect(isTerminalManagedTaskStatus('running')).toBe(false);
  });

  test('creates a JSON-compatible queued task with a DevRyan identity', () => {
    const task = createManagedTaskRecord(validInput());

    expect(task).toEqual({
      ...validInput(),
      owner: 'devryan',
      status: 'queued',
      childSessionId: null,
      leaseToken: null,
      startedAt: null,
      finishedAt: null,
      failureReason: null,
      partial: false,
      recoverablePreview: '',
      canonicalRefs: [],
    });
    expect(JSON.parse(JSON.stringify(task))).toEqual(task);
    expect(validateManagedTaskRecord(task)).toBe(task);
  });

  test('defaults legacy and ungrouped work to no private dispatch group', () => {
    const input = validInput();
    delete input.dispatchGroupId;

    const task = createManagedTaskRecord(input);

    expect(task.dispatchGroupId).toBeNull();
    expect(() => validateManagedTaskRecord({ ...task, dispatchGroupId: '' }))
      .toThrow('dispatchGroupId is required');
  });

  test('rejects provider-native ownership and colliding task identifiers', () => {
    const task = createManagedTaskRecord(validInput());

    expect(() => validateManagedTaskRecord({ ...task, owner: 'cursor' }))
      .toThrow('owner must be devryan');
    expect(() => validateManagedTaskRecord({ ...task, taskId: 'ses_provider_child' }))
      .toThrow('taskId must start with dvr_task_');
  });

  test('requires stable root, directory, execution snapshot, and lineage fields', () => {
    expect(() => createManagedTaskRecord(validInput({ rootSessionId: '' })))
      .toThrow('rootSessionId is required');
    expect(() => createManagedTaskRecord(validInput({ directory: '' })))
      .toThrow('directory is required');
    expect(() => createManagedTaskRecord(validInput({ providerId: '' })))
      .toThrow('providerId is required');
    expect(() => createManagedTaskRecord(validInput({ modelId: '' })))
      .toThrow('modelId is required');
    expect(() => createManagedTaskRecord(validInput({ agent: '' })))
      .toThrow('agent is required');
    expect(() => createManagedTaskRecord(validInput({ attempt: 0 })))
      .toThrow('attempt must be a positive integer');
    expect(() => createManagedTaskRecord(validInput({ mode: 'provider-native' })))
      .toThrow('mode must be builder or orchestrator');
  });

  test('enforces byte limits instead of character-count limits', () => {
    const twoByteCharacter = 'é';
    const oversizedLabel = twoByteCharacter.repeat(Math.floor(MAX_MANAGED_TASK_LABEL_BYTES / 2) + 1);
    const oversizedPrompt = twoByteCharacter.repeat(Math.floor(MAX_MANAGED_TASK_PROMPT_BYTES / 2) + 1);

    expect(() => createManagedTaskRecord(validInput({ label: oversizedLabel })))
      .toThrow(`label exceeds ${MAX_MANAGED_TASK_LABEL_BYTES} UTF-8 bytes`);
    expect(() => createManagedTaskRecord(validInput({ prompt: oversizedPrompt })))
      .toThrow(`prompt exceeds ${MAX_MANAGED_TASK_PROMPT_BYTES} UTF-8 bytes`);

    const truncated = truncateManagedText(twoByteCharacter.repeat(10), 9);
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(9);
    expect(twoByteCharacter.repeat(10).startsWith(truncated)).toBe(true);
  });

  test('broadcast projection excludes prompt and idempotency content', () => {
    const task = createManagedTaskRecord(validInput());
    const event = toManagedTaskEvent(task);

    expect(event.type).toBe('openchamber:managed-task');
    expect(event.properties.owner).toBe('devryan');
    expect(event.properties.task.taskId).toBe(task.taskId);
    expect(event.properties.task.label).toBe(task.label);
    expect(event.properties.task).not.toHaveProperty('prompt');
    expect(event.properties.task).not.toHaveProperty('idempotencyKey');
    expect(event.properties.task).not.toHaveProperty('dispatchGroupId');
    expect(event.properties.task.agentRetryAvailable).toBe(true);
    expect(event.properties.directory).toBe('/workspace');
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  test('projects agent retry availability only for the first grouped Orchestrator attempt', () => {
    const groupedInitial = createManagedTaskRecord(validInput());
    const groupedRecovery = createManagedTaskRecord(validInput({
      taskId: 'dvr_task_02',
      idempotencyKey: 'retry-02',
      attempt: 2,
      priorTaskId: groupedInitial.taskId,
      executionKind: 'retry',
    }));
    const ungrouped = createManagedTaskRecord(validInput({
      taskId: 'dvr_task_03',
      idempotencyKey: 'ungrouped-03',
      dispatchGroupId: null,
    }));
    const groupedBuilder = createManagedTaskRecord(validInput({
      taskId: 'dvr_task_04',
      idempotencyKey: 'builder-04',
      mode: 'builder',
    }));

    expect(toManagedTaskEvent(groupedInitial).properties.task.agentRetryAvailable).toBe(true);
    expect(toManagedTaskEvent(groupedRecovery).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(ungrouped).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(groupedBuilder).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(groupedRecovery).properties.task).not.toHaveProperty('dispatchGroupId');
  });

  test('projects compaction as a safe identity-only removal event', () => {
    const task = createManagedTaskRecord(validInput());
    const event = toManagedTaskRemovalEvent(task);

    expect(event).toEqual({
      type: 'openchamber:managed-task-removed',
      properties: {
        owner: 'devryan',
        taskId: task.taskId,
        rootSessionId: task.rootSessionId,
        directory: task.directory,
        sequence: task.sequence,
      },
    });
    expect(JSON.stringify(event)).not.toContain(task.prompt);
    expect(JSON.stringify(event)).not.toContain(task.idempotencyKey);
  });
});
