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
  dispatchCallId: 'call_dispatch_01',
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
    expect(contract.formatManagedTaskDisplayName('  workspace-surface_map  ')).toBe('Workspace Surface Map');
    expect(contract.formatManagedTaskDisplayName('locate chat ui')).toBe('Locate Chat UI');
    expect(contract.formatManagedTaskDisplayName('locate-chat_ui')).toBe('Locate Chat UI');
    expect(contract.formatManagedTaskDisplayName('review api and json for the cli')).toBe('Review API and JSON for the CLI');
    expect(contract.formatManagedTaskDisplayName('OpenCode HTTP MCP')).toBe('OpenCode HTTP MCP');
    expect(contract.formatManagedTaskDisplayName('keep MIXEDCase and ALLCAPS')).toBe('Keep MIXEDCase and ALLCAPS');
    expect(contract.formatManagedTaskDisplayName('constructor')).toBe('Constructor');
    expect(contract.formatManagedTaskDisplayName('Already Humanized')).toBe('Already Humanized');
    expect(contract.formatManagedTaskDisplayName('review_review_privacy')).toBe('Review Privacy');
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
      dispatchWaveId: null,
      readOnly: false,
      childSessionId: null,
      recoveryLineageId: null,
      leaseToken: null,
      startedAt: null,
      finishedAt: null,
      childPromptedAt: null,
      firstAssistantPartAt: null,
      waitingReason: null,
      failureReason: null,
      partial: false,
      recoverablePreview: '',
      canonicalRefs: [],
    });
    expect(JSON.parse(JSON.stringify(task))).toEqual(task);
    expect(validateManagedTaskRecord(task)).toBe(task);
  });

  test('carries recovery lineage and child progress stamps as nullable durable fields', () => {
    const root = createManagedTaskRecord(validInput());
    const followUp = createManagedTaskRecord(validInput({
      taskId: 'dvr_task_02',
      idempotencyKey: 'follow-up-02',
      priorTaskId: root.taskId,
      attempt: 2,
      executionKind: 'retry_in_place',
      recoveryLineageId: 'dvr_lineage_01',
    }));

    expect(root.recoveryLineageId).toBeNull();
    expect(followUp.recoveryLineageId).toBe('dvr_lineage_01');
    expect(validateManagedTaskRecord({ ...root, childPromptedAt: 1_500, firstAssistantPartAt: 1_600 }))
      .toMatchObject({ childPromptedAt: 1_500, firstAssistantPartAt: 1_600 });
    expect(() => validateManagedTaskRecord({ ...root, recoveryLineageId: 'lineage_01' }))
      .toThrow('recoveryLineageId must start with dvr_lineage_');
    expect(() => validateManagedTaskRecord({ ...root, childPromptedAt: -1 }))
      .toThrow('childPromptedAt must be a non-negative finite timestamp or null');
    expect(() => validateManagedTaskRecord({ ...root, firstAssistantPartAt: 'soon' }))
      .toThrow('firstAssistantPartAt must be a non-negative finite timestamp or null');

    const projected = toManagedTaskEvent({ ...followUp, childPromptedAt: 1_500 }).properties.task;
    expect(projected).toMatchObject({
      recoveryLineageId: 'dvr_lineage_01',
      childPromptedAt: 1_500,
      firstAssistantPartAt: null,
    });
  });

  test('carries a queued-only waiting reason and projects it to events', () => {
    const root = createManagedTaskRecord(validInput());
    expect(root.waitingReason).toBeNull();

    const capacity = { kind: 'capacity', activeCount: 4, limit: 4, since: 1_500 };
    const pressure = { kind: 'system_pressure', activeCount: 2, limit: null, since: 1_600 };
    expect(validateManagedTaskRecord({ ...root, waitingReason: capacity }))
      .toMatchObject({ waitingReason: capacity });
    expect(validateManagedTaskRecord({ ...root, waitingReason: pressure }))
      .toMatchObject({ waitingReason: pressure });
    expect(validateManagedTaskRecord({ ...root, waitingReason: { ...capacity, limit: null } }).waitingReason.limit)
      .toBeNull();

    expect(() => validateManagedTaskRecord({ ...root, waitingReason: undefined }))
      .toThrow('waitingReason must be an object or null');
    expect(() => validateManagedTaskRecord({ ...root, waitingReason: { ...capacity, kind: 'busy' } }))
      .toThrow('waitingReason.kind must be capacity or system_pressure');
    expect(() => validateManagedTaskRecord({ ...root, waitingReason: { ...capacity, activeCount: -1 } }))
      .toThrow('waitingReason.activeCount must be a non-negative integer');
    expect(() => validateManagedTaskRecord({ ...root, waitingReason: { ...capacity, limit: 0 } }))
      .toThrow('waitingReason.limit must be a positive integer or null');
    expect(() => validateManagedTaskRecord({ ...root, waitingReason: { ...pressure, limit: 2 } }))
      .toThrow('waitingReason.limit must be null for system_pressure');
    expect(() => validateManagedTaskRecord({ ...root, waitingReason: { ...capacity, since: 'now' } }))
      .toThrow('waitingReason.since must be a non-negative finite timestamp');
    expect(() => validateManagedTaskRecord({ ...root, waitingReason: { ...capacity, extra: true } }))
      .toThrow('waitingReason.extra is not a waiting reason field');
    for (const status of ['starting', 'running', 'completed', 'failed', 'aborted', 'interrupted']) {
      expect(() => validateManagedTaskRecord({ ...root, status, waitingReason: capacity }))
        .toThrow('waitingReason must be null unless the task is queued');
    }

    const projected = toManagedTaskEvent({ ...root, waitingReason: capacity }).properties.task;
    expect(projected.waitingReason).toEqual(capacity);
    expect(projected.waitingReason).not.toBe(capacity);
    expect(toManagedTaskEvent(root).properties.task.waitingReason).toBeNull();
  });

  test('exports the shared manual Model Recovery gate', () => {
    const parked = {
      ...createManagedTaskRecord(validInput()),
      childSessionId: 'ses_child',
      status: 'failed',
      startedAt: 1_100,
      finishedAt: 1_200,
      failureReason: 'out of usage',
    };
    expect(contract.requiresManualModelRecovery(parked, { resumable: true })).toBe(true);
    expect(contract.requiresManualModelRecovery(parked, { resumable: false })).toBe(false);
    expect(contract.requiresManualModelRecovery(
      { ...parked, failureReason: 'provider disconnected' },
      { resumable: true },
    )).toBe(false);
  });

  test('defaults legacy work to no private dispatch identity', () => {
    const input = validInput();
    delete input.dispatchGroupId;
    delete input.dispatchCallId;

    const task = createManagedTaskRecord(input);

    expect(task.dispatchGroupId).toBeNull();
    expect(task.dispatchCallId).toBeNull();
    expect(() => validateManagedTaskRecord({ ...task, dispatchGroupId: '' }))
      .toThrow('dispatchGroupId is required');
    expect(() => validateManagedTaskRecord({ ...task, dispatchCallId: '' }))
      .toThrow('dispatchCallId is required');
  });

  test('defaults legacy work to writable and validates an explicit read-only policy', () => {
    const writable = createManagedTaskRecord(validInput());
    const readOnly = createManagedTaskRecord(validInput({ readOnly: true }));

    expect(writable.readOnly).toBe(false);
    expect(readOnly.readOnly).toBe(true);
    expect(() => validateManagedTaskRecord({ ...writable, readOnly: 'yes' }))
      .toThrow('readOnly must be a boolean');
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
    expect(event.properties.task.dispatchCallId).toBe('call_dispatch_01');
    expect(event.properties.task.dispatchGrouped).toBe(true);
    expect(event.properties.task.dispatchWaveId).toBeNull();
    expect(event.properties.task.label).toBe(task.label);
    expect(event.properties.task).not.toHaveProperty('prompt');
    expect(event.properties.task).not.toHaveProperty('idempotencyKey');
    expect(event.properties.task).not.toHaveProperty('dispatchGroupId');
    expect(event.properties.task).not.toHaveProperty('readOnly');
    expect(event.properties.task.agentRetryAvailable).toBe(true);
    expect(event.properties.directory).toBe('/workspace');
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  test('projects the display-only dispatch wave while still withholding the group id', () => {
    const task = createManagedTaskRecord(validInput({ dispatchWaveId: 'dvr_wave_01' }));
    const projected = toManagedTaskEvent(task).properties.task;

    expect(task.dispatchWaveId).toBe('dvr_wave_01');
    expect(projected.dispatchWaveId).toBe('dvr_wave_01');
    expect(projected.dispatchGrouped).toBe(true);
    expect(projected).not.toHaveProperty('dispatchGroupId');
    expect(createManagedTaskRecord(validInput()).dispatchWaveId).toBeNull();
    expect(() => createManagedTaskRecord(validInput({ dispatchWaveId: 'wave_01' }))).toThrow(
      /dispatchWaveId must start with dvr_wave_/,
    );
    expect(() => createManagedTaskRecord(validInput({ dispatchWaveId: 42 }))).toThrow(TypeError);
  });

  test('projects deadline failures without exposing the private dispatch group', () => {
    const task = {
      ...createManagedTaskRecord(validInput()),
      childSessionId: 'ses_child_timeout',
      status: 'failed',
      startedAt: 1_100,
      finishedAt: 2_000,
      failureReason: 'Managed task timed out at 2000',
      partial: true,
    };
    const projected = toManagedTaskEvent(task).properties.task;

    expect(projected).toMatchObject({
      dispatchGrouped: true,
      failureKind: 'deadline_exceeded',
      agentRetryAvailable: true,
    });
    expect(projected).not.toHaveProperty('dispatchGroupId');
    expect(toManagedTaskEvent(createManagedTaskRecord(validInput({
      dispatchGroupId: null,
    }))).properties.task.dispatchGrouped).toBe(false);
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

  test('reserves provider usage limits for manual recovery on the first grouped attempt', () => {
    const initial = createManagedTaskRecord(validInput());
    const terminal = (failureReason) => ({
      ...initial,
      childSessionId: 'ses_child',
      status: 'failed',
      startedAt: 1_100,
      finishedAt: 1_200,
      failureReason,
    });

    expect(toManagedTaskEvent(terminal('Provider connection ended')).properties.task.agentRetryAvailable).toBe(true);
    expect(toManagedTaskEvent(terminal('out of usage')).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal('Free usage exceeded, subscribe to Go')).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal('Usage limit reached')).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal("You've hit your session limit · resets 7:30pm")).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal(
      "Claude Code returned an error result: You've hit your limit · resets 1:30am (Africa/Casablanca) "
      + 'Subprocess stderr: Permission deny rule "MultiEdit" matches no known tool',
    )).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal('quota exceeded')).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal('insufficient quota')).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal('rate limited')).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal('Model not found: opencode/retired-model')).properties.task.agentRetryAvailable).toBe(false);
    expect(toManagedTaskEvent(terminal('concurrent session limit temporarily reached')).properties.task.agentRetryAvailable).toBe(false);
  });

  test('projects provider prompt rejection while preserving the single grouped agent retry', () => {
    const initial = createManagedTaskRecord(validInput());
    const rejected = {
      ...initial,
      childSessionId: 'ses_child',
      status: 'failed',
      startedAt: 1_100,
      finishedAt: 1_200,
      failureReason: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.',
    };
    const finalRejected = {
      ...rejected,
      taskId: 'dvr_task_02',
      idempotencyKey: 'retry-02',
      attempt: 2,
      priorTaskId: initial.taskId,
      executionKind: 'retry',
    };

    expect(toManagedTaskEvent(rejected).properties.task).toMatchObject({
      failureKind: 'provider_prompt_rejected',
      agentRetryAvailable: true,
    });
    expect(toManagedTaskEvent(finalRejected).properties.task).toMatchObject({
      failureKind: 'provider_prompt_rejected',
      agentRetryAvailable: false,
    });
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
