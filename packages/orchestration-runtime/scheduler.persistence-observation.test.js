import { expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './scheduler.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const input = { idempotencyKey: 'save-owner', rootSessionId: 'ses_root', parentTaskId: null, directory: '/project', mode: 'orchestrator',
  providerId: 'fixture', modelId: 'fixture', agent: 'explorer', variant: null, label: 'Observe persistence', prompt: 'Fixture', timeoutAt: null };

test.each(['sync','async'])('mutation timing observes settled queue ownership and isolates %s observer failure', async kind => {
  const entered=deferred(),release=deferred(),timings=[];let saves=0;
  const scheduler=createManagedTaskScheduler({executor:{start:async()=>({status:'completed',recoverablePreview:'Fixture result'})},
    persistence:{load:async()=>null,save:async state=>{if(state.tasks.length&&++saves===1){entered.resolve();await release.promise;}}},
    onMutationTiming:row=>{timings.push(row);if(kind==='async')return Promise.reject(Error('observer failure'));throw Error('observer failure');}});
  try{
    await scheduler.initialize();const before=timings.length;
    const first=scheduler.submit(input);await entered.promise;
    const second=scheduler.submit({...input,idempotencyKey:'timing-second'});
    expect(timings).toHaveLength(before);release.resolve();
    expect((await first).taskId).not.toBe((await second).taskId);
    expect(timings.length).toBeGreaterThan(before);
    for(const row of timings){expect(Object.isFrozen(row)).toBe(true);expect(row.waitMs).toBeGreaterThanOrEqual(0);expect(row.holdMs).toBeGreaterThanOrEqual(0);}
    expect(timings.some(row=>!row.failed)).toBe(true);
  }finally{release.resolve();await scheduler.shutdown();}
});
async function fixture({ deadline = null, terminal = true, acknowledgement = false, observer, stallMs = 100 } = {}) {
  let clock = 0, next = 0, progress, blocked = false, aborts = 0;
  const timers = new Map(), entered = deferred(), release = deferred(), result = deferred(), observations = [];
  const scheduler = createManagedTaskScheduler({ now: () => clock, ...(stallMs === null ? {} : { persistenceStallMs: stallMs }),
    scheduleTimeout: (callback, delay) => { const id = ++next; timers.set(id, { callback, at: clock + delay }); return id; },
    cancelTimeout: id => timers.delete(id), logger: { warn() {} },
    onPersistenceObservation: record => { observations.push(record); return observer?.(record); },
    persistence: { load: async () => null, save: async (state, observation) => {
      if (!blocked && (acknowledgement ? state.resultEnvelopes.some(envelope => envelope.action !== null)
        : terminal ? state.resultEnvelopes.length > 0 : state.tasks.length > 0)) {
        blocked = true; progress = observation.onProgress; entered.resolve(); await release.promise;
      }
    } },
    executor: { start: async (_task, control) => { await control.markAccepted(); return result.promise; }, abort: async () => { aborts++; return { aborted: true }; } },
  });
  await scheduler.initialize();
  const submission = scheduler.submit({ ...input, timeoutAt: deadline });
  let task;
  if (terminal) { task = await submission; await scheduler.flush(); result.resolve({ status: 'completed', recoverablePreview: 'Retained' }); }
  let acknowledgementPromise;
  if (acknowledgement) {
    await scheduler.waitForTask(task.taskId);
    acknowledgementPromise = scheduler.acknowledgeResult(task.taskId, { action: 'continue', idempotencyKey: 'ack-owned' });
    // Caller retains this promise even if the eventual physical save fails.
    acknowledgementPromise.catch(() => {});
  }
  await entered.promise;
  const advance = at => { clock = at; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); } };
  return { scheduler, task, submission, acknowledgementPromise, release, observations, advance, progress: record => progress(record), aborts: () => aborts };
}

test('a stalled terminal save reports attention outside the lock without exposing completion or abandoning its owner', async () => {
  const f = await fixture();
  expect(f.scheduler.getTask(f.task.taskId).status).toBe('running');
  expect(f.scheduler.getSnapshot().tasks[0].status).toBe('running');
  expect(f.scheduler.getResultEnvelope(f.task.taskId)).toBeNull();
  let delivered = false;
  const wait = f.scheduler.waitForAnyTask({ rootSessionId: input.rootSessionId, directory: input.directory, taskIds: [f.task.taskId] })
    .then(value => { delivered = true; return value; });
  f.advance(100);
  expect(f.observations).toEqual([expect.objectContaining({ state: 'needs_attention', reason: 'owner_progress_timeout', phase: 'queued', idleMs: 100 })]);
  expect(f.scheduler.getDiagnostics().persistence.state).toBe('needs_attention');
  expect(delivered).toBe(false);
  expect(f.aborts()).toBe(0);
  f.advance(500); expect(f.observations).toHaveLength(1);
  f.release.resolve();
  expect((await wait).readyTaskIds).toEqual([f.task.taskId]);
  expect(f.observations[1]).toMatchObject({ state: 'settled', outcome: 'committed' });
  expect(f.scheduler.getDiagnostics().persistence).toBeNull();
  await f.scheduler.shutdown();
});

test('only new completed physical boundaries renew idle time; started labels and duplicate completions do not', async () => {
  const f = await fixture();
  f.advance(80); f.progress({ phase: 'write', state: 'completed' });
  f.advance(120); f.progress({ phase: 'file_sync', state: 'started' });
  f.progress({ phase: 'queued', state: 'completed' }); f.progress({ phase: 'finalizing', state: 'completed' });
  f.advance(179); f.progress({ phase: 'write', state: 'completed' });
  expect(f.observations).toHaveLength(0);
  f.advance(180); expect(f.observations[0]).toMatchObject({ state: 'needs_attention', phase: 'file_sync', idleMs: 100 });
  f.release.resolve(); await f.scheduler.flush(); await f.scheduler.shutdown();
});

test('the production idle budget remains five minutes and emits once while the uncertain write stays owned', async () => {
  const f = await fixture({ stallMs: null });
  f.advance(299_999); expect(f.observations).toHaveLength(0);
  f.advance(300_000); expect(f.observations[0]).toMatchObject({ state: 'needs_attention', idleMs: 300_000 });
  expect(f.scheduler.getTask(f.task.taskId).status).toBe('running');
  f.release.resolve(); await f.scheduler.flush(); await f.scheduler.shutdown();
});

test('the task deadline observes a pending terminal save even with healthy I/O progress and never aborts the uncertain write', async () => {
  const f = await fixture({ deadline: 50 });
  f.advance(40); f.progress({ phase: 'file_sync', state: 'completed' });
  f.advance(50);
  expect(f.observations[0]).toMatchObject({ state: 'needs_attention', reason: 'task_deadline', idleMs: 10 });
  expect(f.scheduler.getTask(f.task.taskId).status).toBe('running'); expect(f.aborts()).toBe(0);
  f.release.resolve(); await f.scheduler.flush();
  expect(f.scheduler.getTask(f.task.taskId).status).toBe('completed');
  await f.scheduler.shutdown();
});

test.each(['sync','async'])('failed uncertain admission remains unpublished through %s observer failure', async kind => {
  const f = await fixture({ terminal: false, observer: () => { if(kind==='async')return Promise.reject(Error('diagnostic failure'));throw Error('diagnostic failure'); } });
  const rejected = f.submission.catch(error => error);
  f.advance(100);
  expect(f.scheduler.getSnapshot().tasks).toEqual([]); expect(f.aborts()).toBe(0);
  f.release.reject(Error('actual disk failure'));
  expect((await rejected).message).toBe('actual disk failure');
  expect(f.scheduler.getSnapshot().tasks).toEqual([]);
  expect(f.observations[1]).toMatchObject({ state: 'settled', outcome: 'failed' });
  await f.scheduler.shutdown();
});

test('a pending acknowledgement never leaks its action and failed persistence restores the same collectable result', async () => {
  const observed = [];
  let scheduler;
  const f = await fixture({ acknowledgement: true, observer: record => {
    if (record.state === 'settled' && record.outcome === 'failed') queueMicrotask(() => {
      observed.push(scheduler.getSnapshot().resultEnvelopes[0].action, scheduler.getResultEnvelope(record.taskId).action);
    });
  } });
  scheduler = f.scheduler;
  f.advance(100);
  expect(f.scheduler.getResultEnvelope(f.task.taskId).action).toBeNull();
  expect(f.scheduler.listResultEnvelopes()[0].action).toBeNull();
  expect(f.scheduler.getSnapshot().resultEnvelopes[0].action).toBeNull();
  f.release.reject(Error('ack disk failure'));
  await expect(f.acknowledgementPromise).rejects.toThrow('ack disk failure');
  expect(f.scheduler.getResultEnvelope(f.task.taskId).action).toBeNull();
  expect(observed).toEqual([null, null]);
  expect(f.observations.at(-1)).toMatchObject({ state: 'settled', outcome: 'failed', ownerID: f.observations[0].ownerID });
  await f.scheduler.shutdown();
});

test('terminal publication stays visible while later auto-resume bookkeeping awaits a different mandatory save', async () => {
  const entered = deferred(), release = deferred(), result = deferred();
  let blocked = false;
  const scheduler = createManagedTaskScheduler({ logger: { warn() {} },
    persistence: { load: async () => null, save: async state => {
      if (!blocked && state.resultEnvelopes.some(envelope => envelope.autoResume !== null)) {
        blocked = true; entered.resolve(); await release.promise;
      }
    } },
    executor: { start: async (_task, control) => { await control.setChildSessionId('ses_child'); await control.markAccepted(); return result.promise; },
      abort: async () => ({ aborted: true }) },
    autoResume: { attempt: async () => ({ outcome: 'deferred', retryAfterMs: 60_000 }) },
  });
  const task = await scheduler.submit({ ...input, dispatchGroupId: 'msg_parent' });
  await scheduler.flush();
  const terminal = scheduler.waitForTask(task.taskId);
  await scheduler.flush();
  result.resolve({ status: 'failed', failureReason: 'Free usage exceeded, subscribe to Go', partial: true, resumable: true, recoverablePreview: 'Durable partial result' });
  await entered.promise;
  expect((await terminal).status).toBe('failed');
  expect(scheduler.getTask(task.taskId).status).toBe('failed');
  expect(scheduler.getSnapshot().tasks[0].status).toBe('failed');
  expect(scheduler.getResultEnvelope(task.taskId)).toMatchObject({ action: null, recoverablePreview: 'Durable partial result', autoResume: null });
  release.resolve(); await scheduler.flush(); await scheduler.shutdown();
});
