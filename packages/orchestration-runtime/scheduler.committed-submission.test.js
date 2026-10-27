import { expect, test } from 'bun:test';
import { createManagedTaskRecord } from './index.js';
import { createManagedTaskScheduler } from './scheduler.js';

const input = { idempotencyKey: 'original', rootSessionId: 'ses_root', parentTaskId: null, directory: '/project',
  mode: 'orchestrator', providerId: 'fixture', modelId: 'fixture', agent: 'explorer', variant: null,
  label: 'Durable submission', prompt: 'Inspect the fixture', timeoutAt: null };

test('a failed starting save preserves committed start and retry receipts without duplicating admission', async () => {
  let saved, failStarting = true, ids = 0, starts = 0;
  const warnings = [], timers = new Map();
  const scheduler = createManagedTaskScheduler({
    createTaskId: () => `dvr_task_${++ids}`, logger: { warn: (...args) => warnings.push(args) },
    scheduleTimeout: (callback, delay) => { const timer = { callback, delay }; timers.set(timer, timer); return timer; },
    cancelTimeout: timer => timers.delete(timer),
    persistence: { load: async () => null, save: async state => {
      if (failStarting && state.tasks.some(task => task.status === 'starting')) throw Error('fixture_starting_save_failed');
      saved = structuredClone(state);
    } },
    executor: { start: async (_task, control) => {
      starts++; await control.markAccepted();
      return { status: 'failed', failureReason: 'Fixture partial result', partial: true, recoverablePreview: 'Retained findings' };
    } },
  });
  try {
    const committed = await scheduler.submit(input);
    expect(committed.status).toBe('queued');
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0].taskId).toBe(committed.taskId);
    expect(starts).toBe(0);
    expect(warnings).toEqual([['[ManagedOrchestration] Committed task launch admission failed', { taskId: committed.taskId }]]);
    expect(timers.size).toBe(1);
    failStarting = false;
    expect((await scheduler.submit(input)).taskId).toBe(committed.taskId);
    await scheduler.waitForTask(committed.taskId);
    expect(ids).toBe(1); expect(starts).toBe(1);
    failStarting = true;
    const receipt = await scheduler.acknowledgeResult(committed.taskId, { action: 'retry', idempotencyKey: 'retry-original' });
    expect(receipt.envelope.action).toBe('retry');
    expect(saved.tasks).toHaveLength(2);
    expect(saved.tasks.find(task => task.taskId === receipt.followUpTask.taskId).status).toBe('queued');
    expect(saved.resultEnvelopes.find(result => result.taskId === committed.taskId).followUpTaskId).toBe(receipt.followUpTask.taskId);
    expect(starts).toBe(1);
    expect((await scheduler.acknowledgeResult(committed.taskId, { action: 'retry', idempotencyKey: 'retry-original' })).followUpTask.taskId).toBe(receipt.followUpTask.taskId);
    expect(ids).toBe(2);
  } finally { await scheduler.shutdown(); }
});

test('an earlier durable launch runs when a later queued sibling cannot save starting state', async () => {
  const tasks = [1, 2].map(sequence => createManagedTaskRecord({ ...input, taskId: `dvr_task_${sequence}`,
    idempotencyKey: `queued-${sequence}`, sequence, createdAt: sequence, attempt: 1, priorTaskId: null, executionKind: 'start' }));
  let saved = { version: 1, tasks, resultEnvelopes: [] };
  const starts = [];
  const scheduler = createManagedTaskScheduler({ persistence: { load: async () => saved, save: async state => {
    if (state.tasks.find(task => task.taskId === 'dvr_task_2')?.status === 'starting') throw Error('fixture_later_start_failed');
    saved = structuredClone(state);
  } }, executor: { start: async (task, control) => {
    starts.push(task.taskId); await control.markAccepted(); return { status: 'completed', recoverablePreview: 'First task completed' };
  } } });
  try {
    await expect(scheduler.initialize()).rejects.toThrow('fixture_later_start_failed');
    await scheduler.waitForTask('dvr_task_1');
    expect(starts).toEqual(['dvr_task_1']);
    expect(saved.tasks.find(task => task.taskId === 'dvr_task_1').status).toBe('completed');
    expect(saved.tasks.find(task => task.taskId === 'dvr_task_2').status).toBe('queued');
  } finally { await scheduler.shutdown(); }
});

test('a start receipt never exposes a proposed running state while its save remains unsettled', async () => {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { entered = resolve; });
  const scheduler = createManagedTaskScheduler({ persistence: { load: async () => null, save: async state => {
    if (state.tasks.some(task => task.status === 'running')) { entered(); await held; }
  } }, executor: { start: async (_task, control) => {
    await control.markAccepted(); return { status: 'completed', recoverablePreview: 'Retained completion' };
  } } });
  try {
    const submission = scheduler.submit(input);
    await saving;
    const receipt = await submission;
    expect(receipt.status).toBe('starting');
    expect(scheduler.getTask(receipt.taskId).status).toBe('starting');
    release();
    expect((await scheduler.waitForTask(receipt.taskId)).status).toBe('completed');
  } finally { release(); await scheduler.shutdown(); }
});
