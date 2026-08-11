import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createManagedTaskRecord,
  toManagedTaskEvent,
  type ManagedTaskEventRecord,
  type ManagedTaskResultAction,
  type ManagedTaskResultEnvelope,
  type ManagedTaskStatus,
  type ManagedTaskTerminalStatus,
} from '@openchamber/orchestration-runtime';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import type { ManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';
import {
  getLatestCompactionBoundaryAt,
  hasCompactionPart,
  isCompactionBoundaryMessage,
  selectCompactionCarryoverTaskIds,
} from './managedTaskCompactionProjection';

const ROOT_SESSION_ID = 'ses_root';
const BOUNDARY_AT = 2_000;

const message = (
  id: string,
  createdAt: number,
  parts: Part[],
): { info: Message; parts: Part[] } => ({
  info: {
    id,
    sessionID: ROOT_SESSION_ID,
    role: 'user',
    time: { created: createdAt },
    agent: 'orchestrator',
    model: { providerID: 'provider', modelID: 'model' },
  } as Message,
  parts,
});

const task = ({
  taskId,
  createdAt,
  status = 'running',
  priorTaskId = null,
}: {
  taskId: string;
  createdAt: number;
  status?: ManagedTaskStatus;
  priorTaskId?: string | null;
}): ManagedTaskEventRecord => {
  const record = createManagedTaskRecord({
    taskId,
    idempotencyKey: taskId,
    rootSessionId: ROOT_SESSION_ID,
    parentTaskId: null,
    directory: '/workspace',
    sequence: createdAt,
    mode: 'orchestrator',
    providerId: 'provider',
    modelId: 'model',
    agent: 'explorer',
    variant: null,
    label: taskId,
    prompt: 'Inspect.',
    attempt: priorTaskId ? 2 : 1,
    priorTaskId,
    executionKind: priorTaskId ? 'retry' : 'start',
    createdAt,
    timeoutAt: null,
  });

  return toManagedTaskEvent({
    ...record,
    status,
    childSessionId: 'ses_child',
    startedAt: createdAt,
    finishedAt: status === 'running' ? null : createdAt + 10,
    partial: status !== 'completed',
  }).properties.task;
};

const envelope = (
  projectedTask: ManagedTaskEventRecord,
  action: ManagedTaskResultAction | null = null,
): ManagedTaskResultEnvelope => {
  if (
    projectedTask.status === 'queued'
    || projectedTask.status === 'starting'
    || projectedTask.status === 'running'
  ) {
    throw new TypeError('A result envelope requires a terminal task');
  }

  const createdAt = projectedTask.finishedAt ?? projectedTask.createdAt;
  return {
    owner: 'devryan',
    envelopeId: `dvr_result_${projectedTask.taskId}`,
    taskId: projectedTask.taskId,
    rootSessionId: projectedTask.rootSessionId,
    parentTaskId: projectedTask.parentTaskId,
    childSessionId: projectedTask.childSessionId,
    directory: projectedTask.directory,
    sequence: projectedTask.sequence,
    status: projectedTask.status as ManagedTaskTerminalStatus,
    partial: projectedTask.partial,
    failureReason: projectedTask.failureReason,
    attempt: projectedTask.attempt,
    priorTaskId: projectedTask.priorTaskId,
    executionKind: projectedTask.executionKind,
    recoverablePreview: projectedTask.recoverablePreview,
    canonicalRefs: projectedTask.canonicalRefs,
    resumable: projectedTask.status !== 'completed',
    createdAt,
    acknowledgedAt: action === null ? null : createdAt + 1,
    action,
    followUpTaskId: null,
  };
};

const state = (
  tasks: ManagedTaskEventRecord[],
  envelopes: ManagedTaskResultEnvelope[] = [],
): ManagedOrchestrationStore => ({
  tasksById: Object.fromEntries(tasks.map((entry) => [entry.taskId, entry])),
  taskIdsByRootId: { [ROOT_SESSION_ID]: tasks.map((entry) => entry.taskId) },
  latestTaskIdByChildSessionId: {},
  resultEnvelopesByTaskId: Object.fromEntries(envelopes.map((entry) => [entry.taskId, entry])),
  manualRecoveryTaskIdByChildSessionId: {},
  available: true,
  bridgeReady: true,
  recoveryWarning: null,
  isLoadingSnapshot: false,
  snapshotError: null,
  pendingActionByTaskId: {},
  actionErrorByTaskId: {},
  ingestEvent: () => undefined,
  loadSnapshot: async () => undefined,
  cancelTask: async () => undefined,
  acknowledgeTask: async () => undefined,
  reset: () => undefined,
});

describe('managed task compaction continuity', () => {
  test('mounts the continuity card after blockers and before the live status row', () => {
    const chatContainerSource = readFileSync(
      fileURLToPath(new URL('./ChatContainer.tsx', import.meta.url)),
      'utf8',
    );
    const continuitySource = readFileSync(
      fileURLToPath(new URL('./ManagedTaskCompactionContinuity.tsx', import.meta.url)),
      'utf8',
    );
    // Pending questions render inside the composer (ChatInput); permissions are
    // the remaining in-viewport blockers ahead of the continuity card.
    const blockerIndex = chatContainerSource.indexOf('sessionPermissions.length > 0 && (');
    const continuityIndex = chatContainerSource.indexOf('<ManagedTaskCompactionContinuity');
    const statusIndex = chatContainerSource.indexOf('<StatusRowContainer', continuityIndex);

    expect(blockerIndex).toBeGreaterThan(-1);
    expect(continuityIndex).toBeGreaterThan(blockerIndex);
    expect(statusIndex).toBeGreaterThan(continuityIndex);
    expect(chatContainerSource).toContain('getLatestCompactionBoundaryAt(sessionMessages)');
    expect(continuitySource).toContain('data-managed-task-continuity="compaction"');
    expect(continuitySource).toContain("onContentChange('structural')");
    expect(continuitySource).toContain('<ManagedTaskList');
    expect(continuitySource).toContain('useShallow');
  });

  test('recognizes native and exact-command compaction boundaries', () => {
    const native = message('msg_native', 100, [{ type: 'compaction' } as Part]);
    const command = message('msg_command', 200, [{ type: 'text', text: ' /compact ' } as Part]);
    const prose = message('msg_prose', 300, [{ type: 'text', text: 'Please run /compact now' } as Part]);

    expect(hasCompactionPart(native)).toBe(true);
    expect(isCompactionBoundaryMessage(command)).toBe(true);
    expect(isCompactionBoundaryMessage(prose)).toBe(false);
  });

  test('uses the latest valid compaction timestamp and otherwise fails closed', () => {
    expect(getLatestCompactionBoundaryAt([
      message('msg_first', 100, [{ type: 'compaction' } as Part]),
      message('msg_text', 150, [{ type: 'text', text: 'ordinary' } as Part]),
      message('msg_latest', 300, [{ type: 'compaction' } as Part]),
    ])).toBe(300);
    expect(getLatestCompactionBoundaryAt([
      message('msg_text', 150, [{ type: 'text', text: 'ordinary' } as Part]),
    ])).toBeNull();
  });

  test('keeps active and terminal-unacknowledged tasks that predate compaction', () => {
    const running = task({ taskId: 'dvr_task_running', createdAt: 1_000 });
    const completed = task({
      taskId: 'dvr_task_completed',
      createdAt: 1_100,
      status: 'completed',
    });

    expect(selectCompactionCarryoverTaskIds(
      state([running, completed], [envelope(completed)]),
      ROOT_SESSION_ID,
      BOUNDARY_AT,
    )).toEqual(['dvr_task_running', 'dvr_task_completed']);
  });

  test('removes a terminal task after authoritative disposition', () => {
    const completed = task({
      taskId: 'dvr_task_completed',
      createdAt: 1_000,
      status: 'completed',
    });

    expect(selectCompactionCarryoverTaskIds(
      state([completed], [envelope(completed, 'continue')]),
      ROOT_SESSION_ID,
      BOUNDARY_AT,
    )).toEqual([]);
  });

  test('does not absorb a genuinely new task created after compaction', () => {
    const freshTask = task({ taskId: 'dvr_task_fresh', createdAt: 2_100 });

    expect(selectCompactionCarryoverTaskIds(
      state([freshTask]),
      ROOT_SESSION_ID,
      BOUNDARY_AT,
    )).toEqual([]);
  });

  test('keeps a post-compaction retry whose lineage began before compaction', () => {
    const original = task({
      taskId: 'dvr_task_original',
      createdAt: 1_000,
      status: 'failed',
    });
    const retry = task({
      taskId: 'dvr_task_retry',
      createdAt: 2_100,
      priorTaskId: original.taskId,
    });

    expect(selectCompactionCarryoverTaskIds(
      state([original, retry], [envelope(original, 'retry')]),
      ROOT_SESSION_ID,
      BOUNDARY_AT,
    )).toEqual(['dvr_task_retry']);
  });

  test('fails closed for missing or cyclic post-compaction ancestry', () => {
    const missing = task({
      taskId: 'dvr_task_missing',
      createdAt: 2_100,
      priorTaskId: 'dvr_task_unknown',
    });
    const cycleA = {
      ...task({
        taskId: 'dvr_task_cycle_a',
        createdAt: 2_200,
        priorTaskId: 'dvr_task_cycle_b',
      }),
      priorTaskId: 'dvr_task_cycle_b',
    };
    const cycleB = {
      ...task({
        taskId: 'dvr_task_cycle_b',
        createdAt: 2_300,
        priorTaskId: 'dvr_task_cycle_a',
      }),
      priorTaskId: 'dvr_task_cycle_a',
    };

    expect(selectCompactionCarryoverTaskIds(
      state([missing, cycleA, cycleB]),
      ROOT_SESSION_ID,
      BOUNDARY_AT,
    )).toEqual([]);
  });

  test('uses the requested root index and rejects corrupt cross-root records', () => {
    const projectedTask = {
      ...task({ taskId: 'dvr_task_wrong_root', createdAt: 1_000 }),
      rootSessionId: 'ses_other',
    };

    expect(selectCompactionCarryoverTaskIds(
      state([projectedTask]),
      ROOT_SESSION_ID,
      BOUNDARY_AT,
    )).toEqual([]);
    expect(selectCompactionCarryoverTaskIds(
      state([]),
      ROOT_SESSION_ID,
      null,
    )).toEqual([]);
  });
});
