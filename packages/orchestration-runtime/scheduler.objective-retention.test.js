import { expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './scheduler.js';
import { createManagedTaskRecord } from './contract.js';

const check = { name: 'unit', command: 'bun test', paths: ['source.js'] };
test('more than 256 distinct objectives retain proof across restart and proven removal cleans only its scope', async () => {
  let saved = { version: 1, tasks: [], resultEnvelopes: [], objectiveChecks: Array.from({ length: 257 }, (_, index) => ({
    rootSessionId: `ses_${index}`, directory: '/project', objectiveId: 'msg_objective', requiredChecks: [check], requiredCheckReceipts: [], requiredCheckCorrections: [],
  })) };
  const options = { persistence: { load: async () => saved, save: async value => { saved = structuredClone(value); } }, executor: { start: async () => {} } };
  let scheduler = createManagedTaskScheduler(options);
  const scope = { rootSessionId: 'ses_new', directory: '/project', objectiveId: 'msg_new' };
  try {
    await scheduler.initialize();
    await scheduler.declareObjectiveChecks(scope, [check], [], async () => {});
    expect(saved.objectiveChecks).toHaveLength(258);
    await expect(scheduler.discardObjectiveChecks({ directory: '/project', sessions: ['ses_1'] }, async () => { throw Error('removal not proven'); })).rejects.toThrow('removal not proven');
    expect(scheduler.getObjectiveRequiredChecks({ rootSessionId: 'ses_1', directory: '/project', objectiveId: 'msg_objective' })).not.toBeNull();
    expect(await scheduler.discardObjectiveChecks({ directory: '/project', sessions: ['ses_1'] }, async () => {})).toEqual({ removed: 1 });
    await scheduler.shutdown(); scheduler = createManagedTaskScheduler(options); await scheduler.initialize();
    expect(scheduler.getObjectiveRequiredChecks({ rootSessionId: 'ses_1', directory: '/project', objectiveId: 'msg_objective' })).toBeNull();
    expect(scheduler.getObjectiveRequiredChecks(scope).requiredChecks).toEqual([check]);
    expect(scheduler.getObjectiveRequiredChecks({ rootSessionId: 'ses_2', directory: '/project', objectiveId: 'msg_objective' })).not.toBeNull();
  } finally { await scheduler.shutdown(); }
});

test('current root authority expires only old superseded objective records, retaining recent and foreign records', async () => {
  const base = { rootSessionId: 'ses_root', directory: '/project', requiredChecks: [check], requiredCheckReceipts: [], requiredCheckCorrections: [] };
  let saved = { version: 1, tasks: [], resultEnvelopes: [], objectiveChecks: [
    { ...base, objectiveId: 'msg_old', updatedAt: 1 }, { ...base, objectiveId: 'msg_recent', updatedAt: 950 },
    { ...base, rootSessionId: 'ses_foreign', objectiveId: 'msg_old', updatedAt: 1 },
    { ...base, objectiveId: 'msg_legacy' },
  ] };
  const scheduler = createManagedTaskScheduler({ now: () => 1000, maxHistoryAgeMs: 100,
    persistence: { load: async () => saved, save: async value => { saved = structuredClone(value); } }, executor: { start: async () => {} } });
  try {
    await scheduler.declareObjectiveChecks({ rootSessionId: 'ses_root', directory: '/project', objectiveId: 'msg_current' }, [check], [], async () => {});
    expect(saved.objectiveChecks.map(row => `${row.rootSessionId}:${row.objectiveId}`).sort()).toEqual([
      'ses_foreign:msg_old', 'ses_root:msg_current', 'ses_root:msg_legacy', 'ses_root:msg_recent',
    ]);
  } finally { await scheduler.shutdown(); }
});

test('superseded objective with an uncollected terminal task stays retained under age pressure', async () => {
  const record = { ...createManagedTaskRecord({ taskId: 'dvr_task_old', idempotencyKey: 'old', rootSessionId: 'ses_root', directory: '/project',
    parentTaskId: null, dispatchGroupId: 'msg_old', dispatchObjectiveId: 'msg_old', sequence: 1, mode: 'orchestrator', providerId: 'p', modelId: 'm',
    agent: 'fixer', variant: null, label: 'old', prompt: 'old', attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1, timeoutAt: null }),
    status: 'completed', leaseToken: 'dvr_lease_old', startedAt: 2, finishedAt: 3 };
  let saved = { version: 1, tasks: [record], resultEnvelopes: [], objectiveChecks: [{ rootSessionId: 'ses_root', directory: '/project', objectiveId: 'msg_old',
    requiredChecks: [check], requiredCheckReceipts: [], requiredCheckCorrections: [], updatedAt: 1 }] };
  const scheduler = createManagedTaskScheduler({ now: () => 1000, maxHistoryAgeMs: 100, expireUnacknowledged: false,
    persistence: { load: async () => saved, save: async value => { saved = structuredClone(value); } }, executor: { start: async () => {} } });
  try {
    await scheduler.declareObjectiveChecks({ rootSessionId: 'ses_root', directory: '/project', objectiveId: 'msg_current' }, [check], [], async () => {});
    expect(saved.objectiveChecks.map(row => row.objectiveId).sort()).toEqual(['msg_current','msg_old']);
  } finally { await scheduler.shutdown(); }
});

test('objective evidence respects the ledger byte limit and rolls back without dropping existing records', async () => {
  let saved = { version: 1, tasks: [], resultEnvelopes: [] };
  const scheduler = createManagedTaskScheduler({ maxPersistedBytes: 400,
    persistence: { load: async () => saved, save: async value => { saved = structuredClone(value); } }, executor: { start: async () => {} } });
  const first = { rootSessionId: 'ses_first', directory: '/project', objectiveId: 'msg_first' };
  const second = { rootSessionId: 'ses_second', directory: '/project', objectiveId: 'msg_second' };
  try {
    await scheduler.declareObjectiveChecks(first, [check], [], async () => {});
    await expect(scheduler.declareObjectiveChecks(second, [check], [], async () => {})).rejects.toMatchObject({ code: 'ledger_capacity_exceeded' });
    expect(scheduler.getObjectiveRequiredChecks(first).requiredChecks).toEqual([check]);
    expect(scheduler.getObjectiveRequiredChecks(second)).toBeNull();
    expect(saved.objectiveChecks).toHaveLength(1);
  } finally { await scheduler.shutdown(); }
});
