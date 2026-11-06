import { describe, expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './scheduler.js';
import { assertManagedTaskTransition } from './transitions.js';
import { compactManagedOrchestrationState } from './persistence.js';
import { createManagedTaskRecord, toManagedTaskEvent } from './contract.js';
import { createManagedTaskResultEnvelope } from './result-envelope.js';
import { decodeLedgerSnapshot, encodeLedgerSnapshot } from './codec.js';

const input = { idempotencyKey: 'native', rootSessionId: 'ses_root', parentTaskId: null, directory: '/workspace',
  mode: 'orchestrator', providerId: 'test', modelId: 'model', agent: 'explorer', variant: null, label: 'Inspect', prompt: 'Inspect.' };
const segment = { jobID: 'dvr_job_one', notificationID: 'msg_notification', messageID: 'msg_prompt' };
const terminal = () => ({ ...createManagedTaskRecord({ ...input, taskId: 'dvr_task_one', sequence: 1, createdAt: 1, timeoutAt: null,
  attempt: 1, priorTaskId: null, executionKind: 'start', executionBackend: 'native-job' }), childSessionId: 'ses_child', leaseToken: 'dvr_lease_one', status: 'completed', finishedAt: 2,
nativeJobSegments: [{ ...segment, state: 'accepted', completion: 'pending' }] });
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  throw new Error('Expected native settlement did not arrive');
};

describe('native managed job receipts', () => {
  test('keeps native fields private and round trips additive fields without changing old records', () => {
    const task = terminal(), envelope = createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: false });
    const decoded = decodeLedgerSnapshot(JSON.parse(encodeLedgerSnapshot({ version: 1, tasks: [task], resultEnvelopes: [envelope] })));
    expect(decoded.tasks[0].nativeJobSegments).toEqual(task.nativeJobSegments);
    const event = toManagedTaskEvent(task, envelope);
    expect(event.properties.task.executionBackend).toBeUndefined();
    expect(event.properties.task.nativeJobSegments).toBeUndefined();
    expect(event.properties.resultEnvelope.nativeJobSegments).toBeUndefined();
    const legacy = { ...task }; delete legacy.executionBackend; delete legacy.nativeJobSegments;
    expect(decodeLedgerSnapshot({ version: 1, tasks: [legacy], resultEnvelopes: [envelope] }).tasks[0].executionBackend).toBeUndefined();
  });

  test('permits only monotonic acknowledgement after terminal settlement', () => {
    const task = terminal(), done = { ...task, nativeJobSegments: [{ ...task.nativeJobSegments[0], completion: 'done' }] };
    expect(assertManagedTaskTransition(task, done)).toBe(done);
    expect(() => assertManagedTaskTransition(done, task)).toThrow('immutable');
    expect(() => assertManagedTaskTransition(task, { ...done, recoverablePreview: 'changed outcome' })).toThrow('immutable');
    expect(() => assertManagedTaskTransition(task, { ...done, nativeJobSegments: [{ ...done.nativeJobSegments[0], jobID: 'dvr_job_other' }] })).toThrow('immutable');
  });

  test('hard protects pending native receipts even after managed disposition and expiry', () => {
    const task = terminal(), envelope = { ...createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: false }), action: 'continue', acknowledgedAt: 3 };
    const compact = value => compactManagedOrchestrationState({ version: 1, tasks: [value], resultEnvelopes: [envelope] }, { now: 1000, maxAgeMs: 1, maxTerminalRecords: 0 });
    expect(compact(task).state.tasks).toHaveLength(1);
    expect(compact({ ...task, nativeJobSegments: [{ ...task.nativeJobSegments[0], completion: 'done' }] }).state.tasks).toHaveLength(0);
  });

  test('acknowledges only after atomic terminal persistence and fences foreign segment roots', async () => {
    let saved, release, started = false, acknowledgements = 0;
    const terminalSave = new Promise(resolve => { release = resolve; });
    const scheduler = createManagedTaskScheduler({ resolveExecutionBackend: () => 'native-job',
      persistence: { load: async () => null, save: async state => {
        if (state.tasks.some(task => task.status === 'completed') && !saved?.tasks.some(task => task.status === 'completed')) { started = true; await terminalSave; }
        saved = structuredClone(state);
      } },
      executor: { async start(task, control) {
        await control.setChildSessionId('ses_child');
        await control.reserveNativeJobSegment(segment);
        await control.recordNativeJobSegment(segment.messageID, 'prepared');
        const scope = { ...segment, taskId: task.taskId, rootSessionId: task.rootSessionId, leaseToken: task.leaseToken,
          directory: task.directory, sessionID: 'ses_child', providerId: task.providerId, modelId: task.modelId, agent: task.agent, variant: task.variant, phase: 'activate' };
        await expect(scheduler.verifyNativeJobSegment({ ...scope, rootSessionId: 'ses_foreign' })).rejects.toMatchObject({ code: 'native_managed_job_scope_invalid' });
        await control.recordNativeJobSegment(segment.messageID, 'accepted');
        await control.markAccepted(); return { status: 'completed' };
      } }, acknowledgeNativeJob: async ({ task, envelopeID }) => {
        acknowledgements += 1;
        expect(saved.tasks.find(row => row.taskId === task.taskId).status).toBe('completed');
        expect(saved.resultEnvelopes.find(row => row.envelopeId === envelopeID).action).toBeNull();
      } });
    try {
      const task = await scheduler.submit(input);
      await until(() => started);
      expect(acknowledgements).toBe(0);
      release(); await scheduler.waitForTask(task.taskId);
      await until(() => scheduler.getTask(task.taskId).nativeJobSegments[0].completion === 'done');
      expect(acknowledgements).toBe(1);
      expect(scheduler.getResultEnvelope(task.taskId).action).toBeNull();
    } finally { release(); await scheduler.shutdown(); }
  });

  test('rearms terminal pending acknowledgement after restart without launching a child', async () => {
    const task = terminal(), envelope = createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: false });
    let acknowledged = 0;
    const scheduler = createManagedTaskScheduler({ now: () => 3, executor: { start: async () => { throw new Error('unexpected launch'); } },
      persistence: { load: async () => ({ version: 1, tasks: [task], resultEnvelopes: [envelope] }), save: async () => {} },
      acknowledgeNativeJob: async () => { acknowledged += 1; } });
    try { await scheduler.initialize(); await until(() => scheduler.getTask(task.taskId).nativeJobSegments[0].completion === 'done'); expect(acknowledged).toBe(1); }
    finally { await scheduler.shutdown(); }
  });

  test('retries exact native acknowledgement when its managed receipt save fails', async () => {
    const task = terminal(), envelope = createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: false });
    task.nativeJobSegments.push({ ...segment, jobID: 'dvr_job_two', notificationID: 'msg_notification_two', messageID: 'msg_prompt_two', state: 'accepted', completion: 'pending' });
    let refuseReceipt = true;
    const timers = new Set(), calls = [];
    const scheduler = createManagedTaskScheduler({ now: () => 3, executor: { start: async () => { throw new Error('unexpected launch'); } },
      scheduleTimeout: (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; },
      cancelTimeout: timer => timers.delete(timer),
      logger: { warn() {} },
      persistence: { load: async () => ({ version: 1, tasks: [task], resultEnvelopes: [envelope] }), save: async state => {
        if (refuseReceipt && state.tasks[0].nativeJobSegments.some(row => row.completion === 'done')) { refuseReceipt = false; throw new Error('receipt write failed'); }
      } }, acknowledgeNativeJob: async ({ segment: row }) => { calls.push(row.notificationID); } });
    try {
      await scheduler.initialize(); await until(() => [...timers].some(timer => timer.delay === 5000));
      expect(scheduler.getTask(task.taskId).nativeJobSegments.every(row => row.completion === 'pending')).toBe(true);
      [...timers].find(timer => timer.delay === 5000).callback();
      await until(() => scheduler.getTask(task.taskId).nativeJobSegments.every(row => row.completion === 'done'));
      expect(calls).toEqual(['msg_notification', 'msg_notification', 'msg_notification_two']);
      expect(scheduler.getResultEnvelope(task.taskId).action).toBeNull();
    } finally { await scheduler.shutdown(); }
  });

  test('requires pending native receipts to drain before session removal may dispose its subtree', async () => {
    const task = terminal(), envelope = createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: false });
    let release, started = false, disposed = false;
    const nativeAck = new Promise(resolve => { release = resolve; });
    const scheduler = createManagedTaskScheduler({ now: () => 3, executor: { start: async () => { throw new Error('unexpected launch'); } },
      persistence: { load: async () => ({ version: 1, tasks: [task], resultEnvelopes: [envelope] }), save: async () => {} },
      acknowledgeNativeJob: async () => { started = true; await nativeAck; } });
    try {
      await scheduler.initialize(); await until(() => started);
      const scope = { directory: task.directory, sessions: [task.rootSessionId, task.childSessionId], intentID: 'removal_one' };
      await scheduler.cancelSessionsForRemoval({ ...scope, phase: 'fence' });
      const removal = scheduler.cancelSessionsForRemoval({ ...scope, phase: 'settle', settled: { terminated: true, sessions: scope.sessions } }).then(() => { disposed = true; });
      await scheduler.flush(); expect(disposed).toBe(false);
      release(); await removal;
      expect(scheduler.getTask(task.taskId).nativeJobSegments[0].completion).toBe('done');
    } finally { release(); await scheduler.shutdown(); }
  });

  test('reads only durable terminal input dispositions without activating queued work or recovery', async () => {
    const done = terminal(); done.nativeJobSegments[0].completion = 'done';
    const pending = { ...terminal(), taskId: 'dvr_task_pending', idempotencyKey: 'pending' };
    const queued = createManagedTaskRecord({ ...input, taskId: 'dvr_task_queued', idempotencyKey: 'queued', sequence: 3,
      attempt: 1, priorTaskId: null, executionKind: 'start', executionBackend: 'native-job', createdAt: 1, timeoutAt: null });
    const active = { ...queued, taskId: 'dvr_task_active', idempotencyKey: 'active', status: 'running', childSessionId: 'ses_active', leaseToken: 'dvr_lease_active' };
    let executed = 0, recovered = 0, acknowledged = 0;
    const scheduler = createManagedTaskScheduler({ now: () => 3,
      executor: { start: async () => { executed += 1; throw new Error('unexpected launch'); }, reconcile: async () => { recovered += 1; throw new Error('unexpected recovery'); } },
      persistence: { load: async () => ({ version: 1, tasks: [done, pending, queued, active], resultEnvelopes: [done, pending].map((task, index) =>
        createManagedTaskResultEnvelope(task, { sequence: index + 1, createdAt: 2, resumable: false })) }), save: async () => {} },
      acknowledgeNativeJob: async () => { acknowledged += 1; } });
    try {
      const dispositions = await scheduler.readNativeJobInputDispositions();
      expect(dispositions).toEqual([{ taskId: done.taskId, leaseToken: done.leaseToken, rootSessionId: done.rootSessionId,
        directory: done.directory, sessionID: done.childSessionId, providerId: done.providerId, modelId: done.modelId,
        agent: done.agent, variant: done.variant, messageID: segment.messageID, jobID: segment.jobID,
        notificationID: segment.notificationID, envelopeID: scheduler.getResultEnvelope(done.taskId).envelopeId }]);
      expect({ executed, recovered, acknowledged }).toEqual({ executed: 0, recovered: 0, acknowledged: 0 });
      expect(scheduler.getTask(queued.taskId).status).toBe('queued');
      dispositions[0].rootSessionId = 'ses_foreign';
      expect((await scheduler.readNativeJobInputDispositions())[0].rootSessionId).toBe(done.rootSessionId);
    } finally { await scheduler.shutdown(); }
  });

  test.each(['failed', 'aborted', 'interrupted'])('retains %s input handoff through history expiry, lineage and capacity compaction', async status => {
    const task = { ...terminal(), status }; task.nativeJobSegments[0].completion = 'done';
    const envelope = { ...createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: true }), action: 'abandon', acknowledgedAt: 3 };
    const compacted = compactManagedOrchestrationState({ version: 1, tasks: [task], resultEnvelopes: [envelope] },
      { now: 1000, maxAgeMs: 1, maxTerminalRecords: 0, maxBytes: 1 });
    expect(compacted.state.tasks).toHaveLength(1); expect(compacted.overLimit).toBe(true);
    const scheduler = createManagedTaskScheduler({ now: () => 1000,
      executor: { start: async () => { throw new Error('unexpected launch'); } },
      persistence: { load: async () => compacted.state, save: async () => {} } });
    try { expect((await scheduler.readNativeJobInputDispositions())[0]).toMatchObject({ taskId: task.taskId, messageID: segment.messageID }); }
    finally { await scheduler.shutdown(); }
  });

  test('releases retained adverse proof only under verified matching session disposal and rolls back failed persistence', async () => {
    const task = { ...terminal(), status: 'interrupted' }; task.nativeJobSegments[0].completion = 'done';
    const envelope = { ...createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: true }), action: 'abandon', acknowledgedAt: 3 };
    let refuseDeletion = false;
    const scheduler = createManagedTaskScheduler({ now: () => 1000,
      executor: { start: async () => { throw new Error('unexpected launch'); } },
      persistence: { load: async () => ({ version: 1, tasks: [task], resultEnvelopes: [envelope] }), save: async state => {
        if (refuseDeletion && !state.tasks.length) throw new Error('disposal persistence refused');
      } } });
    try {
      await scheduler.readNativeJobInputDispositions();
      await scheduler.discardObjectiveChecks({ directory: task.directory, sessions: ['ses_sibling'] }, async () => {});
      expect(scheduler.getTask(task.taskId)).not.toBeNull();
      const scope = { directory: task.directory, sessions: [task.childSessionId] };
      await expect(scheduler.discardObjectiveChecks(scope, async () => { throw new Error('removal proof refused'); })).rejects.toThrow('removal proof refused');
      refuseDeletion = true;
      await expect(scheduler.discardObjectiveChecks(scope, async () => {})).rejects.toThrow('disposal persistence refused');
      expect((await scheduler.readNativeJobInputDispositions())[0].taskId).toBe(task.taskId);
      refuseDeletion = false;
      await scheduler.discardObjectiveChecks(scope, async () => {});
      expect(scheduler.getTask(task.taskId)).toBeNull();
      expect(await scheduler.readNativeJobInputDispositions()).toEqual([]);
    } finally { refuseDeletion = false; await scheduler.shutdown(); }
  });

  test('verified disposal cannot discard an adverse task while its native completion remains pending', async () => {
    const task = { ...terminal(), status: 'aborted' }, envelope = createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: true });
    const scheduler = createManagedTaskScheduler({ now: () => 3, executor: { start: async () => { throw new Error('unexpected launch'); } },
      persistence: { load: async () => ({ version: 1, tasks: [task], resultEnvelopes: [envelope] }), save: async () => {} } });
    try {
      await scheduler.discardObjectiveChecks({ directory: task.directory, sessions: [task.childSessionId] }, async () => {});
      expect(scheduler.getTask(task.taskId).nativeJobSegments[0].completion).toBe('pending');
    } finally { await scheduler.shutdown(); }
  });
});
