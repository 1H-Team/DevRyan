import { describe, expect, it, vi } from 'vitest';
import { createWebManagedOpenCodeExecutor } from './open-code-executor.js';
import { createManagedTaskScheduler } from '@devryan/orchestration-runtime';
import { NativeCommandRefusal } from '../opencode/runtime-host/native-command-refusal.js';

const fixture = (overrides = {}) => {
  const order = [];
  const task = { taskId: 'dvr_task_test', rootSessionId: 'ses_root', leaseToken: 'dvr_lease_test', directory: '/workspace',
    providerId: 'test', modelId: 'model', agent: 'explorer', variant: null, label: 'Inspect', prompt: 'Inspect.',
    executionBackend: 'native-job', childSessionId: null, nativeJobSegments: [] };
  const nativeManagedJobs = { available: () => true,
    prepare: vi.fn(async () => { order.push('background'); }),
    activate: vi.fn(async () => { order.push('activate'); }),
    cancelSegment: vi.fn(async () => { order.push('cancel'); }),
    cancelTask: vi.fn(async () => ({ aborted: true })), ...overrides };
  const client = { generation: () => 2, sessions: {
    create: async () => ({ id: 'ses_child' }), get: async () => ({ id: 'ses_child' }),
    status: async () => ({ ses_child: { type: 'idle' } }),
    messages: async () => ({ records: [{ info: { id: 'msg_result', role: 'assistant', finish: 'stop', time: { completed: 2000 } },
      parts: [{ type: 'text', text: 'Done.' }] }] }),
  }, prompts: { prompt: vi.fn(async (_child, body) => { order.push('prompt'); expect(body.noReply).toBe(true); }) } };
  const control = { setChildSessionId: async id => { task.childSessionId = id; return true; }, markAccepted: async () => true,
    reserveNativeJobSegment: async segment => { order.push('reserve'); task.nativeJobSegments.push({ ...segment, state: 'reserved' }); return true; },
    recordNativeJobSegment: async (messageID, state) => { order.push(state); task.nativeJobSegments.find(segment => segment.messageID === messageID).state = state; return true; } };
  let lookup = () => task;
  const executor = createWebManagedOpenCodeExecutor({ openCodeClient: client, nativeManagedJobs, readManagedTask: id => lookup(id),
    pollIntervalMs: 0, idleStablePolls: 1, nativeReadyWaitMs: 40 });
  return { task, order, executor, control, client, nativeManagedJobs, setLookup: value => { lookup = value; } };
};

describe('native managed prompt transport', () => {
  it('persists the job before exposing a prompt to an active runner and preserves the classifier', async () => {
    const f = fixture();
    try {
      const result = await f.executor.start(f.task, f.control);
      expect(result).toMatchObject({ status: 'completed', recoverablePreview: 'Done.' });
      expect(f.order).toEqual(['reserve', 'background', 'prepared', 'prompt', 'activate', 'accepted']);
      const scope = f.nativeManagedJobs.prepare.mock.calls[0][0];
      expect(scope).toMatchObject({ taskId: f.task.taskId, rootSessionId: 'ses_root', sessionID: 'ses_child', leaseToken: f.task.leaseToken });
      expect(scope.jobID).toMatch(/^dvr_job_/);
      expect(scope.jobID).not.toBe('ses_child');
      expect(f.client.prompts.prompt.mock.calls[0][1].messageID).toBe(scope.messageID);
    } finally { await f.executor.shutdown(); }
  });

  it('retains uncertainty when a background commit loses its reply and cleanup is unavailable', async () => {
    const f = fixture({ prepare: async () => { throw new Error('reply lost after background commit'); },
      cancelSegment: async () => { throw new Error('controller temporarily unavailable'); } });
    try {
      await expect(f.executor.start(f.task, f.control)).rejects.toThrow('reply lost');
      expect(f.client.prompts.prompt).not.toHaveBeenCalled();
      expect(f.task.nativeJobSegments[0].state).toBe('uncertain');
    } finally { await f.executor.shutdown(); }
  });

  it('reconciles an ambiguously admitted exact prompt through activation without resubmission', async () => {
    const f = fixture(); f.client.prompts.prompt.mockImplementation(async () => { throw new Error('admission response lost'); });
    try {
      expect(await f.executor.start(f.task, f.control)).toMatchObject({ status: 'completed' });
      expect(f.client.prompts.prompt).toHaveBeenCalledTimes(1);
      expect(f.nativeManagedJobs.activate).toHaveBeenCalledTimes(1);
      expect(f.nativeManagedJobs.cancelSegment).not.toHaveBeenCalled();
      expect(f.task.nativeJobSegments[0].state).toBe('accepted');
    } finally { await f.executor.shutdown(); }
  });

  it('retains the managed barrier after lost activation until its exact input settles', async () => {
    const f = fixture({ activate: vi.fn(async () => { throw new Error('activation reply lost'); }) });
    let completed = false, messageID;
    f.client.prompts.prompt.mockImplementation(async (_child, body) => { messageID = body.messageID; });
    f.client.sessions.status = async () => ({ ses_child: { type: completed ? 'idle' : 'busy' } });
    f.client.sessions.messages = async () => ({ records: completed ? [
      { info: { id: messageID, role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', text: 'Inspect.' }] },
      { info: { id: 'msg_current', parentID: messageID, role: 'assistant', finish: 'stop', time: { created: 1001, completed: 2000 } }, parts: [{ type: 'text', text: 'Current result.' }] },
    ] : [{ info: { id: 'msg_old', role: 'assistant', finish: 'stop', time: { completed: 500 } }, parts: [{ type: 'text', text: 'Old result.' }] }] });
    const scheduler = createManagedTaskScheduler({ executor: f.executor, resolveExecutionBackend: () => 'native-job' });
    f.setLookup(id => scheduler.getTask(id));
    try {
      const task = await scheduler.submit({ ...f.task, idempotencyKey: 'uncertain', mode: 'orchestrator', dispatchGroupId: 'group' });
      await vi.waitFor(() => expect(scheduler.getTask(task.taskId).nativeJobSegments?.[0]?.state).toBe('uncertain'));
      expect(scheduler.getResultEnvelope(task.taskId)).toBeNull();
      expect(await scheduler.inspectDispatchBarrier(task.rootSessionId)).toMatchObject({ state: 'active' });
      expect(f.client.prompts.prompt).toHaveBeenCalledTimes(1);
      expect(f.nativeManagedJobs.activate).toHaveBeenCalledTimes(2);
      completed = true;
      expect(await scheduler.waitForTask(task.taskId)).toMatchObject({ status: 'completed', recoverablePreview: 'Current result.' });
    } finally { completed = true; await scheduler.shutdown(); }
  });

  it('fails closed for a persisted native task when its capability is unavailable', async () => {
    const f = fixture({ available: () => false });
    try {
      await expect(f.executor.start(f.task, f.control)).rejects.toMatchObject({ code: 'native_managed_job_unavailable' });
      expect(f.client.prompts.prompt).not.toHaveBeenCalled();
    } finally { await f.executor.shutdown(); }
  });

  it('a native-selected dispatch waits for a replacing controller instead of failing', async () => {
    let ready = false;
    const f = fixture({ available: () => ready, awaitReady: vi.fn(async () => { ready = true; return 'ready'; }) });
    f.task.timeoutAt = Date.now() + 60_000;
    try {
      expect(await f.executor.start(f.task, f.control)).toMatchObject({ status: 'completed' });
      // With a task deadline the readiness wait runs until that deadline, like count waits.
      const { timeoutMs } = f.nativeManagedJobs.awaitReady.mock.calls[0][0];
      expect(timeoutMs).toBeGreaterThan(40);
      expect(timeoutMs).toBeLessThanOrEqual(60_000);
      expect(f.order).toEqual(['reserve', 'background', 'prepared', 'prompt', 'activate', 'accepted']);
      // Launch commands carry the task deadline and Stop signal for count waits.
      expect(f.nativeManagedJobs.prepare.mock.calls[0][1]).toMatchObject({ deadlineAt: f.task.timeoutAt, signal: expect.any(AbortSignal) });
      expect(f.nativeManagedJobs.activate.mock.calls[0][1]).toMatchObject({ deadlineAt: f.task.timeoutAt });
    } finally { await f.executor.shutdown(); }
  });

  it('a native-selected dispatch without a task deadline waits the default bound', async () => {
    let ready = false;
    const f = fixture({ available: () => ready, awaitReady: vi.fn(async () => { ready = true; return 'ready'; }) });
    delete f.task.timeoutAt;
    try {
      expect(await f.executor.start(f.task, f.control)).toMatchObject({ status: 'completed' });
      expect(f.nativeManagedJobs.awaitReady).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 40 }));
    } finally { await f.executor.shutdown(); }
  });

  it.each(['unsupported', 'timeout'])('fails closed when the readiness wait answers %s', async state => {
    const f = fixture({ available: () => false, awaitReady: vi.fn(async () => state) });
    try {
      await expect(f.executor.start(f.task, f.control)).rejects.toMatchObject({ code: 'native_managed_job_unavailable' });
      expect(f.order).toEqual([]); expect(f.client.prompts.prompt).not.toHaveBeenCalled();
    } finally { await f.executor.shutdown(); }
  });

  it('re-prepares on the successor controller only while the segment is still only reserved', async () => {
    const changed = () => new NativeCommandRefusal('native_managed_job_controller_changed', 503, 'not-dispatched');
    const prepare = vi.fn().mockImplementationOnce(async () => { throw changed(); }).mockImplementation(async () => {});
    const f = fixture({ prepare, awaitReady: vi.fn(async () => 'ready') });
    try {
      expect(await f.executor.start(f.task, f.control)).toMatchObject({ status: 'completed' });
      expect(prepare).toHaveBeenCalledTimes(2); expect(f.nativeManagedJobs.cancelSegment).not.toHaveBeenCalled();
      expect(prepare.mock.calls[1][0]).toEqual(prepare.mock.calls[0][0]);
    } finally { await f.executor.shutdown(); }
    // A segment with any recorded preparation never re-prepares; it is cancelled.
    const bound = fixture({ prepare: vi.fn(async () => { bound.task.nativeJobSegments[0].state = 'uncertain'; throw changed(); }), awaitReady: vi.fn(async () => 'ready') });
    try {
      await expect(bound.executor.start(bound.task, bound.control)).rejects.toMatchObject({ code: 'native_managed_job_controller_changed' });
      expect(bound.nativeManagedJobs.prepare).toHaveBeenCalledOnce(); expect(bound.nativeManagedJobs.cancelSegment).toHaveBeenCalledOnce();
      expect(bound.client.prompts.prompt).not.toHaveBeenCalled();
    } finally { await bound.executor.shutdown(); }
  });

  it.each([{ leaseToken: 'dvr_lease_old' }, { childSessionId: 'ses_foreign' }])('refuses stale cancellation identity %j', async changed => {
    const f = fixture();
    try {
      await f.executor.start(f.task, f.control);
      expect(await f.executor.abort({ ...f.task, ...changed })).toMatchObject({ aborted: false });
      expect(f.nativeManagedJobs.cancelTask).not.toHaveBeenCalled();
    } finally { await f.executor.shutdown(); }
  });
});
