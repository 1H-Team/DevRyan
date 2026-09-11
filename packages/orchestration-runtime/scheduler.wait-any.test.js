import { describe, expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './scheduler.js';
import { createManagedWaitCursor, managedResultCollectionState, resolveManagedWaitCursor } from './managed-wait.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const createHarness = async (count = 3, extra = {}) => {
  let nextId = 0;
  let saved = null;
  let aborts = 0;
  const runs = new Map();
  const timers = new Map();
  let timerId = 0;
  const persistence = {
    load: async () => saved,
    save: async (value) => { saved = structuredClone(value); },
  };
  const start = async (task, control) => {
    const run = deferred();
    runs.set(task.taskId, run);
    await control.setChildSessionId(task.childSessionId ?? `ses_child_${task.taskId}`);
    await control.markAccepted();
    return run.promise;
  };
  const scheduler = createManagedTaskScheduler({
    persistence,
    createTaskId: () => `dvr_task_any_${++nextId}`,
    createLeaseToken: () => `dvr_lease_any_${nextId}`,
    scheduleTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    cancelTimeout: (id) => timers.delete(id),
    executor: {
      start,
      retryInPlace: start,
      async abort() { aborts += 1; return { aborted: true }; },
    },
    ...extra,
  });
  const tasks = [];
  for (let i = 0; i < count; i += 1) tasks.push(await scheduler.submit({
    idempotencyKey: `any-${i}`, rootSessionId: 'ses_root', parentTaskId: null,
    directory: '/workspace', mode: 'orchestrator', providerId: 'fixture', modelId: 'model',
    agent: 'explorer', variant: null, label: `Task ${i}`, prompt: `Unique scope ${i}`,
    dispatchGroupId: 'msg_user', timeoutAt: null,
  }));
  await scheduler.flush();
  const request = { rootSessionId: 'ses_root', taskIds: tasks.map((task) => task.taskId) };
  const finish = async (index) => {
    runs.get(tasks[index].taskId).resolve({ status: 'completed', recoverablePreview: `Result ${index}` });
    await scheduler.waitForTask(tasks[index].taskId);
    await scheduler.flush();
  };
  return { scheduler, tasks, request, finish, runs, timers, persistence, aborts: () => aborts, saved: () => saved };
};

const parkTask = async (h) => {
  const failure = { status: 'failed', failureReason: 'Usage limit reached', resumable: true, recoverablePreview: 'Partial work' };
  h.runs.get(h.tasks[0].taskId).resolve(failure);
  await h.scheduler.waitForTask(h.tasks[0].taskId);
  await h.scheduler.flush();
  return h.tasks[0].taskId;
};

describe('managed wait any', () => {
  test('resets a large prior selection when the requested set shrinks, while rejecting foreign roots', () => {
    const previousIds = Array.from({ length: 500 }, (_, index) => `dvr_task_cursor_${index}`);
    const envelope = { sequence: 10, envelopeId: 'dvr_result_cursor' };
    const cursor = createManagedWaitCursor('ses_root', envelope, previousIds);
    expect(cursor.length).toBeGreaterThan(4096);
    expect(resolveManagedWaitCursor(cursor, 'ses_root', [envelope], previousIds.slice(0, 1)))
      .toEqual({ sequence: 0, reset: true });
    expect(() => resolveManagedWaitCursor(cursor, 'ses_other', [envelope], previousIds.slice(0, 1)))
      .toThrow('another root');
    const malformed = `dvr_wait_v2:${encodeURIComponent(JSON.stringify(['ses_root', 10, envelope.envelopeId, [{}]]))}`;
    expect(() => resolveManagedWaitCursor(malformed, 'ses_root', [envelope], previousIds.slice(0, 1)))
      .toThrow('must be a managed wait cursor');
  });

  test('does not repeatedly deliver unchanged attention while another selected child runs', async () => {
    const h = await createHarness(2);
    let next;
    try {
      const parked = await parkTask(h);
      const request = { ...h.request, taskIds: [parked, h.tasks[1].taskId] };
      const first = await h.scheduler.waitForAnyTask(request);
      expect(first.attention).toEqual([{ taskId: parked, state: 'attention' }]);
      next = h.scheduler.waitForAnyTask({ ...request, afterCursor: first.cursor });
      void next.catch(() => {});
      await h.scheduler.flush();
      expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(1);
      await h.finish(1);
      expect((await next).readyTaskIds).toEqual([h.tasks[1].taskId]);
      expect(h.aborts()).toBe(0);
    } finally { await h.scheduler.shutdown(); await next?.catch(() => {}); }
  });

  test('resets a cursor when the selected task set changes so older ready results are discoverable', async () => {
    const h = await createHarness(2);
    try {
      await h.finish(0);
      await h.finish(1);
      const first = await h.scheduler.waitForAnyTask({ ...h.request, taskIds: [h.tasks[1].taskId] });
      const both = await h.scheduler.waitForAnyTask({ ...h.request, afterCursor: first.cursor });
      expect(both.cursorReset).toBe(true);
      expect(both.readyTaskIds).toEqual(h.request.taskIds);
    } finally { await h.scheduler.shutdown(); }
  });

  test('persists meaningful same-envelope changes while ignoring automatic recovery rescheduling', async () => {
    const h = await createHarness(2, { autoResume: {
      resolveOwnerKey: async () => 'fixture-owner', resolveBackupExecution: async () => null,
      resolveProviderReset: async () => Date.now() + 60_000, attempt: async () => ({ outcome: 'unavailable' }),
    } });
    let next, watch, restored;
    try {
      const parked = await parkTask(h);
      const initial = await h.scheduler.waitForAnyTask(h.request);
      expect(initial.attention).toEqual([{ taskId: parked, state: 'scheduled' }]);
      const sequence = h.scheduler.getResultEnvelope(parked).sequence;
      const watched = await h.scheduler.waitForResultCommit({ directory: '/workspace' });
      watch = h.scheduler.waitForResultCommit({ directory: '/workspace', afterCursor: watched.cursor });
      next = h.scheduler.waitForAnyTask({ ...h.request, afterCursor: initial.cursor });
      void watch.catch(() => {}); void next.catch(() => {});
      await h.scheduler.flush();
      for (const callback of [...h.timers.values()]) callback();
      for (let round = 0; round < 6; round++) { await Promise.resolve(); await h.scheduler.flush(); }
      expect(h.scheduler.getResultEnvelope(parked).autoResume.state).toBe('scheduled');
      expect(h.scheduler.getResultEnvelope(parked).sequence).toBe(sequence);
      expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(2);
      await h.scheduler.setResultAutoResume(parked, { enabled: false });
      const changed = await next;
      expect(changed.changedTaskIds).toEqual([parked]);
      expect(changed.attention).toEqual([{ taskId: parked, state: 'attention' }]);
      expect(changed.cursorReset).toBe(false);
      expect((await watch).rootSessionIds).toEqual(['ses_root']);
      expect(h.saved().resultEnvelopes.find(envelope => envelope.taskId === parked).sequence).toBeGreaterThan(sequence);
      const scoped = { rootSessionId: 'ses_root', taskIds: [parked] };
      const last = await h.scheduler.waitForAnyTask(scoped);
      const persisted = { ...h.saved(), tasks: [h.scheduler.getTask(parked)], resultEnvelopes: [h.scheduler.getResultEnvelope(parked)] };
      restored = createManagedTaskScheduler({ persistence: { load: async () => persisted, save: async () => {} }, executor: { start: async () => { throw new Error('must not rerun'); } } });
      const parkedAgain = await restored.waitForAnyTask({ ...scoped, afterCursor: last.cursor });
      expect(parkedAgain).toMatchObject({ changedTaskIds: [], activeWork: false, settled: true, cursorReset: false });
      expect(parkedAgain.attention).toEqual(last.attention);
    } finally {
      await h.scheduler.shutdown(); await restored?.shutdown();
      await next?.catch(() => {}); await watch?.catch(() => {});
    }
  });

  test('does not wake for an own continue and discovers ready tasks outside the selected set', async () => {
    const h = await createHarness(3);
    let next;
    try {
      await h.finish(0);
      await h.finish(2);
      const request = { ...h.request, taskIds: h.request.taskIds.slice(0, 2) };
      const initial = await h.scheduler.waitForAnyTask(request);
      expect(initial.availableTaskIds).toEqual([h.tasks[2].taskId]);
      next = h.scheduler.waitForAnyTask({ ...request, afterCursor: initial.cursor });
      void next.catch(() => {});
      await h.scheduler.flush();
      await h.scheduler.acknowledgeResult(h.tasks[0].taskId, { action: 'continue', idempotencyKey: 'continue-fixture' });
      expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(1);
      await h.finish(1);
      expect(await next).toMatchObject({ changedTaskIds: [h.tasks[1].taskId],
        dispositioned: [{ taskId: h.tasks[0].taskId, action: 'continue', followUpTaskId: null }],
        readyTaskIds: [h.tasks[1].taskId], activeWork: false });
    } finally { await h.scheduler.shutdown(); await next?.catch(() => {}); }
  });
  test('returns the follow-up identity when the host retries a parked child in place', async () => {
    const h = await createHarness(2);
    let next;
    try {
      const parked = await parkTask(h);
      const first = await h.scheduler.waitForAnyTask(h.request);
      next = h.scheduler.waitForAnyTask({ ...h.request, afterCursor: first.cursor });
      void next.catch(() => {});
      await h.scheduler.flush();
      const retry = await h.scheduler.acknowledgeResult(parked, { action: 'retry_in_place', idempotencyKey: 'host-retry',
        providerId: 'fixture', modelId: 'model', variant: null });
      expect(await next).toMatchObject({ changedTaskIds: [parked],
        dispositioned: [{ taskId: parked, action: 'retry_in_place', followUpTaskId: retry.followUpTask.taskId }],
        pendingTaskIds: [h.tasks[1].taskId] });
    } finally { await h.scheduler.shutdown(); await next?.catch(() => {}); }
  });
  test('notifies the existing collection scan after a late durable commit and cleans up other watchers', async () => {
    const h = await createHarness(2);
    const controller = new AbortController();
    const other = h.scheduler.waitForResultCommit({ directory: '/another-project', signal: controller.signal });
    const watch = h.scheduler.waitForResultCommit({ directory: '/workspace' });
    await h.scheduler.flush();
    expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(2);
    await h.finish(1);
    const result = await watch;
    expect(result.rootSessionIds).toEqual(['ses_root']);
    expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(1);
    controller.abort(new Error('watch disposed'));
    await expect(other).rejects.toThrow('watch disposed');
    const next = h.scheduler.waitForResultCommit({ directory: '/workspace', afterCursor: result.cursor });
    await h.scheduler.flush();
    await h.finish(0);
    expect((await next).rootSessionIds).toEqual(['ses_root']);
    await expect(h.scheduler.waitForResultCommit({ directory: '/foreign', afterCursor: result.cursor })).rejects.toThrow('another root');
    expect(h.aborts()).toBe(0);
    await h.scheduler.shutdown();
  });

  test('collects an already committed result, then the next result without waiting for the slow child', async () => {
    const h = await createHarness();
    await h.finish(1);
    const first = await h.scheduler.waitForAnyTask(h.request);
    expect(first.readyTaskIds).toEqual([h.tasks[1].taskId]);
    const next = h.scheduler.waitForAnyTask({ ...h.request, afterCursor: first.cursor, timeoutMs: 25_000 });
    await h.scheduler.flush();
    expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(1);
    await h.finish(0);
    expect((await next).readyTaskIds).toEqual([h.tasks[0].taskId]);
    expect(h.scheduler.getTask(h.tasks[2].taskId).status).toBe('running');
    expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    expect(h.timers.size).toBe(0);
    expect(h.aborts()).toBe(0);
    await h.scheduler.shutdown();
  });

  test('unchanged timeout and aborted waits remove their subscriptions without cancelling work', async () => {
    const h = await createHarness();
    const wait = h.scheduler.waitForAnyTask({ ...h.request, timeoutMs: 25_000 });
    await h.scheduler.flush();
    for (const callback of [...h.timers.values()]) callback();
    const value = await wait;
    expect(value.readyTaskIds).toEqual([]);
    expect(value.pendingTaskIds).toEqual(h.request.taskIds);
    const controller = new AbortController();
    const aborted = h.scheduler.waitForAnyTask({ ...h.request, signal: controller.signal });
    await h.scheduler.flush();
    controller.abort(new Error('fixture abort'));
    await expect(aborted).rejects.toThrow('fixture abort');
    expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    expect(h.aborts()).toBe(0);
    await h.scheduler.shutdown();
  });

  test('does not expose terminal state while its envelope is still being persisted', async () => {
    const commit = deferred();
    const entered = deferred();
    const h = await createHarness(1, { persistence: {
      load: async () => null,
      save: async (value) => {
        if (value.resultEnvelopes.length) { entered.resolve(); await commit.promise; }
      },
    } });
    h.runs.get(h.tasks[0].taskId).resolve({ status: 'completed', recoverablePreview: 'Done' });
    await entered.promise;
    let delivered = false;
    const wait = h.scheduler.waitForAnyTask(h.request).then((value) => { delivered = true; return value; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    commit.resolve();
    expect((await wait).readyTaskIds).toEqual(h.request.taskIds);
    await h.scheduler.shutdown();
  });

  test('rejects cross-root tasks and cursors', async () => {
    const h = await createHarness(1);
    await expect(h.scheduler.waitForAnyTask({ ...h.request, rootSessionId: 'ses_other' })).rejects.toThrow('requested root');
    await expect(h.scheduler.waitForAnyTask({ ...h.request, afterCursor: createManagedWaitCursor('ses_other', null) })).rejects.toThrow('another root');
    await h.scheduler.shutdown();
  });

  test('retains cursor identity through restart and resets expired cursor snapshots', async () => {
    const h = await createHarness(2);
    await h.finish(0);
    await h.finish(1);
    const initial = await h.scheduler.waitForAnyTask(h.request);
    await h.scheduler.shutdown();
    const restored = createManagedTaskScheduler({ persistence: h.persistence, executor: { start: async () => { throw new Error('must not rerun'); } } });
    const next = await restored.waitForAnyTask({ ...h.request, afterCursor: initial.cursor });
    expect(next.readyTaskIds).toEqual([]);
    expect(next.unacknowledgedTaskIds).toEqual(h.request.taskIds);
    expect(next.cursorReset).toBe(false);
    const expired = createManagedWaitCursor('ses_root', { sequence: 99, envelopeId: 'dvr_result_expired' });
    expect((await restored.waitForAnyTask({ ...h.request, afterCursor: expired })).cursorReset).toBe(true);
    await restored.shutdown();
  });

  test('admits thirty children and keeps a wait subscription independent of their launch count', async () => {
    const h = await createHarness(30);
    expect(h.runs.size).toBe(30);
    const wait = h.scheduler.waitForAnyTask(h.request);
    await h.scheduler.flush();
    await h.finish(29);
    expect((await wait).readyTaskIds).toEqual([h.tasks[29].taskId]);
    expect(h.scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    await h.scheduler.shutdown();
  });

  test('parked automatic and manual recovery results are distinct from collectable results', async () => {
    const h = await createHarness(1);
    await h.finish(0);
    const task = { ...h.scheduler.getTask(h.tasks[0].taskId), status: 'failed',
      failureKind: 'provider_usage_limit', failureReason: 'Usage limit reached', attempt: 2 };
    const envelope = { ...h.scheduler.getResultEnvelope(task.taskId), action: null, resumable: true, autoResume: null };
    expect(managedResultCollectionState(task, envelope)).toBe('attention');
    expect(managedResultCollectionState(task, { ...envelope, autoResume: { enabled: true, state: 'scheduled' } })).toBe('scheduled');
    expect(managedResultCollectionState(task, { ...envelope, action: 'abandon' })).toBe('dispositioned');
    expect(managedResultCollectionState({ ...task, status: 'running' }, null)).toBe('pending');
    expect(() => resolveManagedWaitCursor('untrusted', 'ses_root', [])).toThrow();
    await h.scheduler.shutdown();
  });
});
