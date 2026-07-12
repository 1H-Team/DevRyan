import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';

const input = (overrides = {}) => ({
  idempotencyKey: 'lifecycle-task',
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: 'Lifecycle task',
  prompt: 'Inspect the lifecycle.',
  timeoutAt: null,
  ...overrides,
});

describe('managed scheduler lifecycle', () => {
  test('persists child identity and acceptance before one terminal envelope', async () => {
    let taskCounter = 0;
    let leaseCounter = 0;
    let clock = 1_000;
    const snapshots = [];
    const events = [];
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(task, control) {
          expect(task.status).toBe('starting');
          await control.setChildSessionId('ses_child');
          clock = 1_100;
          await control.markAccepted();
          clock = 2_000;
          return {
            status: 'completed',
            recoverablePreview: 'Finished result',
            canonicalRefs: [{ type: 'message', id: 'msg_final' }],
          };
        },
        async abort() {},
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return { recoverablePreview: '', canonicalRefs: [] }; },
      },
      persistence: {
        async load() { return null; },
        async save(snapshot) { snapshots.push(structuredClone(snapshot)); },
      },
      now: () => clock,
      createTaskId: () => `dvr_task_${++taskCounter}`,
      createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
      publishEvent: (event) => events.push(structuredClone(event)),
    });
    await scheduler.initialize();

    const submitted = await scheduler.submit(input());
    const settled = await scheduler.waitForTask(submitted.taskId);

    expect(settled.status).toBe('completed');
    expect(settled.childSessionId).toBe('ses_child');
    expect(settled.startedAt).toBe(1_000);
    expect(settled.finishedAt).toBe(2_000);
    expect(events.map((event) => event.properties.task.status)).toEqual([
      'queued',
      'starting',
      'starting',
      'running',
      'completed',
    ]);
    expect(events.at(-1).properties.resultEnvelope).toMatchObject({
      taskId: submitted.taskId,
      status: 'completed',
    });
    expect(events.every((event) => !('prompt' in event.properties.task))).toBe(true);
    expect(snapshots.at(-1).tasks[0].prompt).toBe('Inspect the lifecycle.');

    const envelope = scheduler.getResultEnvelope(submitted.taskId);
    expect(envelope.status).toBe('completed');
    expect(envelope.partial).toBe(false);
    expect(envelope.recoverablePreview).toBe('Finished result');
    expect(envelope.canonicalRefs).toEqual([{ type: 'message', id: 'msg_final' }]);
    expect(scheduler.listResultEnvelopes()).toHaveLength(1);
  });

  test('turns executor completion before acceptance into interrupted work', async () => {
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) {
          await control.setChildSessionId('ses_unaccepted');
          return { status: 'completed', recoverablePreview: 'provider output' };
        },
        async abort() {},
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return { recoverablePreview: '', canonicalRefs: [] }; },
      },
      createTaskId: () => 'dvr_task_unaccepted',
      createLeaseToken: () => 'dvr_lease_unaccepted',
      now: () => 1_000,
    });

    const submitted = await scheduler.submit(input());
    const settled = await scheduler.waitForTask(submitted.taskId);

    expect(settled.status).toBe('interrupted');
    expect(settled.failureReason).toBe('Executor completed before provider acceptance was recorded');
    expect(settled.recoverablePreview).toBe('provider output');
  });

  test('bounds oversized provider recovery text without discarding the terminal result', async () => {
    const oversized = 'é'.repeat(40_000);
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) {
          await control.markAccepted();
          return {
            status: 'failed',
            failureReason: oversized,
            partial: true,
            recoverablePreview: oversized,
          };
        },
        async abort() {},
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_oversized_result',
      createLeaseToken: () => 'dvr_lease_oversized_result',
      now: () => 1_000,
    });

    const submitted = await scheduler.submit(input({ idempotencyKey: 'oversized-result' }));
    const settled = await scheduler.waitForTask(submitted.taskId);

    expect(settled.status).toBe('failed');
    expect(settled.partial).toBe(true);
    expect(new TextEncoder().encode(settled.failureReason).byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(new TextEncoder().encode(settled.recoverablePreview).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(settled.recoverablePreview.length).toBeGreaterThan(0);
  });
});
