import { describe, expect, it } from 'bun:test';
import { createManagedTaskRecord, createManagedTaskResultEnvelope, createManagedTaskScheduler, REQUIRED_CHECK_CORRECTION,
  assertManagedTaskTransition, selectRequiredCheckTasks } from './index.js';

const check = { name: 'edge', command: 'npx vitest run supabase/functions/booking-documents/__tests__ --maxWorkers=2',
  paths: ['supabase/functions/booking-documents'], purpose: 'integration', prerequisites: ['fixture'] };
const receipt = { name: 'edge', callId: 'call_old', messageId: 'msg_old', status: 'failed', exitCode: 1, contentHash: 'a'.repeat(64), observedAt: 20 };
const correction = () => ({ name: check.name, previousCommand: check.command, command: 'npm run test:edge -- --function booking-documents',
  reason: 'repository_edge_deno_runner', observedAt: 40, previousReceipt: receipt, runnerIdentity: {
    kind: 'edge-deno-function-v1', packagePath: 'package.json', packageSha256: 'b'.repeat(64), scriptPath: 'scripts/testing/run-deno-tests.mjs',
    scriptSha256: 'c'.repeat(64), functionName: 'booking-documents', selector: '--function', testPath: 'supabase/functions/booking-documents/__tests__',
    coverageHash: 'a'.repeat(64), verifiedBy: 'host-policy' } });
const authority = (extra = {}) => ({ [REQUIRED_CHECK_CORRECTION]: true, rootSessionId: 'ses_root', directory: '/workspace', objectiveId: 'msg_objective', recheck: async () => {}, ...extra });

async function fixture() {
  const task = { ...createManagedTaskRecord({ taskId: 'dvr_task_correction', idempotencyKey: 'correction', rootSessionId: 'ses_root',
    directory: '/workspace', parentTaskId: null, dispatchGroupId: 'msg_dispatch', dispatchObjectiveId: 'msg_objective', sequence: 1, mode: 'orchestrator',
    providerId: 'openai', modelId: 'model', agent: 'fixer', variant: null, label: 'Tests', prompt: 'Implement', attempt: 1,
    priorTaskId: null, executionKind: 'start', createdAt: 1, timeoutAt: null, requiredChecks: [check] }),
    status: 'completed', childSessionId: 'ses_child', leaseToken: 'dvr_lease_1', startedAt: 2, finishedAt: 10, requiredCheckReceipts: [receipt] };
  let saved = { version: 1, tasks: [task], resultEnvelopes: [{ ...createManagedTaskResultEnvelope(task, { sequence: 2, createdAt: 10, resumable: false }), action: 'collect', acknowledgedAt: 30 }] };
  let failSave = false;
  const options = { now: () => 50, persistence: { load: async () => structuredClone(saved), save: async state => {
    if (failSave) throw Error('disk unavailable'); saved = structuredClone(state);
  } }, executor: { start: async () => { throw Error('must not execute'); } } };
  let scheduler = createManagedTaskScheduler(options);
  await scheduler.initialize();
  return { task, scheduler, saved: () => structuredClone(saved), failSave: value => { failSave = value; },
    restart: async () => { await scheduler.shutdown(); scheduler = createManagedTaskScheduler(options); await scheduler.initialize(); return scheduler; },
    stop: () => scheduler.shutdown() };
}

describe('atomic authorized runner correction', () => {
  it('keeps terminal execution immutable, persists complete history through restart and invalidates old evidence', async () => {
    const f = await fixture();
    try {
      const next = await f.scheduler.correctRequiredCheck(f.task.taskId, correction(), authority());
      expect(next.status).toBe('completed'); expect(next.finishedAt).toBe(10);
      expect(next.requiredChecks).toEqual([{ ...check, command: correction().command }]);
      expect(next.requiredCheckReceipts).toEqual([]);
      expect(next.requiredCheckCorrections[0]).toEqual({ ...correction(), previousCheck: check });
      expect(f.scheduler.getResultEnvelope(f.task.taskId).action).toBe('collect');
      const restored = (await f.restart()).getTask(f.task.taskId);
      expect(restored.requiredCheckCorrections).toEqual(next.requiredCheckCorrections);
      expect(restored.dispatchObjectiveId).toBe('msg_objective');
      expect(selectRequiredCheckTasks([restored], 'msg_objective')).toHaveLength(1);
      expect(selectRequiredCheckTasks([restored], 'msg_dispatch')).toHaveLength(0);
      expect(() => assertManagedTaskTransition(f.task, { ...next, failureReason: 'invented failure' })).toThrow('immutable');
    } finally { await f.stop(); }
  });

  it('rejects forged authority, stale command/receipt, wrong objective and a withdrawn root grant without writes', async () => {
    const f = await fixture();
    try {
      const initial = f.saved();
      await expect(f.scheduler.correctRequiredCheck(f.task.taskId, correction(), {})).rejects.toThrow('authority');
      await expect(f.scheduler.correctRequiredCheck(f.task.taskId, correction(), authority({ objectiveId: 'msg_foreign' }))).rejects.toMatchObject({ code: 'task_scope_mismatch' });
      await expect(f.scheduler.correctRequiredCheck(f.task.taskId, { ...correction(), previousCommand: 'another' }, authority())).rejects.toMatchObject({ code: 'required_check_correction_stale' });
      await expect(f.scheduler.correctRequiredCheck(f.task.taskId, { ...correction(), previousReceipt: { ...receipt, exitCode: 2 } }, authority())).rejects.toMatchObject({ code: 'required_check_correction_stale' });
      await expect(f.scheduler.correctRequiredCheck(f.task.taskId, correction(), authority({ recheck: async () => { throw Error('root revoked'); } }))).rejects.toThrow('root revoked');
      expect(f.saved()).toEqual(initial);
    } finally { await f.stop(); }
  });

  it('applies the same scoped correction to objective checks without a child task', async () => {
    let saved = { version: 1, tasks: [], resultEnvelopes: [], objectiveChecks: [{ rootSessionId: 'ses_root', directory: '/workspace', objectiveId: 'msg_objective', requiredChecks: [check], requiredCheckReceipts: [receipt], requiredCheckCorrections: [] }] };
    const scheduler = createManagedTaskScheduler({ persistence: { load: async () => saved, save: async value => { saved = structuredClone(value); } }, executor: { start: async () => {} } });
    const scope = { rootSessionId: 'ses_root', directory: '/workspace', objectiveId: 'msg_objective' };
    try {
      await scheduler.initialize();
      await expect(scheduler.correctRequiredCheck(scope, correction(), authority({ objectiveId: 'other' }))).rejects.toMatchObject({ code: 'task_scope_mismatch' });
      const result = await scheduler.correctRequiredCheck(scope, correction(), authority());
      expect(result.requiredCheckReceipts).toEqual([]);
      expect(result.requiredCheckCorrections).toEqual([{ ...correction(), previousCheck: check }]);
      expect(saved.tasks).toEqual([]);
      expect(saved.objectiveChecks[0].requiredChecks[0].command).toBe(correction().command);
    } finally { await scheduler.shutdown(); }
  });

  it('rolls back definition and receipt when the atomic ledger write fails', async () => {
    const f = await fixture();
    try {
      f.failSave(true);
      await expect(f.scheduler.correctRequiredCheck(f.task.taskId, correction(), authority())).rejects.toThrow('disk unavailable');
      expect(f.scheduler.getTask(f.task.taskId).requiredChecks).toEqual([check]);
      expect(f.scheduler.getTask(f.task.taskId).requiredCheckReceipts).toEqual([receipt]);
      expect(f.scheduler.getTask(f.task.taskId).requiredCheckCorrections).toBeUndefined();
    } finally { f.failSave(false); await f.stop(); }
  });
});
