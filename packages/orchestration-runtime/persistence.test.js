import { describe, expect, test } from 'bun:test';

import { createManagedTaskRecord } from './contract.js';
import { createManagedTaskResultEnvelope } from './result-envelope.js';
import {
  DEFAULT_MANAGED_LEDGER_MAX_BYTES,
  DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS,
  DEFAULT_MANAGED_TERMINAL_MAX_RECORDS,
  MAX_RETAINED_LINEAGE_RECORDS,
  compactManagedOrchestrationState,
} from './persistence.js';

const task = (index, overrides = {}) => ({
  ...createManagedTaskRecord({
    taskId: `dvr_task_${index}`,
    idempotencyKey: `persist-${index}`,
    rootSessionId: 'ses_root',
    parentTaskId: null,
    directory: '/workspace',
    sequence: index,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: `Persist ${index}`,
    prompt: `Persist task ${index}.`,
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: index,
    timeoutAt: null,
  }),
  ...overrides,
});

const terminal = (index, overrides = {}) => task(index, {
  status: 'completed',
  childSessionId: `ses_child_${index}`,
  leaseToken: `dvr_lease_${index}`,
  startedAt: index,
  finishedAt: index,
  ...overrides,
});

const state = (tasks, envelopeOverrides = {}) => ({
  version: 1,
  tasks,
  resultEnvelopes: tasks
    .filter((entry) => ['completed', 'failed', 'aborted', 'interrupted'].includes(entry.status))
    .map((entry, index) => ({
      ...createManagedTaskResultEnvelope(entry, {
        sequence: index + 1,
        createdAt: entry.finishedAt ?? entry.createdAt,
        resumable: false,
      }),
      ...(envelopeOverrides[entry.taskId] ?? {}),
    })),
});

const acknowledged = (followUpTaskId = null) => ({
  acknowledgedAt: 50,
  action: followUpTaskId ? 'retry_in_place' : 'continue',
  followUpTaskId,
});

const activeAutoResume = (overrides = {}) => ({
  autoResume: {
    revision: 2,
    enabled: true,
    state: 'scheduled',
    cancelGeneration: 0,
    lineageStartedAt: 10,
    expiresAt: 10 + 6 * 60 * 60 * 1_000,
    nextAttemptAt: 900,
    target: { kind: 'original', providerId: 'github-copilot', modelId: 'gpt-4.1', variant: null },
    ...overrides,
  },
});

const tightCaps = {
  now: 100,
  maxTerminalRecords: 0,
  maxAgeMs: 0,
  maxBytes: Number.POSITIVE_INFINITY,
};

describe('managed orchestration ledger compaction', () => {
  test('exports the approved production bounds', () => {
    expect(DEFAULT_MANAGED_TERMINAL_MAX_RECORDS).toBe(2_000);
    expect(DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS).toBe(90 * 24 * 60 * 60 * 1_000);
    expect(DEFAULT_MANAGED_LEDGER_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  test('removes the oldest unreferenced terminal records to meet the count cap', () => {
    const input = state([
      terminal(1),
      terminal(2),
      terminal(3),
      terminal(4),
    ]);

    const result = compactManagedOrchestrationState(input, {
      now: 10,
      maxTerminalRecords: 2,
      maxAgeMs: Number.POSITIVE_INFINITY,
      maxBytes: Number.POSITIVE_INFINITY,
    });

    expect(result.state.tasks.map((entry) => entry.taskId)).toEqual(['dvr_task_3', 'dvr_task_4']);
    expect(result.state.resultEnvelopes.map((entry) => entry.taskId)).toEqual(['dvr_task_3', 'dvr_task_4']);
    expect(result.removedTaskIds).toEqual(['dvr_task_1', 'dvr_task_2']);
    expect(input.tasks).toHaveLength(4);
  });

  test('never removes nonterminal work or retained attempt lineage', () => {
    const original = terminal(1);
    const retry = terminal(2, {
      priorTaskId: original.taskId,
      attempt: 2,
      executionKind: 'retry',
    });
    const running = task(3, {
      status: 'running',
      leaseToken: 'dvr_lease_running',
      startedAt: 3,
    });
    const removable = terminal(4);

    const result = compactManagedOrchestrationState(state([original, retry, running, removable]), {
      now: 100,
      maxTerminalRecords: 1,
      maxAgeMs: 1,
      maxBytes: 1,
    });

    expect(result.state.tasks.map((entry) => entry.taskId)).toEqual([
      original.taskId,
      retry.taskId,
      running.taskId,
    ]);
    expect(result.removedTaskIds).toEqual([removable.taskId]);
    expect(result.overLimit).toBe(true);
  });

  test('releases attempt lineage once its newest member has been acknowledged', () => {
    const original = terminal(1);
    const retry = terminal(2, { priorTaskId: original.taskId, attempt: 2, executionKind: 'retry' });
    const input = state([original, retry], {
      [original.taskId]: acknowledged(retry.taskId),
      [retry.taskId]: acknowledged(),
    });

    const result = compactManagedOrchestrationState(input, tightCaps);

    expect(result.removedTaskIds).toEqual([original.taskId, retry.taskId]);
    expect(result.overLimit).toBe(false);
  });

  test('protects an auto-resuming result and its lineage from every cap', () => {
    const original = terminal(1, { status: 'failed', failureReason: 'out of usage' });
    const parked = terminal(2, {
      status: 'failed',
      failureReason: 'out of usage',
      priorTaskId: original.taskId,
      attempt: 2,
      executionKind: 'retry_in_place',
      recoveryLineageId: 'dvr_lineage_1',
    });
    const disabled = terminal(3, { status: 'failed', failureReason: 'out of usage' });
    const input = state([original, parked, disabled], {
      [original.taskId]: acknowledged(parked.taskId),
      [parked.taskId]: acknowledged(),
      [disabled.taskId]: activeAutoResume({ enabled: false, state: 'cancelled' }),
    });
    input.resultEnvelopes[1] = { ...input.resultEnvelopes[1], ...activeAutoResume(), action: null, acknowledgedAt: null, followUpTaskId: null };

    const result = compactManagedOrchestrationState(input, tightCaps);

    expect(result.state.tasks.map((entry) => entry.taskId)).toEqual([original.taskId, parked.taskId]);
    expect(result.removedTaskIds).toEqual([disabled.taskId]);
  });

  test('eagerly bounds acknowledged lineage records while keeping the parked task and its prior hop', () => {
    expect(MAX_RETAINED_LINEAGE_RECORDS).toBe(3);
    const lineageId = 'dvr_lineage_1';
    const chain = [terminal(1, { status: 'failed', failureReason: 'out of usage' })];
    for (let index = 2; index <= 6; index += 1) {
      chain.push(terminal(index, {
        status: 'failed',
        failureReason: 'out of usage',
        priorTaskId: `dvr_task_${index - 1}`,
        attempt: index,
        executionKind: 'retry_in_place',
        recoveryLineageId: lineageId,
      }));
    }
    const overrides = Object.fromEntries(chain.slice(0, -1).map((task, index) => (
      [task.taskId, acknowledged(chain[index + 1].taskId)]
    )));
    const input = state(chain, overrides);
    input.resultEnvelopes[5] = { ...input.resultEnvelopes[5], ...activeAutoResume() };

    const relaxed = compactManagedOrchestrationState(input, {
      now: 100,
      maxTerminalRecords: Number.POSITIVE_INFINITY,
      maxAgeMs: Number.POSITIVE_INFINITY,
      maxBytes: Number.POSITIVE_INFINITY,
    });
    // Five acknowledged records; the parked task's prior hop is exempt, so the
    // pool is 1-4 and only the oldest falls outside the retained three.
    expect(relaxed.removedTaskIds).toEqual(['dvr_task_1']);
    expect(relaxed.state.tasks.map((entry) => entry.taskId)).toEqual([
      'dvr_task_2', 'dvr_task_3', 'dvr_task_4', 'dvr_task_5', 'dvr_task_6',
    ]);

    const tight = compactManagedOrchestrationState(input, tightCaps);
    expect(tight.removedTaskIds).toEqual(['dvr_task_1']);
    expect(tight.overLimit).toBe(true);
  });

  test('never compacts a grouped terminal result before disposition', () => {
    const grouped = terminal(1, { dispatchGroupId: 'msg_parent' });
    const removable = terminal(2);

    const result = compactManagedOrchestrationState(state([grouped, removable]), {
      now: 100,
      maxTerminalRecords: 0,
      maxAgeMs: 0,
      maxBytes: Number.POSITIVE_INFINITY,
    });

    expect(result.state.tasks.map((entry) => entry.taskId)).toEqual([grouped.taskId]);
    expect(result.removedTaskIds).toEqual([removable.taskId]);
    expect(result.overLimit).toBe(true);
  });

  test('ages out old unreferenced terminal history before the count limit is reached', () => {
    const day = 24 * 60 * 60 * 1_000;
    const old = terminal(1, { finishedAt: day });
    const recent = terminal(2, { finishedAt: 100 * day });

    const result = compactManagedOrchestrationState(state([old, recent]), {
      now: 100 * day,
      maxTerminalRecords: 10,
      maxAgeMs: 90 * day,
      maxBytes: Number.POSITIVE_INFINITY,
    });

    expect(result.removedTaskIds).toEqual([old.taskId]);
    expect(result.state.tasks.map((entry) => entry.taskId)).toEqual([recent.taskId]);
  });

  test('uses UTF-8 serialized bytes and removes terminal records until under the byte cap', () => {
    const first = terminal(1, { recoverablePreview: 'é'.repeat(100) });
    const second = terminal(2, { recoverablePreview: 'é'.repeat(100) });
    const initial = state([first, second]);
    const oneRecordBytes = new TextEncoder().encode(JSON.stringify(state([second]))).byteLength;

    const result = compactManagedOrchestrationState(initial, {
      now: 10,
      maxTerminalRecords: 10,
      maxAgeMs: Number.POSITIVE_INFINITY,
      maxBytes: oneRecordBytes,
    });

    expect(result.state.tasks.map((entry) => entry.taskId)).toEqual([second.taskId]);
    expect(result.serializedBytes).toBeLessThanOrEqual(oneRecordBytes);
    expect(result.overLimit).toBe(false);
  });
});
