import { describe, expect, test } from 'bun:test';
import {
  createManagedTaskRecord,
  createManagedTaskResultEnvelope,
  toManagedTaskEvent,
  type ManagedTaskEvent,
  type ManagedTaskEventRecord,
  type ManagedTaskRemovalEvent,
  type ManagedTaskStatus,
} from '@openchamber/orchestration-runtime';

import type {
  ManagedOrchestrationApi,
  ManagedOrchestrationSnapshot,
  ManagedTaskAcknowledgementResponse,
  ManagedTaskAutoResume,
  ManagedTaskAutoResumeResponse,
  ManagedTaskProjectedEnvelope,
  ManagedTaskProjectedRecord,
} from '@/lib/orchestrationApi';
import {
  createManagedOrchestrationStore,
  managedOrchestrationSelectors,
} from './useManagedOrchestrationStore';

const taskRecord = (
  index: number,
  status: ManagedTaskStatus = 'queued',
  overrides: Partial<ManagedTaskEventRecord> = {},
) => ({
  ...createManagedTaskRecord({
    taskId: `dvr_task_${index}`,
    idempotencyKey: `key-${index}`,
    rootSessionId: index === 9 ? 'ses_other' : 'ses_root',
    parentTaskId: null,
    directory: '/workspace',
    sequence: index,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: `Task ${index}`,
    prompt: `Run task ${index}.`,
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: 1_000 + index,
    timeoutAt: null,
  }),
  status,
  ...(status === 'queued' ? {} : { startedAt: 2_000 + index }),
  ...(['completed', 'failed', 'aborted', 'interrupted'].includes(status)
    ? { finishedAt: 3_000 + index }
    : {}),
  ...overrides,
});

const projectedTask = (...args: Parameters<typeof taskRecord>) => (
  toManagedTaskEvent(taskRecord(...args)).properties.task
);

/** What the store holds for a wire record from a host without the recovery fields. */
const withRecoveryDefaults = (task: ManagedTaskEventRecord): ManagedTaskProjectedRecord => ({
  ...task,
  recoveryLineageId: null,
  childPromptedAt: null,
  firstAssistantPartAt: null,
});

const taskEvent = (task: ManagedTaskProjectedRecord, resultEnvelope?: ManagedTaskEvent['properties']['resultEnvelope']): ManagedTaskEvent => ({
  type: 'openchamber:managed-task',
  properties: {
    owner: 'devryan',
    directory: task.directory,
    task,
    ...(resultEnvelope ? { resultEnvelope } : {}),
  },
});

const removalEvent = (task: ManagedTaskEventRecord, sequence = task.sequence): ManagedTaskRemovalEvent => ({
  type: 'openchamber:managed-task-removed',
  properties: {
    owner: 'devryan',
    taskId: task.taskId,
    rootSessionId: task.rootSessionId,
    directory: task.directory,
    sequence,
  },
});

const emptySnapshot = (overrides: Partial<ManagedOrchestrationSnapshot> = {}): ManagedOrchestrationSnapshot => ({
  available: true,
  bridgeReady: true,
  recoveryWarning: null,
  tasks: [],
  resultEnvelopes: [],
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

const fakeApi = (overrides: Partial<ManagedOrchestrationApi> = {}): ManagedOrchestrationApi => ({
  async handoff() { throw new Error('not implemented'); },
  async getSnapshot() { return emptySnapshot(); },
  async getTask() { throw new Error('not implemented'); },
  async cancelTask() { throw new Error('not implemented'); },
  async acknowledgeTask() { throw new Error('not implemented'); },
  async setAutoResume() { throw new Error('not implemented'); },
  ...overrides,
});

const autoResumeBlock = (overrides: Partial<ManagedTaskAutoResume> = {}): ManagedTaskAutoResume => ({
  revision: 1,
  enabled: true,
  state: 'scheduled',
  cancelGeneration: 0,
  lineageStartedAt: 4_000,
  expiresAt: 40_000,
  attemptCount: 0,
  noSignalProbes: 0,
  rejectionsInWindow: 0,
  windowResetAt: null,
  nextAttemptAt: 10_000,
  resetAt: 9_000,
  resetSource: 'opencode_status',
  target: { kind: 'backup', providerId: 'anthropic', modelId: 'claude-sonnet-5', variant: null },
  lastAttemptTaskId: null,
  lastAttemptAt: null,
  lastError: null,
  hostFailures: 0,
  reason: null,
  ...overrides,
});

/** A usage-limit failure with a resumable, unacknowledged envelope. */
const usageLimitFailure = () => {
  const failed = taskRecord(1, 'failed', {
    childSessionId: 'ses_child',
    failureReason: 'usage limit reached',
    partial: true,
    recoverablePreview: 'Partial result',
  });
  const envelope = createManagedTaskResultEnvelope(failed, {
    sequence: 1,
    createdAt: 4_000,
    resumable: true,
  });
  const projected = {
    ...toManagedTaskEvent(failed, envelope).properties.task,
    failureKind: 'provider_usage_limit' as const,
    agentRetryAvailable: false,
  };
  return { projected, envelope };
};

describe('managed orchestration store', () => {
  test('indexes the latest task lineage by exact child session and falls back after compaction', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const initial = projectedTask(1, 'running', { childSessionId: 'ses_child' });
    const followUp = projectedTask(2, 'running', {
      childSessionId: 'ses_child',
      agent: 'fixer',
      attempt: 2,
      priorTaskId: initial.taskId,
      executionKind: 'resume',
    });

    store.getState().ingestEvent(taskEvent(initial));
    expect(managedOrchestrationSelectors.latestTaskForChildSession('ses_child')(
      store.getState(),
    )).toBe(store.getState().tasksById[initial.taskId]);
    expect(managedOrchestrationSelectors.latestTaskAgentForChildSession('ses_child')(
      store.getState(),
    )).toBe('explorer');

    store.getState().ingestEvent(taskEvent(followUp));
    expect(store.getState().latestTaskIdByChildSessionId.ses_child).toBe(followUp.taskId);
    expect(managedOrchestrationSelectors.latestTaskForChildSession('ses_child')(
      store.getState(),
    )).toBe(store.getState().tasksById[followUp.taskId]);
    expect(managedOrchestrationSelectors.latestTaskAgentForChildSession('ses_child')(
      store.getState(),
    )).toBe('fixer');

    store.getState().ingestEvent(removalEvent(followUp));
    expect(managedOrchestrationSelectors.latestTaskForChildSession('ses_child')(
      store.getState(),
    )).toBe(store.getState().tasksById[initial.taskId]);
    expect(managedOrchestrationSelectors.latestTaskAgentForChildSession('ses_child')(
      store.getState(),
    )).toBe('explorer');

    store.getState().ingestEvent(removalEvent(initial));
    expect(managedOrchestrationSelectors.latestTaskForChildSession('ses_child')(
      store.getState(),
    )).toBe(undefined);
    expect(store.getState().latestTaskIdByChildSessionId.ses_child).toBe(undefined);
    expect(managedOrchestrationSelectors.latestTaskAgentForChildSession('ses_child')(
      store.getState(),
    )).toBe(undefined);
  });

  test('builds the latest child-task index from an authoritative snapshot', async () => {
    const first = projectedTask(1, 'running', { childSessionId: 'ses_child' });
    const second = projectedTask(2, 'running', {
      childSessionId: 'ses_child',
      attempt: 2,
      priorTaskId: first.taskId,
      executionKind: 'resume',
    });
    const store = createManagedOrchestrationStore({
      api: fakeApi({ getSnapshot: async () => emptySnapshot({ tasks: [first, second] }) }),
    });

    await store.getState().loadSnapshot();

    expect(managedOrchestrationSelectors.latestTaskForChildSession('ses_child')(
      store.getState(),
    )).toBe(store.getState().tasksById[second.taskId]);
  });

  test('indexes parallel same-label dispatches by exact root and call identity', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const first = projectedTask(1, 'running', {
      dispatchCallId: 'call_parallel_first',
      label: 'Inspect runtime',
    });
    const second = projectedTask(2, 'completed', {
      dispatchCallId: 'call_parallel_second',
      label: 'Inspect runtime',
    });

    store.getState().ingestEvent(taskEvent(first));
    store.getState().ingestEvent(taskEvent(second));

    expect(managedOrchestrationSelectors.taskIdForDispatchCall(
      'ses_root',
      'call_parallel_first',
    )(store.getState())).toBe(first.taskId);
    expect(managedOrchestrationSelectors.taskIdForDispatchCall(
      'ses_root',
      'call_parallel_second',
    )(store.getState())).toBe(second.taskId);
    expect(managedOrchestrationSelectors.taskIdForDispatchCall(
      'ses_other',
      'call_parallel_first',
    )(store.getState())).toBe(undefined);
  });

  test('indexes the first grouped usage-limit failure for immediate manual recovery', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const failed = {
      ...taskRecord(1, 'failed', {
        childSessionId: 'ses_child_exhausted',
        failureReason: 'Usage limit reached',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: true,
    });
    const projected = toManagedTaskEvent(failed, envelope).properties.task;

    store.getState().ingestEvent(taskEvent(projected, envelope));

    expect(projected.agentRetryAvailable).toBe(false);
    expect(projected.failureKind).toBe('provider_usage_limit');
    expect(managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession('ses_child_exhausted')(
      store.getState(),
    )).toBe(failed.taskId);
    expect(managedOrchestrationSelectors.manualRecoveryFailureKindForChildSession('ses_child_exhausted')(
      store.getState(),
    )).toBe('provider_usage_limit');
    expect(managedOrchestrationSelectors.hasManualRecoveryForRoot('ses_root')(
      store.getState(),
    )).toBe(true);
    expect(managedOrchestrationSelectors.hasManualRecoveryForRoot('ses_other')(
      store.getState(),
    )).toBe(false);

    store.getState().ingestEvent(taskEvent(projected, {
      ...envelope,
      acknowledgedAt: 5_000,
      action: 'retry_in_place',
      followUpTaskId: 'dvr_task_2',
    }));
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_exhausted).toBe(undefined);
    expect(managedOrchestrationSelectors.manualRecoveryFailureKindForChildSession('ses_child_exhausted')(
      store.getState(),
    )).toBeNull();
    expect(managedOrchestrationSelectors.hasManualRecoveryForRoot('ses_root')(
      store.getState(),
    )).toBe(false);

    const replacementFailed = {
      ...taskRecord(2, 'failed', {
        childSessionId: 'ses_child_exhausted',
        failureReason: 'Replacement model failed',
        attempt: 2,
        priorTaskId: failed.taskId,
        executionKind: 'retry_in_place',
        providerId: 'openai',
        modelId: 'gpt-5.4',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const replacementEnvelope = createManagedTaskResultEnvelope(replacementFailed, {
      sequence: 2,
      createdAt: 6_000,
      resumable: true,
    });
    const replacementProjected = toManagedTaskEvent(
      replacementFailed,
      replacementEnvelope,
    ).properties.task;

    store.getState().ingestEvent(taskEvent(replacementProjected, replacementEnvelope));
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_exhausted).toBe(
      replacementFailed.taskId,
    );
    expect(managedOrchestrationSelectors.hasManualRecoveryForRoot('ses_root')(
      store.getState(),
    )).toBe(true);
  });

  test('accepts deadline recovery metadata and keeps ungrouped ordinary failures out of Model Recovery', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const deadline = {
      ...taskRecord(2, 'failed', {
        childSessionId: 'ses_child_deadline',
        failureReason: 'Managed task timed out at 3000',
        attempt: 2,
        priorTaskId: 'dvr_task_1',
        executionKind: 'resume',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const deadlineEnvelope = createManagedTaskResultEnvelope(deadline, {
      sequence: 1,
      createdAt: 4_000,
      resumable: true,
    });
    const deadlineProjection = toManagedTaskEvent(deadline, deadlineEnvelope).properties.task;
    store.getState().ingestEvent(taskEvent(deadlineProjection, deadlineEnvelope));

    expect({
      dispatchGrouped: store.getState().tasksById[deadline.taskId]?.dispatchGrouped,
      failureKind: store.getState().tasksById[deadline.taskId]?.failureKind,
    }).toEqual({
      dispatchGrouped: true,
      failureKind: 'deadline_exceeded',
    });
    expect(managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession(
      'ses_child_deadline',
    )(store.getState())).toBe(deadline.taskId);

    const ungrouped = taskRecord(3, 'failed', {
      childSessionId: 'ses_child_ungrouped',
      failureReason: 'Provider connection ended',
      attempt: 2,
      priorTaskId: 'dvr_task_ungrouped_1',
      executionKind: 'resume',
    });
    const ungroupedEnvelope = createManagedTaskResultEnvelope(ungrouped, {
      sequence: 2,
      createdAt: 4_100,
      resumable: true,
    });
    const ungroupedProjection = toManagedTaskEvent(ungrouped, ungroupedEnvelope).properties.task;
    store.getState().ingestEvent(taskEvent(ungroupedProjection, ungroupedEnvelope));

    expect(ungroupedProjection.dispatchGrouped).toBe(false);
    expect(managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession(
      'ses_child_ungrouped',
    )(store.getState())).toBe(undefined);
  });

  test('does not index exhausted provider prompt rejection for same-child recovery', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const failed = {
      ...taskRecord(1, 'failed', {
        childSessionId: 'ses_child_prompt_rejected',
        failureReason: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.',
        attempt: 2,
        priorTaskId: 'dvr_task_prompt_rejected_initial',
        executionKind: 'retry',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: true,
    });
    const projected = toManagedTaskEvent(failed, envelope).properties.task;

    store.getState().ingestEvent(taskEvent(projected, envelope));

    expect(projected.failureKind).toBe('provider_prompt_rejected');
    expect(projected.agentRetryAvailable).toBe(false);
    expect(managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession('ses_child_prompt_rejected')(
      store.getState(),
    )).toBe(undefined);
    expect(managedOrchestrationSelectors.hasManualRecoveryForRoot('ses_root')(
      store.getState(),
    )).toBe(false);
  });

  test('keeps manual recovery indexed for every failed sibling child', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const tasks = [
      {
        ...taskRecord(1, 'failed', {
          agent: 'designer',
          childSessionId: 'ses_child_designer',
          failureReason: 'Usage limit reached',
        }),
        dispatchGroupId: 'msg_parent',
      },
      {
        ...taskRecord(2, 'failed', {
          agent: 'fixer',
          childSessionId: 'ses_child_fixer_a',
          failureReason: 'Managed task timed out',
          attempt: 2,
          priorTaskId: 'dvr_task_fixer_a_initial',
          executionKind: 'resume',
        }),
        dispatchGroupId: 'msg_parent',
      },
      {
        ...taskRecord(3, 'failed', {
          agent: 'fixer',
          childSessionId: 'ses_child_fixer_b',
          failureReason: 'Managed task timed out',
          attempt: 2,
          priorTaskId: 'dvr_task_fixer_b_initial',
          executionKind: 'resume',
        }),
        dispatchGroupId: 'msg_parent',
      },
    ];
    const projected = tasks.map((task, index) => {
      const envelope = createManagedTaskResultEnvelope(task, {
        sequence: index + 1,
        createdAt: 4_000 + index,
        resumable: true,
      });
      const taskProjection = toManagedTaskEvent(task, envelope).properties.task;
      store.getState().ingestEvent(taskEvent(taskProjection, envelope));
      return { envelope, task, taskProjection };
    });

    expect(store.getState().manualRecoveryTaskIdByChildSessionId).toEqual({
      ses_child_designer: tasks[0].taskId,
      ses_child_fixer_a: tasks[1].taskId,
      ses_child_fixer_b: tasks[2].taskId,
    });

    store.getState().ingestEvent(taskEvent(projected[1].taskProjection, {
      ...projected[1].envelope,
      acknowledgedAt: 5_000,
      action: 'retry_in_place',
      followUpTaskId: 'dvr_task_fixer_a_manual',
    }));

    expect(store.getState().manualRecoveryTaskIdByChildSessionId).toEqual({
      ses_child_designer: tasks[0].taskId,
      ses_child_fixer_b: tasks[2].taskId,
    });
  });

  test('indexes only final manual recovery and clears or restores it with the envelope lifecycle', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const firstFailed = {
      ...taskRecord(1, 'failed', {
        childSessionId: 'ses_child_initial',
        failureReason: 'Provider connection ended',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const firstEnvelope = createManagedTaskResultEnvelope(firstFailed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: true,
    });
    const firstProjected = toManagedTaskEvent(firstFailed, firstEnvelope).properties.task;
    store.getState().ingestEvent(taskEvent(firstProjected, firstEnvelope));

    expect(firstProjected.agentRetryAvailable).toBe(true);
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_initial).toBe(undefined);

    const finalFailed = {
      ...taskRecord(2, 'failed', {
        childSessionId: 'ses_child_final',
        failureReason: 'Provider connection ended',
        attempt: 2,
        priorTaskId: firstFailed.taskId,
        executionKind: 'retry',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const finalEnvelope = createManagedTaskResultEnvelope(finalFailed, {
      sequence: 2,
      createdAt: 5_000,
      resumable: true,
    });
    const finalProjected = toManagedTaskEvent(finalFailed, finalEnvelope).properties.task;
    store.getState().ingestEvent(taskEvent(finalProjected, finalEnvelope));

    expect(finalProjected.agentRetryAvailable).toBe(false);
    expect(managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession('ses_child_final')(
      store.getState(),
    )).toBe(finalFailed.taskId);
    const recoveryIndex = store.getState().manualRecoveryTaskIdByChildSessionId;
    const rootIds = store.getState().taskIdsByRootId.ses_root;
    const finalTaskReference = store.getState().tasksById[finalFailed.taskId];

    store.getState().ingestEvent(taskEvent(projectedTask(9)));

    expect(store.getState().manualRecoveryTaskIdByChildSessionId).toBe(recoveryIndex);
    expect(store.getState().taskIdsByRootId.ses_root).toBe(rootIds);
    expect(store.getState().tasksById[finalFailed.taskId]).toBe(finalTaskReference);

    store.getState().ingestEvent(taskEvent(finalProjected, {
      ...finalEnvelope,
      acknowledgedAt: 6_000,
      action: 'retry_in_place',
      followUpTaskId: 'dvr_task_3',
    }));
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_final).toBe(undefined);

    const manualRunning = toManagedTaskEvent({
      ...taskRecord(3, 'running', {
        childSessionId: 'ses_child_final',
        attempt: 3,
        priorTaskId: finalFailed.taskId,
        executionKind: 'retry_in_place',
        providerId: 'openai',
        modelId: 'gpt-5.4',
      }),
      dispatchGroupId: 'msg_parent',
    }).properties.task;
    store.getState().ingestEvent(taskEvent(manualRunning));
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_final).toBe(undefined);

    const manualFailed = {
      ...taskRecord(3, 'failed', {
        childSessionId: 'ses_child_final',
        failureReason: 'Replacement model failed',
        attempt: 3,
        priorTaskId: finalFailed.taskId,
        executionKind: 'retry_in_place',
        providerId: 'openai',
        modelId: 'gpt-5.4',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const manualEnvelope = createManagedTaskResultEnvelope(manualFailed, {
      sequence: 3,
      createdAt: 7_000,
      resumable: true,
    });
    const manualProjected = toManagedTaskEvent(manualFailed, manualEnvelope).properties.task;
    store.getState().ingestEvent(taskEvent(manualProjected, manualEnvelope));
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_final).toBe(manualFailed.taskId);

    store.getState().ingestEvent(removalEvent(manualProjected));
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_final).toBe(undefined);
  });

  test('rebuilds the manual recovery index from authoritative snapshots', async () => {
    const failed = {
      ...taskRecord(2, 'failed', {
        childSessionId: 'ses_child_snapshot',
        failureReason: 'Usage limit',
        attempt: 2,
        priorTaskId: 'dvr_task_1',
        executionKind: 'resume',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 2,
      createdAt: 5_000,
      resumable: true,
    });
    const projected = toManagedTaskEvent(failed, envelope).properties.task;
    let snapshot = emptySnapshot({ tasks: [projected], resultEnvelopes: [envelope] });
    const store = createManagedOrchestrationStore({
      api: fakeApi({ getSnapshot: async () => snapshot }),
    });

    await store.getState().loadSnapshot();
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_snapshot).toBe(failed.taskId);

    snapshot = emptySnapshot();
    await store.getState().loadSnapshot();
    expect(store.getState().manualRecoveryTaskIdByChildSessionId.ses_child_snapshot).toBe(undefined);
  });

  test('preserves unchanged task and unrelated-root references', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const rootTask = projectedTask(1);
    const otherTask = projectedTask(9);
    store.getState().ingestEvent(taskEvent(rootTask));
    store.getState().ingestEvent(taskEvent(otherTask));

    const before = store.getState();
    const rootIds = before.taskIdsByRootId.ses_root;
    const rootReference = before.tasksById.dvr_task_1;
    store.getState().ingestEvent(taskEvent({ ...otherTask, status: 'starting', startedAt: 2_009 }));

    const after = store.getState();
    expect(after.taskIdsByRootId.ses_root).toBe(rootIds);
    expect(after.tasksById.dvr_task_1).toBe(rootReference);
    store.getState().ingestEvent(taskEvent({ ...rootTask }));
    expect(store.getState().tasksById.dvr_task_1).toBe(rootReference);
  });

  test('preserves a root task-id reference for status-only updates', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    store.getState().ingestEvent(taskEvent(projectedTask(1)));
    const rootIds = store.getState().taskIdsByRootId.ses_root;

    store.getState().ingestEvent(taskEvent(projectedTask(1, 'starting')));

    expect(store.getState().taskIdsByRootId.ses_root).toBe(rootIds);
  });

  test('accepts the live retry policy closing when a running task hits a provider limit', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const runningRecord = {
      ...taskRecord(1, 'running'),
      dispatchGroupId: 'msg_parent',
    };
    const running = toManagedTaskEvent(runningRecord).properties.task;
    const failedRecord = {
      ...runningRecord,
      status: 'failed' as const,
      finishedAt: 4_000,
      failureReason: 'Usage limit reached',
    };
    const failed = toManagedTaskEvent(failedRecord).properties.task;

    store.getState().ingestEvent(taskEvent(running));
    store.getState().ingestEvent(taskEvent(failed));

    expect(running.agentRetryAvailable).toBe(true);
    expect(failed.agentRetryAvailable).toBe(false);
    expect(store.getState().tasksById[failed.taskId]).toEqual(withRecoveryDefaults(failed));
  });

  test('rejects event attempts to mutate the queue-time execution snapshot', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const queued = projectedTask(1);
    store.getState().ingestEvent(taskEvent(queued));

    store.getState().ingestEvent(taskEvent({
      ...projectedTask(1, 'starting'),
      providerId: 'different-provider',
    }));

    expect(store.getState().tasksById.dvr_task_1).toEqual(withRecoveryDefaults(queued));
  });

  test('projects event records without retaining private or unknown fields', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const task = projectedTask(1) as ManagedTaskEventRecord & {
      prompt?: string;
      leaseToken?: string;
      unknownLargeField?: string;
    };
    task.prompt = 'private prompt';
    task.leaseToken = 'dvr_lease_private';
    task.unknownLargeField = 'x'.repeat(10_000);

    store.getState().ingestEvent(taskEvent(task));

    const stored = store.getState().tasksById.dvr_task_1 as unknown as Record<string, unknown>;
    expect(stored.dispatchGrouped).toBe(false);
    expect('prompt' in stored).toBe(false);
    expect('leaseToken' in stored).toBe(false);
    expect('unknownLargeField' in stored).toBe(false);
  });

  test('rejects stale transitions and non-regressing same-status metadata', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const startingWithChild = projectedTask(1, 'starting', { childSessionId: 'ses_child' });
    store.getState().ingestEvent(taskEvent(startingWithChild));
    const current = store.getState().tasksById.dvr_task_1;

    store.getState().ingestEvent(taskEvent(projectedTask(1, 'queued')));
    store.getState().ingestEvent(taskEvent(projectedTask(1, 'starting', { childSessionId: null })));

    expect(store.getState().tasksById.dvr_task_1).toBe(current);
    expect(store.getState().tasksById.dvr_task_1.childSessionId).toBe('ses_child');

    store.getState().ingestEvent(taskEvent(projectedTask(1, 'running', { childSessionId: 'ses_child' })));
    expect(store.getState().tasksById.dvr_task_1.status).toBe('running');
  });

  test('keeps the root barrier locked through active work and undispositioned terminal results', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const selector = managedOrchestrationSelectors.hasUndispositionedTasksForRoot('ses_root');

    expect(selector(store.getState())).toBe(false);
    store.getState().ingestEvent(taskEvent(projectedTask(1, 'running', {
      childSessionId: 'ses_child',
    })));
    expect(selector(store.getState())).toBe(true);

    const completedRecord = taskRecord(1, 'completed', {
      childSessionId: 'ses_child',
      finishedAt: 2_000,
    });
    const completed = toManagedTaskEvent(completedRecord).properties.task;
    const envelope = createManagedTaskResultEnvelope(completedRecord, {
      sequence: 1,
      createdAt: 2_000,
      resumable: false,
    });
    store.getState().ingestEvent(taskEvent(completed, envelope));
    expect(selector(store.getState())).toBe(true);

    store.getState().ingestEvent(taskEvent(completed, {
      ...envelope,
      action: 'continue',
      acknowledgedAt: 2_100,
    }));
    expect(selector(store.getState())).toBe(false);
  });

  test('projects a scalar root delegation phase across parallel startup, running, and disposition', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const selector = managedOrchestrationSelectors.delegationPhaseForRoot('ses_root');

    expect(selector(store.getState())).toBeNull();
    store.getState().ingestEvent(taskEvent(projectedTask(1, 'queued')));
    store.getState().ingestEvent(taskEvent(projectedTask(2, 'starting', {
      childSessionId: 'ses_child_2',
    })));
    expect(selector(store.getState())).toBe('starting');

    store.getState().ingestEvent(taskEvent(projectedTask(1, 'running', {
      childSessionId: 'ses_child_1',
    })));
    expect(selector(store.getState())).toBe('waiting');

    const terminalStore = createManagedOrchestrationStore({ api: fakeApi() });
    const completedRecord = taskRecord(3, 'completed', {
      childSessionId: 'ses_child_3',
      finishedAt: 4_000,
    });
    const completed = toManagedTaskEvent(completedRecord).properties.task;
    const envelope = createManagedTaskResultEnvelope(completedRecord, {
      sequence: 3,
      createdAt: 4_000,
      resumable: false,
    });
    terminalStore.getState().ingestEvent(taskEvent(completed, envelope));
    expect(selector(terminalStore.getState())).toBe('waiting');

    terminalStore.getState().ingestEvent(taskEvent(completed, {
      ...envelope,
      action: 'continue',
      acknowledgedAt: 4_100,
    }));
    expect(selector(terminalStore.getState())).toBeNull();
  });

  test('reconciles a late snapshot without overwriting a newer event', async () => {
    const snapshot = deferred<ManagedOrchestrationSnapshot>();
    const store = createManagedOrchestrationStore({
      api: fakeApi({ getSnapshot: async () => snapshot.promise }),
    });
    const queued = projectedTask(1);
    store.getState().ingestEvent(taskEvent(queued));

    const load = store.getState().loadSnapshot();
    store.getState().ingestEvent(taskEvent(projectedTask(1, 'running', {
      childSessionId: 'ses_child',
    })));
    snapshot.resolve(emptySnapshot({ tasks: [queued] }));
    await load;

    expect(store.getState().tasksById.dvr_task_1.status).toBe('running');
    expect(store.getState().snapshotError).toBeNull();
  });

  test('does not resurrect a task removed while its snapshot was in flight', async () => {
    const failed = taskRecord(1, 'failed', {
      failureReason: 'Provider failed',
      partial: true,
      recoverablePreview: 'Partial result',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: false,
    });
    const projected = toManagedTaskEvent(failed, envelope).properties.task;
    const snapshot = deferred<ManagedOrchestrationSnapshot>();
    const store = createManagedOrchestrationStore({
      api: fakeApi({ getSnapshot: async () => snapshot.promise }),
    });
    store.getState().ingestEvent(taskEvent(projected, envelope));

    const load = store.getState().loadSnapshot();
    store.getState().ingestEvent(removalEvent(projected));
    snapshot.resolve(emptySnapshot({ tasks: [projected], resultEnvelopes: [envelope] }));
    await load;

    expect(store.getState().tasksById.dvr_task_1).toBe(undefined);
  });

  test('rejects malformed snapshots without deleting known-good state', async () => {
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        getSnapshot: async () => ({
          available: true,
          bridgeReady: true,
          recoveryWarning: null,
          tasks: [{ ...projectedTask(1), startedAt: Number.NaN }],
          resultEnvelopes: [],
        }),
      }),
    });
    const existing = projectedTask(1, 'running', { childSessionId: 'ses_child' });
    store.getState().ingestEvent(taskEvent(existing));
    const stored = store.getState().tasksById.dvr_task_1;

    await store.getState().loadSnapshot();

    expect(store.getState().tasksById.dvr_task_1).toBe(stored);
    expect(store.getState().snapshotError).toBe('Managed orchestration returned an invalid snapshot');
  });

  test('clears an authoritative recovery warning', async () => {
    let recoveryWarning: string | null = 'Interrupted tasks were restored';
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        getSnapshot: async () => emptySnapshot({ recoveryWarning }),
      }),
    });

    await store.getState().loadSnapshot();
    expect(store.getState().recoveryWarning).toBe('Interrupted tasks were restored');
    recoveryWarning = null;
    await store.getState().loadSnapshot();
    expect(store.getState().recoveryWarning).toBeNull();
  });

  test('keeps loading true for current requests after an older generation settles', async () => {
    const oldLoad = deferred<ManagedOrchestrationSnapshot>();
    const currentRootLoad = deferred<ManagedOrchestrationSnapshot>();
    const currentGlobalLoad = deferred<ManagedOrchestrationSnapshot>();
    let call = 0;
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        getSnapshot: async () => {
          call += 1;
          if (call === 1) return oldLoad.promise;
          if (call === 2) return currentRootLoad.promise;
          return currentGlobalLoad.promise;
        },
      }),
    });

    const obsolete = store.getState().loadSnapshot();
    store.getState().reset();
    const root = store.getState().loadSnapshot({ rootSessionId: 'ses_root' });
    const global = store.getState().loadSnapshot();
    oldLoad.resolve(emptySnapshot());
    await obsolete;
    currentRootLoad.resolve(emptySnapshot());
    await root;

    expect(store.getState().isLoadingSnapshot).toBe(true);
    currentGlobalLoad.resolve(emptySnapshot());
    await global;
    expect(store.getState().isLoadingSnapshot).toBe(false);
  });

  test('reconciles a large snapshot in one store update', async () => {
    const tasks = Array.from({ length: 50 }, (_, index) => projectedTask(index + 1));
    const store = createManagedOrchestrationStore({
      api: fakeApi({ getSnapshot: async () => emptySnapshot({ tasks }) }),
    });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });

    await store.getState().loadSnapshot();
    unsubscribe();

    expect(Object.keys(store.getState().tasksById)).toHaveLength(50);
    expect(notifications).toBe(3);
  });

  test('rejects a snapshot whose result envelope contradicts its task', async () => {
    const failed = taskRecord(1, 'failed', {
      failureReason: 'Provider failed',
      partial: true,
      recoverablePreview: 'Partial result',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: false,
    });
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        getSnapshot: async () => emptySnapshot({
          tasks: [toManagedTaskEvent(failed).properties.task],
          resultEnvelopes: [{ ...envelope, rootSessionId: 'ses_other' }],
        }),
      }),
    });

    await store.getState().loadSnapshot();

    expect(store.getState().tasksById).toEqual({});
    expect(store.getState().snapshotError).toBe('Managed orchestration returned an invalid snapshot');
  });

  test('keeps task state authoritative during duplicate cancellation', async () => {
    const cancellation = deferred<Awaited<ReturnType<ManagedOrchestrationApi['cancelTask']>>>();
    let calls = 0;
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        cancelTask: async () => {
          calls += 1;
          return cancellation.promise;
        },
      }),
    });
    const running = projectedTask(1, 'running', { childSessionId: 'ses_child' });
    store.getState().ingestEvent(taskEvent(running));

    const first = store.getState().cancelTask('dvr_task_1');
    const second = store.getState().cancelTask('dvr_task_1');
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(store.getState().tasksById.dvr_task_1.status).toBe('running');
    expect(store.getState().pendingActionByTaskId.dvr_task_1).toBe('cancel');

    const aborted = projectedTask(1, 'aborted', {
      childSessionId: 'ses_child',
      failureReason: 'Stopped by user',
      partial: true,
      recoverablePreview: 'Useful work',
    });
    cancellation.resolve({ task: aborted });
    await Promise.all([first, second]);
    expect(store.getState().tasksById.dvr_task_1.status).toBe('aborted');
    expect(store.getState().tasksById.dvr_task_1.recoverablePreview).toBe('Useful work');
    expect(store.getState().pendingActionByTaskId.dvr_task_1).toBe(undefined);
  });

  test('allows retry after a transport throws synchronously', async () => {
    let calls = 0;
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        cancelTask: (() => {
          calls += 1;
          throw new Error('synchronous bridge failure');
        }) as ManagedOrchestrationApi['cancelTask'],
      }),
    });
    store.getState().ingestEvent(taskEvent(projectedTask(1, 'running', { childSessionId: 'ses_child' })));

    await store.getState().cancelTask('dvr_task_1');
    await store.getState().cancelTask('dvr_task_1');

    expect(calls).toBe(2);
    expect(store.getState().actionErrorByTaskId.dvr_task_1).toBe('synchronous bridge failure');
  });

  test('rejects a malformed cascade response without partially applying it', async () => {
    const running = projectedTask(1, 'running', { childSessionId: 'ses_child' });
    const aborted = projectedTask(1, 'aborted', {
      childSessionId: 'ses_child',
      failureReason: 'Stopped by user',
      partial: true,
      recoverablePreview: 'Useful work',
    });
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        cancelTask: async () => ({
          tasks: [{ task: aborted }, { task: {} }],
        }) as unknown as Awaited<ReturnType<ManagedOrchestrationApi['cancelTask']>>,
      }),
    });
    store.getState().ingestEvent(taskEvent(running));

    await store.getState().cancelTask('dvr_task_1', { cascade: true });

    expect(store.getState().tasksById.dvr_task_1.status).toBe('running');
    expect(store.getState().actionErrorByTaskId.dvr_task_1).toBe(
      'Managed orchestration response did not include a valid task',
    );
  });

  test('retains visible action failures and reuses the idempotency key on retry', async () => {
    const failed = taskRecord(1, 'failed', {
      childSessionId: 'ses_child',
      failureReason: 'Provider failed',
      partial: true,
      recoverablePreview: 'Partial result',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: true,
    });
    const keys: string[] = [];
    let call = 0;
    const response: ManagedTaskAcknowledgementResponse = {
      resultEnvelope: {
        ...envelope,
        acknowledgedAt: 5_000,
        action: 'retry',
        followUpTaskId: 'dvr_task_2',
      },
      followUpTask: {
        task: projectedTask(2, 'queued', {
          attempt: 2,
          priorTaskId: 'dvr_task_1',
          executionKind: 'retry',
        }),
      },
    };
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        acknowledgeTask: async (_taskId, body) => {
          keys.push(body.idempotencyKey);
          call += 1;
          if (call === 1) throw new Error('temporary bridge failure');
          return response;
        },
      }),
      createIdempotencyKey: () => 'stable-retry-key',
    });
    store.getState().ingestEvent(taskEvent(toManagedTaskEvent(failed, envelope).properties.task, envelope));

    await store.getState().acknowledgeTask('dvr_task_1', 'retry');
    expect(store.getState().actionErrorByTaskId.dvr_task_1).toBe('temporary bridge failure');
    expect(store.getState().resultEnvelopesByTaskId.dvr_task_1.action).toBeNull();

    await store.getState().acknowledgeTask('dvr_task_1', 'retry');
    expect(keys).toEqual(['stable-retry-key', 'stable-retry-key']);
    expect(store.getState().actionErrorByTaskId.dvr_task_1).toBe(undefined);
    expect(store.getState().resultEnvelopesByTaskId.dvr_task_1.action).toBe('retry');
    expect(store.getState().tasksById.dvr_task_2.priorTaskId).toBe('dvr_task_1');
  });

  test('does not acknowledge a different action from a malformed response', async () => {
    const failed = taskRecord(1, 'failed', {
      failureReason: 'Provider failed',
      partial: true,
      recoverablePreview: 'Partial result',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: false,
    });
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        acknowledgeTask: async () => ({
          resultEnvelope: {
            ...envelope,
            acknowledgedAt: 5_000,
            action: 'abandon',
          },
          followUpTask: null,
        }),
      }),
    });
    store.getState().ingestEvent(taskEvent(toManagedTaskEvent(failed, envelope).properties.task, envelope));

    await store.getState().acknowledgeTask('dvr_task_1', 'retry');

    expect(store.getState().resultEnvelopesByTaskId.dvr_task_1.action).toBeNull();
    expect(store.getState().actionErrorByTaskId.dvr_task_1).toBe(
      'Managed orchestration response did not match the requested result action',
    );
  });

  test('forwards a selected model for an in-place retry', async () => {
    const failed = taskRecord(1, 'failed', {
      childSessionId: 'ses_child',
      failureReason: 'out of usage',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: true,
    });
    const receivedBodies: Array<Parameters<ManagedOrchestrationApi['acknowledgeTask']>[1]> = [];
    const followUp = projectedTask(2, 'queued', {
      childSessionId: 'ses_child',
      attempt: 2,
      priorTaskId: 'dvr_task_1',
      executionKind: 'retry_in_place',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        acknowledgeTask: async (_taskId, body) => {
          receivedBodies.push(body);
          return {
            resultEnvelope: {
              ...envelope,
              acknowledgedAt: 5_000,
              action: 'retry_in_place',
              followUpTaskId: followUp.taskId,
            },
            followUpTask: { task: followUp },
          };
        },
      }),
      createIdempotencyKey: () => 'retry-in-place-key',
    });
    store.getState().ingestEvent(taskEvent(toManagedTaskEvent(failed, envelope).properties.task, envelope));

    await store.getState().acknowledgeTask('dvr_task_1', 'retry_in_place', {
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });

    const receivedBody = receivedBodies[0];
    expect({
      action: receivedBody?.action,
      providerId: receivedBody?.providerId,
      modelId: receivedBody?.modelId,
      variant: receivedBody?.variant,
      idempotencyKey: receivedBody?.idempotencyKey,
    }).toEqual({
      action: 'retry_in_place',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
      idempotencyKey: 'retry-in-place-key',
    });
  });

  test('keeps Model Recovery pending until the same-child retry row is available', async () => {
    const failed = {
      ...taskRecord(1, 'failed', {
        childSessionId: 'ses_child',
        failureReason: 'Monthly usage limit reached',
      }),
      dispatchGroupId: 'msg_parent',
    };
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: true,
    });
    const followUp = projectedTask(2, 'running', {
      childSessionId: 'ses_child',
      attempt: 2,
      priorTaskId: failed.taskId,
      executionKind: 'retry_in_place',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      variant: 'medium',
    });
    const acknowledgement = deferred<ManagedTaskAcknowledgementResponse>();
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        acknowledgeTask: async () => acknowledgement.promise,
      }),
      createIdempotencyKey: () => 'model-recovery-key',
    });
    store.getState().ingestEvent(taskEvent(toManagedTaskEvent(failed, envelope).properties.task, envelope));

    const retry = store.getState().acknowledgeTask(failed.taskId, 'retry_in_place', {
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      variant: 'medium',
    });
    await Promise.resolve();
    expect(store.getState().pendingActionByTaskId[failed.taskId]).toBe('retry_in_place');
    expect(store.getState().resultEnvelopesByTaskId[failed.taskId].action).toBeNull();

    acknowledgement.resolve({
      resultEnvelope: {
        ...envelope,
        acknowledgedAt: 5_000,
        action: 'retry_in_place',
        followUpTaskId: followUp.taskId,
      },
      followUpTask: { task: followUp },
    });
    await retry;

    expect(store.getState().pendingActionByTaskId[failed.taskId]).toBe(undefined);
    expect(store.getState().resultEnvelopesByTaskId[failed.taskId].action).toBe('retry_in_place');
    const recoveredTask = store.getState().tasksById[followUp.taskId];
    expect({
      status: recoveredTask.status,
      childSessionId: recoveredTask.childSessionId,
      executionKind: recoveredTask.executionKind,
    }).toEqual({
      status: 'running',
      childSessionId: 'ses_child',
      executionKind: 'retry_in_place',
    });
  });

  test('removes per-task action state when an authoritative snapshot evicts the task', async () => {
    const failed = taskRecord(1, 'failed', {
      failureReason: 'Provider failed',
      partial: true,
      recoverablePreview: 'Partial result',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: false,
    });
    let snapshot = emptySnapshot({
      tasks: [toManagedTaskEvent(failed).properties.task],
      resultEnvelopes: [envelope],
    });
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        getSnapshot: async () => snapshot,
        acknowledgeTask: async () => { throw new Error('bridge offline'); },
      }),
      createIdempotencyKey: () => 'evicted-task-key',
    });
    await store.getState().loadSnapshot();
    await store.getState().acknowledgeTask('dvr_task_1', 'continue');
    expect(store.getState().actionErrorByTaskId.dvr_task_1).toBe('bridge offline');

    snapshot = emptySnapshot();
    await store.getState().loadSnapshot();

    expect(store.getState().tasksById.dvr_task_1).toBe(undefined);
    expect(store.getState().actionErrorByTaskId.dvr_task_1).toBe(undefined);
    expect(store.getState().pendingActionByTaskId.dvr_task_1).toBe(undefined);
  });

  test('removes only the exact terminal projection named by a compaction event', async () => {
    const failed = taskRecord(1, 'failed', {
      failureReason: 'Provider failed',
      partial: true,
      recoverablePreview: 'Partial result',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: false,
    });
    const projectedFailed = toManagedTaskEvent(failed, envelope).properties.task;
    const store = createManagedOrchestrationStore({
      api: fakeApi({ acknowledgeTask: async () => { throw new Error('bridge offline'); } }),
    });
    store.getState().ingestEvent(taskEvent(projectedFailed, envelope));
    store.getState().ingestEvent(taskEvent(projectedTask(9)));
    await store.getState().acknowledgeTask(projectedFailed.taskId, 'continue');
    const otherRootIds = store.getState().taskIdsByRootId.ses_other;

    store.getState().ingestEvent(removalEvent(projectedFailed, projectedFailed.sequence + 1));
    expect(store.getState().tasksById[projectedFailed.taskId]).toBeTruthy();
    store.getState().ingestEvent(removalEvent(projectedFailed));

    expect(store.getState().tasksById[projectedFailed.taskId]).toBe(undefined);
    expect(store.getState().resultEnvelopesByTaskId[projectedFailed.taskId]).toBe(undefined);
    expect(store.getState().actionErrorByTaskId[projectedFailed.taskId]).toBe(undefined);
    expect(store.getState().taskIdsByRootId.ses_root).toBe(undefined);
    expect(store.getState().taskIdsByRootId.ses_other).toBe(otherRootIds);
  });

  test('accepts an exact removal when an unobserved terminal transition was compacted', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const running = projectedTask(1, 'running', { childSessionId: 'ses_child' });
    store.getState().ingestEvent(taskEvent(running));

    store.getState().ingestEvent(removalEvent(running));

    expect(store.getState().tasksById.dvr_task_1).toBe(undefined);
  });

  test('does not let an in-flight acknowledgement resurrect a compacted task', async () => {
    const failed = taskRecord(1, 'failed', {
      failureReason: 'Provider failed',
      partial: true,
      recoverablePreview: 'Partial result',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 4_000,
      resumable: false,
    });
    const projected = toManagedTaskEvent(failed, envelope).properties.task;
    const acknowledgement = deferred<ManagedTaskAcknowledgementResponse>();
    const store = createManagedOrchestrationStore({
      api: fakeApi({ acknowledgeTask: async () => acknowledgement.promise }),
    });
    store.getState().ingestEvent(taskEvent(projected, envelope));

    const action = store.getState().acknowledgeTask(projected.taskId, 'continue');
    store.getState().ingestEvent(removalEvent(projected));
    acknowledgement.resolve({
      resultEnvelope: {
        ...envelope,
        acknowledgedAt: 5_000,
        action: 'continue',
      },
      followUpTask: null,
    });
    await action;

    expect(store.getState().tasksById[projected.taskId]).toBe(undefined);
    expect(store.getState().actionErrorByTaskId[projected.taskId]).toBe(undefined);
  });

  test('clears runtime-owned records and request state on reset', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    store.getState().ingestEvent(taskEvent(projectedTask(1)));
    store.getState().reset();
    expect(store.getState().tasksById).toEqual({});
    expect(store.getState().taskIdsByRootId).toEqual({});
    expect(store.getState().manualRecoveryTaskIdByChildSessionId).toEqual({});
    expect(store.getState().available).toBeNull();
  });

  test('normalizes missing recovery fields from older hosts to null', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const { projected, envelope } = usageLimitFailure();
    store.getState().ingestEvent(taskEvent(projected, envelope));

    const task = store.getState().tasksById[projected.taskId];
    expect(task?.recoveryLineageId).toBeNull();
    expect(task?.childPromptedAt).toBeNull();
    expect(task?.firstAssistantPartAt).toBeNull();
    const stored = store.getState().resultEnvelopesByTaskId[projected.taskId];
    expect(stored?.providerResetAt).toBeNull();
    expect(stored?.autoResume).toBeNull();
    expect(managedOrchestrationSelectors.autoResume(projected.taskId)(store.getState())).toBeNull();
    expect(managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession('ses_child')(
      store.getState(),
    )).toBe(projected.taskId);
  });

  test('merges child prompt and first assistant timestamps while a task is active and pins its lineage', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const running = {
      ...projectedTask(1, 'running', { childSessionId: 'ses_child' }),
      recoveryLineageId: 'lineage_1',
      childPromptedAt: 2_500,
      firstAssistantPartAt: null,
    };
    store.getState().ingestEvent(taskEvent(running));
    expect(store.getState().tasksById[running.taskId]).toMatchObject({
      recoveryLineageId: 'lineage_1',
      childPromptedAt: 2_500,
      firstAssistantPartAt: null,
    });

    store.getState().ingestEvent(taskEvent({ ...running, firstAssistantPartAt: 2_800 }));
    expect(store.getState().tasksById[running.taskId]?.firstAssistantPartAt).toBe(2_800);

    store.getState().ingestEvent(taskEvent({ ...running, recoveryLineageId: 'lineage_2', firstAssistantPartAt: 2_900 }));
    expect(store.getState().tasksById[running.taskId]).toMatchObject({
      recoveryLineageId: 'lineage_1',
      firstAssistantPartAt: 2_800,
    });

    store.getState().ingestEvent(taskEvent({ ...running, childPromptedAt: 'soon' as never }));
    expect(store.getState().tasksById[running.taskId]?.firstAssistantPartAt).toBe(2_800);
  });

  test('keeps auto-resume progress on an unacknowledged envelope and ignores stale revisions', () => {
    const store = createManagedOrchestrationStore({ api: fakeApi() });
    const { projected, envelope } = usageLimitFailure();
    const withAutoResume = (
      autoResume: ManagedTaskAutoResume | null,
      providerResetAt: number | null = 9_000,
    ): ManagedTaskProjectedEnvelope => ({ ...envelope, providerResetAt, autoResume });

    store.getState().ingestEvent(taskEvent(projected, withAutoResume(autoResumeBlock())));
    expect(managedOrchestrationSelectors.autoResume(projected.taskId)(store.getState())).toMatchObject({
      revision: 1,
      state: 'scheduled',
      target: { kind: 'backup', providerId: 'anthropic', modelId: 'claude-sonnet-5', variant: null },
    });
    expect(store.getState().resultEnvelopesByTaskId[projected.taskId]?.providerResetAt).toBe(9_000);

    store.getState().ingestEvent(taskEvent(
      projected,
      withAutoResume(autoResumeBlock({ revision: 2, state: 'attempting', attemptCount: 1 })),
    ));
    expect(managedOrchestrationSelectors.autoResume(projected.taskId)(store.getState())).toMatchObject({
      revision: 2,
      state: 'attempting',
      attemptCount: 1,
    });

    store.getState().ingestEvent(taskEvent(projected, withAutoResume(autoResumeBlock())));
    expect(managedOrchestrationSelectors.autoResume(projected.taskId)(store.getState())?.revision).toBe(2);

    store.getState().ingestEvent(taskEvent(projected, withAutoResume(null, null)));
    expect(managedOrchestrationSelectors.autoResume(projected.taskId)(store.getState())?.revision).toBe(2);

    const before = store.getState().resultEnvelopesByTaskId[projected.taskId];
    store.getState().ingestEvent(taskEvent(
      projected,
      withAutoResume(autoResumeBlock({ revision: 2, state: 'attempting', attemptCount: 1 })),
    ));
    expect(store.getState().resultEnvelopesByTaskId[projected.taskId]).toBe(before);

    store.getState().ingestEvent(taskEvent(
      projected,
      withAutoResume(autoResumeBlock({ revision: 2, state: 'attempting', attemptCount: 1 }), 12_000),
    ));
    expect(store.getState().resultEnvelopesByTaskId[projected.taskId]?.providerResetAt).toBe(12_000);
    expect(store.getState().resultEnvelopesByTaskId[projected.taskId]?.action).toBeNull();

    store.getState().ingestEvent(taskEvent(
      projected,
      withAutoResume({ ...autoResumeBlock({ revision: 3 }), state: 'later' as never }),
    ));
    expect(managedOrchestrationSelectors.autoResume(projected.taskId)(store.getState())?.revision).toBe(2);
  });

  test('setAutoResume posts the toggle, holds a pending action, and upserts the returned envelope', async () => {
    const { projected, envelope } = usageLimitFailure();
    const requests: Array<{ taskId: string; body: Record<string, unknown> }> = [];
    const response = deferred<ManagedTaskAutoResumeResponse>();
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        async setAutoResume(taskId, body) {
          requests.push({ taskId, body });
          return response.promise;
        },
      }),
    });
    const initial: ManagedTaskProjectedEnvelope = { ...envelope, providerResetAt: 9_000, autoResume: autoResumeBlock() };
    store.getState().ingestEvent(taskEvent(projected, initial));

    const first = store.getState().setAutoResume(projected.taskId, false);
    const second = store.getState().setAutoResume(projected.taskId, false);
    expect(second).toBe(first);
    expect(managedOrchestrationSelectors.pendingAction(projected.taskId)(store.getState())).toBe('auto_resume');

    response.resolve({
      resultEnvelope: {
        ...initial,
        autoResume: autoResumeBlock({ revision: 2, enabled: false, state: 'cancelled', cancelGeneration: 1 }),
      } as ManagedTaskAutoResumeResponse['resultEnvelope'],
    });
    await first;

    expect(requests).toEqual([{
      taskId: projected.taskId,
      body: { rootSessionId: 'ses_root', directory: '/workspace', enabled: false },
    }]);
    expect(managedOrchestrationSelectors.autoResume(projected.taskId)(store.getState())).toMatchObject({
      revision: 2,
      enabled: false,
      state: 'cancelled',
    });
    expect(managedOrchestrationSelectors.pendingAction(projected.taskId)(store.getState())).toBeUndefined();
    expect(managedOrchestrationSelectors.actionError(projected.taskId)(store.getState())).toBeUndefined();
    expect(managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession('ses_child')(
      store.getState(),
    )).toBe(projected.taskId);
  });

  test('setAutoResume surfaces host rejections and keeps the current envelope', async () => {
    const { projected, envelope } = usageLimitFailure();
    const store = createManagedOrchestrationStore({
      api: fakeApi({
        async setAutoResume() { throw new Error('auto_resume_stale'); },
      }),
    });
    const initial: ManagedTaskProjectedEnvelope = { ...envelope, providerResetAt: 9_000, autoResume: autoResumeBlock() };
    store.getState().ingestEvent(taskEvent(projected, initial));
    const before = store.getState().resultEnvelopesByTaskId[projected.taskId];

    await store.getState().setAutoResume(projected.taskId, false);

    expect(managedOrchestrationSelectors.actionError(projected.taskId)(store.getState())).toBe('auto_resume_stale');
    expect(managedOrchestrationSelectors.pendingAction(projected.taskId)(store.getState())).toBeUndefined();
    expect(store.getState().resultEnvelopesByTaskId[projected.taskId]).toBe(before);
  });

  test('setAutoResume rejects a response for a different envelope or without an auto-resume block', async () => {
    const { projected, envelope } = usageLimitFailure();
    let reply: ManagedTaskAutoResumeResponse['resultEnvelope'] = { ...envelope, envelopeId: 'dvr_result_other' };
    const store = createManagedOrchestrationStore({
      api: fakeApi({ async setAutoResume() { return { resultEnvelope: reply }; } }),
    });
    store.getState().ingestEvent(taskEvent(projected, { ...envelope, providerResetAt: null, autoResume: autoResumeBlock() } as ManagedTaskProjectedEnvelope));

    await store.getState().setAutoResume(projected.taskId, true);
    expect(managedOrchestrationSelectors.actionError(projected.taskId)(store.getState())).toContain('did not match');

    reply = { ...envelope };
    await store.getState().setAutoResume(projected.taskId, true);
    expect(managedOrchestrationSelectors.actionError(projected.taskId)(store.getState())).toContain('did not match');
    expect(managedOrchestrationSelectors.autoResume(projected.taskId)(store.getState())?.revision).toBe(1);

    await store.getState().setAutoResume('dvr_task_missing', true);
    expect(managedOrchestrationSelectors.actionError('dvr_task_missing')(store.getState())).toBe('Managed task result was not found');
  });
});
