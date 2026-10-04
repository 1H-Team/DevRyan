import { expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './scheduler.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const input = (id, rootSessionId = 'ses_root') => ({ idempotencyKey: id, rootSessionId, parentTaskId: null,
  directory: '/workspace', mode: 'orchestrator', providerId: 'openai', modelId: 'fixture', agent: 'explorer',
  variant: null, label: id, prompt: id, timeoutAt: null });
const scope = { directory: '/workspace', sessions: ['ses_root', 'ses_child_target'], intentID: 'remove-fixture' };
const settle = value => ({ ...value, phase: 'settle', settled: { terminated: true, sessions: value.sessions }, absentSessions: [] });

test('removal fences dispatch, requires exact native settlement, and disposes only its subtree', async () => {
  const runs = new Map(), aborts = [];
  const scheduler = createManagedTaskScheduler({ abortTimeoutMs: 500, executor: {
    async start(task, control) {
      const result = deferred(); runs.set(task.taskId, result);
      await control.setChildSessionId(`ses_child_${task.label}`); await control.markAccepted();
      return result.promise;
    },
    async abort(task, options) {
      expect(options.nativeSettled).toBe(true); aborts.push(task.taskId);
      runs.get(task.taskId)?.resolve({ status: 'completed', recoverablePreview: 'late completion' });
      return { aborted: true };
    },
    async reconcile() { throw new Error('Unexpected recovery'); },
    async readRecoverableResult() { return { recoverablePreview: 'retained partial output' }; },
  } });
  try {
    const target = await scheduler.submit(input('target'));
    const foreign = await scheduler.submit(input('foreign', 'ses_foreign'));
    await scheduler.cancelSessionsForRemoval({ ...scope, phase: 'fence' });
    await expect(scheduler.verifyTaskDispatch(target.taskId, target.leaseToken)).rejects.toMatchObject({ code: 'native_managed_task_lease_invalid' });
    await expect(scheduler.submit(input('late'))).rejects.toMatchObject({ code: 'session_removal_pending' });
    await expect(scheduler.cancelSessionsForRemoval({ ...settle(scope), settled: { terminated: true, sessions: ['ses_root'] } }))
      .rejects.toMatchObject({ code: 'native_removal_settlement_required' });
    expect(aborts).toEqual([]);
    await expect(scheduler.cancelSessionsForRemoval(settle(scope))).resolves.toEqual({ settled: true, sessions: scope.sessions, taskIDs: [target.taskId] });
    expect(scheduler.getTask(target.taskId)).toMatchObject({ status: 'aborted', recoverablePreview: 'retained partial output' });
    expect(scheduler.getResultEnvelope(target.taskId)).toMatchObject({ action: 'abandon', followUpTaskId: null });
    expect(scheduler.listReadyProviderRecoveryContinuations({ sessionId: 'ses_root' })).toEqual([]);
    expect(scheduler.getTask(foreign.taskId).status).toBe('running');
    await expect(scheduler.acknowledgeResult(target.taskId, { action: 'retry', idempotencyKey: 'retry-deleted' }))
      .rejects.toMatchObject({ code: 'session_removal_pending' });
    await scheduler.cancelSessionsForRemoval(settle(scope));
    expect(new Set(aborts)).toEqual(new Set([target.taskId]));
    await scheduler.cancelSessionsForRemoval({ ...scope, phase: 'settle', settled: null, absentSessions: scope.sessions });
    await expect(scheduler.cancelSessionsForRemoval({ ...settle(scope), absentSessions: ['ses_root'] }))
      .rejects.toMatchObject({ code: 'native_removal_settlement_required' });
  } finally {
    for (const run of runs.values()) run.resolve({ status: 'aborted' });
    await scheduler.shutdown();
  }
});

test('fence during awaited launch admission blocks the already-selected queue entry', async () => {
  const entered = deferred(), release = deferred();
  let starts = 0;
  const scheduler = createManagedTaskScheduler({
    admitLaunch: async () => { entered.resolve(); await release.promise; return { admit: true }; },
    executor: { async start() { starts++; throw new Error('must not launch'); }, async abort() { throw new Error('queued'); },
      async reconcile() { throw new Error('must not recover'); }, async readRecoverableResult() { return {}; } },
  });
  try {
    const submitting = scheduler.submit(input('waiting'));
    await entered.promise;
    const fencing = scheduler.cancelSessionsForRemoval({ ...scope, phase: 'fence' });
    release.resolve(); await Promise.all([submitting, fencing]);
    expect(starts).toBe(0);
    await scheduler.cancelSessionsForRemoval(settle(scope));
    expect(scheduler.listTasks()[0].status).toBe('aborted');
    await expect(scheduler.cancelSessionsForRemoval({ ...scope, intentID: 'foreign', phase: 'fence' }))
      .rejects.toMatchObject({ code: 'native_removal_scope_invalid' });
  } finally { release.resolve(); await scheduler.shutdown(); }
});

test('restored removal fence precedes scheduler recovery and prevents queued relaunch', async () => {
  let state;
  const persistence = { async load() { return state ?? null; }, async save(value) { state = structuredClone(value); } };
  const executor = { async start() { throw new Error('must not launch'); }, async abort() { throw new Error('queued'); },
    async reconcile() { throw new Error('must not recover'); }, async readRecoverableResult() { return {}; } };
  const prior = createManagedTaskScheduler({ persistence, executor, admitLaunch: () => ({ admit: false, reason: 'capacity', limit: 1 }) });
  await prior.submit(input('queued')); await prior.shutdown();
  const recovered = createManagedTaskScheduler({ persistence, executor });
  try {
    await recovered.cancelSessionsForRemoval({ ...scope, phase: 'fence' });
    expect(recovered.listTasks()[0].status).toBe('queued');
    await recovered.cancelSessionsForRemoval(settle(scope));
    expect(state.resultEnvelopes[0].action).toBe('abandon');
    expect(recovered.getDiagnostics().activeLaunchCount).toBe(0);
  } finally { await recovered.shutdown(); }
});
