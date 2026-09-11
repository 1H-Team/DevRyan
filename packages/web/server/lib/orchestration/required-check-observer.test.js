import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManagedTaskScheduler } from '@openchamber/orchestration-runtime';
import { createRequiredCheckObserver } from './required-check-observer.js';

describe('canonical required checks against final content', () => {
  let directory, task, observer, input;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-required-check-'));
    await fs.writeFile(path.join(directory, 'source.txt'), 'before');
    task = { taskId: 'dvr_task_check', directory, leaseToken: 'lease_1', requiredChecks: [
      { name: 'unit tests', command: 'bun test source.test.js', paths: ['source.txt'] },
    ], requiredCheckReceipts: [] };
    const scheduler = {
      getRequiredCheckTask: (sessionId, dir) => sessionId === 'ses_child' && dir === directory ? task : null,
      recordRequiredChecks: async (id, lease, receipts) => {
        if (id !== task.taskId || lease !== task.leaseToken) return false;
        task.requiredCheckReceipts = receipts; return true;
      },
    };
    observer = createRequiredCheckObserver({ scheduler, now: () => 100 });
    input = { sessionId: 'ses_child', directory, tool: 'bash', callId: 'call_check', messageId: 'msg_child', command: 'bun test source.test.js' };
  });
  afterEach(async () => { observer.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const check = async (exitCode = 0) => { await observer.before(input); await observer.after({ ...input, exitCode }); };

  it('invalidates a pass after a relevant write and reestablishes it only after another check', async () => {
    expect((await observer.project(task))[0]).toMatchObject({ status: 'not-observed', reason: 'check_not_observed' });
    await check();
    const first = (await observer.project(task))[0];
    expect(first).toMatchObject({ status: 'passed', evidence: { callId: 'call_check', exitCode: 0 } });
    await fs.writeFile(path.join(directory, 'source.txt'), 'after');
    expect((await observer.project(task))[0]).toMatchObject({ status: 'not-observed', reason: 'content_changed_or_check_incomplete' });
    await check();
    expect((await observer.project(task))[0].status).toBe('passed');
    expect((await observer.project(task))[0].coverage.contentHash).not.toBe(first.coverage.contentHash);
  });
  it('retains actual failures even when a later summary says passed', async () => {
    await check(1); task.recoverablePreview = 'All tests passed.';
    expect((await observer.project(task))[0]).toMatchObject({ status: 'failed', evidence: { exitCode: 1 } });
  });
  it('does not infer success from output prose, unmatched checks, tools, or missing hooks', async () => {
    await observer.after({ ...input, exitCode: 0 });
    expect(await observer.before({ ...input, command: 'echo All tests passed' })).toEqual({ tracked: false });
    expect(await observer.before({ ...input, tool: 'custom-bash', readOnly: true })).toEqual({ tracked: false });
    await check(undefined);
    await observer.before(input); await observer.after({ ...input, exitCode: null });
    expect((await observer.project(task))[0].status).toBe('not-observed');
  });
  it('rejects another child or directory and drops callbacks from an old task lease', async () => {
    expect(await observer.before({ ...input, sessionId: 'ses_other' })).toEqual({ tracked: false });
    expect(await observer.before({ ...input, directory: `${directory}/other` })).toEqual({ tracked: false });
    await observer.before(input); task.leaseToken = 'lease_2';
    const started = structuredClone(task.requiredCheckReceipts);
    await observer.after({ ...input, exitCode: 0 });
    expect(task.requiredCheckReceipts).toEqual(started);
    expect(started[0].status).toBe('not-observed');
  });
  it('does not verify a command that changed its relevant input while running', async () => {
    await observer.before(input);
    await fs.writeFile(path.join(directory, 'source.txt'), 'raced');
    await observer.after({ ...input, exitCode: 0 });
    expect((await observer.project(task))[0].status).toBe('not-observed');
  });
  it('keeps durable receipts useful after restart but incomplete observations unknown', async () => {
    await check(); observer.dispose();
    expect((await observer.project(structuredClone(task)))[0].status).toBe('passed');
    task.requiredCheckReceipts = []; await observer.before(input); observer.dispose();
    await observer.after({ ...input, exitCode: 0 });
    expect((await observer.project(task))[0].status).toBe('not-observed');
  });
  it('does not resurrect an older pass after a newly started check loses its completion hook', async () => {
    await check();
    expect((await observer.project(task))[0].status).toBe('passed');
    await observer.before({ ...input, callId: 'call_unresolved' });
    expect((await observer.project(task))[0].status).toBe('not-observed');
    observer.dispose();
    expect((await observer.project(structuredClone(task)))[0].status).toBe('not-observed');
  });
  it('reserves an unverified receipt before canonical message identity is available', async () => {
    await check();
    const unresolved = { ...input, callId: 'call_unresolved', messageId: undefined };
    expect(await observer.before(unresolved)).toEqual({ tracked: false, needsIdentity: true });
    expect((await observer.project(task))[0]).toMatchObject({ status: 'not-observed', evidence: { callId: 'call_unresolved', messageId: null } });
    expect(await observer.after({ ...unresolved, exitCode: 0 })).toEqual({ recorded: false });
    expect((await observer.project(task))[0].status).toBe('not-observed');
  });
  it('binds a reserved check after canonical identity becomes available', async () => {
    await observer.before({ ...input, messageId: undefined });
    expect(await observer.before(input)).toEqual({ tracked: true });
    expect(await observer.after({ ...input, exitCode: 0 })).toEqual({ recorded: true });
    expect((await observer.project(task))[0].status).toBe('passed');
  });
  it('cannot verify a declared command run in another working directory', async () => {
    await fs.mkdir(path.join(directory, 'other'));
    const elsewhere = { ...input, workdir: 'other' };
    expect(await observer.before(elsewhere)).toEqual({ tracked: false });
    expect(await observer.after({ ...elsewhere, exitCode: 0 })).toEqual({ recorded: false });
    expect((await observer.project(task))[0].status).toBe('not-observed');
  });
  it('accepts a symlink alias for the declared command working directory', async () => {
    await fs.symlink(directory, path.join(directory, 'alias'));
    const alias = { ...input, workdir: 'alias' };
    expect(await observer.before(alias)).toEqual({ tracked: true });
    expect(await observer.after({ ...alias, exitCode: 0 })).toEqual({ recorded: true });
  });
  it.each([
    { newerExit: null, expectedStatus: 'not-observed' },
    { newerExit: 1, expectedStatus: 'failed' },
    { newerExit: 0, expectedStatus: 'passed' },
  ])('keeps the newer invocation authoritative when an older completion arrives late: $expectedStatus', async ({ newerExit, expectedStatus }) => {
    let saved;
    const scheduler = createManagedTaskScheduler({
      persistence: { load: async () => null, save: async (value) => { saved = structuredClone(value); } },
      executor: {
        async start(_task, control) {
          await control.setChildSessionId('ses_child');
          await control.markAccepted();
          return new Promise(() => {});
        },
        async abort() { return { aborted: true }; },
      },
    });
    const liveObserver = createRequiredCheckObserver({ scheduler, now: () => 100 });
    try {
      const liveTask = await scheduler.submit({
        idempotencyKey: `check-order-${expectedStatus}`, rootSessionId: 'ses_root', parentTaskId: null,
        directory, mode: 'orchestrator', providerId: 'fixture', modelId: 'model', agent: 'explorer',
        variant: null, label: 'Check ordering', prompt: 'Fixture only', dispatchGroupId: 'msg_user', timeoutAt: null,
        requiredChecks: task.requiredChecks,
      });
      await scheduler.flush();
      const older = { ...input, callId: 'call_older' };
      const newer = { ...input, callId: 'call_newer' };
      await liveObserver.before(older);
      await liveObserver.before(newer);
      if (newerExit !== null) {
        await liveObserver.after({ ...newer, exitCode: newerExit });
        expect(await liveObserver.before(newer)).toEqual({ tracked: false });
      }
      expect(await liveObserver.after({ ...older, exitCode: 0 })).toEqual({ recorded: false });
      const current = scheduler.getTask(liveTask.taskId);
      expect((await liveObserver.project(current))[0]).toMatchObject({
        status: expectedStatus, evidence: { callId: 'call_newer' },
      });
      expect(saved.tasks.find((entry) => entry.taskId === liveTask.taskId).requiredCheckReceipts)
        .toEqual(current.requiredCheckReceipts);
    } finally {
      liveObserver.dispose();
      await scheduler.shutdown();
    }
  });
  it('rejects late and conflicting canonical identity binds in the durable scheduler', async () => {
    let saved;
    const scheduler = createManagedTaskScheduler({
      persistence: { load: async () => null, save: async (value) => { saved = structuredClone(value); } },
      executor: {
        async start(_task, control) {
          await control.setChildSessionId('ses_child');
          await control.markAccepted();
          return new Promise(() => {});
        },
        async abort() { return { aborted: true }; },
      },
    });
    const liveObserver = createRequiredCheckObserver({ scheduler, now: () => 100 });
    try {
      const liveTask = await scheduler.submit({
        idempotencyKey: 'check-identity', rootSessionId: 'ses_root', parentTaskId: null,
        directory, mode: 'orchestrator', providerId: 'fixture', modelId: 'model', agent: 'explorer',
        variant: null, label: 'Check identity', prompt: 'Fixture only', dispatchGroupId: 'msg_user', timeoutAt: null,
        requiredChecks: task.requiredChecks,
      });
      await scheduler.flush();
      const older = { ...input, callId: 'call_older', messageId: undefined };
      const newer = { ...input, callId: 'call_newer', messageId: undefined };
      await liveObserver.before(older);
      await liveObserver.before(newer);
      expect(await liveObserver.before({ ...older, messageId: 'msg_old' })).toEqual({ tracked: false });
      expect(await liveObserver.before({ ...newer, messageId: 'msg_new' })).toEqual({ tracked: true });
      expect(await liveObserver.before({ ...newer, messageId: 'msg_conflict' })).toEqual({ tracked: false });
      expect(await liveObserver.after({ ...newer, messageId: 'msg_new', exitCode: 0 })).toEqual({ recorded: false });
      const current = scheduler.getTask(liveTask.taskId);
      expect(current.requiredCheckReceipts).toEqual([expect.objectContaining({ callId: 'call_newer',
        messageId: null, identityConflict: true, status: 'not-observed', exitCode: null, contentHash: null })]);
      expect(await scheduler.recordRequiredCheck(current.taskId, current.leaseToken, {
        ...current.requiredCheckReceipts[0], identityConflict: undefined, messageId: 'msg_new',
      }, 'bind')).toBe(false);
      expect(saved.tasks.find((entry) => entry.taskId === liveTask.taskId).requiredCheckReceipts).toEqual(current.requiredCheckReceipts);
      liveObserver.dispose();
      expect(await liveObserver.before({ ...newer, messageId: 'msg_new' })).toEqual({ tracked: false });
      expect((await liveObserver.project(current))[0]).toMatchObject({ status: 'not-observed', reason: 'canonical_check_identity_conflict' });
    } finally {
      liveObserver.dispose();
      await scheduler.shutdown();
    }
  });
  it('supersedes every check for a command atomically and never reconstructs lost before-content evidence', async () => {
    const snapshots = [];
    const requiredChecks = [...task.requiredChecks, { ...task.requiredChecks[0], name: 'second coverage' }];
    const scheduler = createManagedTaskScheduler({
      persistence: { load: async () => null, save: async value => { snapshots.push(structuredClone(value)); } },
      executor: {
        async start(_task, control) {
          await control.setChildSessionId('ses_child'); await control.markAccepted(); return new Promise(() => {});
        },
        async abort() { return { aborted: true }; },
      },
    });
    const liveObserver = createRequiredCheckObserver({ scheduler, now: () => 100 });
    try {
      const liveTask = await scheduler.submit({ idempotencyKey: 'check-group', rootSessionId: 'ses_root', parentTaskId: null,
        directory, mode: 'orchestrator', providerId: 'fixture', modelId: 'model', agent: 'explorer', variant: null,
        label: 'Check group', prompt: 'Fixture only', dispatchGroupId: 'msg_user', timeoutAt: null, requiredChecks });
      await scheduler.flush();
      await liveObserver.before(input); await liveObserver.after({ ...input, exitCode: 0 });
      expect((await liveObserver.project(scheduler.getTask(liveTask.taskId))).map(check => check.status)).toEqual(['passed', 'passed']);
      snapshots.length = 0;
      const next = { ...input, callId: 'call_next', messageId: undefined };
      await liveObserver.before(next);
      expect(snapshots).toHaveLength(1);
      for (const snapshot of snapshots) {
        expect(snapshot.tasks.find(entry => entry.taskId === liveTask.taskId).requiredCheckReceipts)
          .toEqual(requiredChecks.map(check => expect.objectContaining({ name: check.name, callId: 'call_next', messageId: null, status: 'not-observed' })));
      }
      liveObserver.dispose();
      await fs.writeFile(path.join(directory, 'source.txt'), 'changed after lost before hook');
      expect(await liveObserver.before({ ...next, messageId: 'msg_after' })).toEqual({ tracked: false });
      expect(await liveObserver.after({ ...next, messageId: 'msg_after', exitCode: 0 })).toEqual({ recorded: false });
      expect((await liveObserver.project(scheduler.getTask(liveTask.taskId))).map(check => check.status)).toEqual(['not-observed', 'not-observed']);
    } finally { liveObserver.dispose(); await scheduler.shutdown(); }
  });
  it('rejects missing, oversized, and escaping symlink content without reading outside the project', async () => {
    await fs.unlink(path.join(directory, 'source.txt'));
    await check(); expect((await observer.project(task))[0].status).toBe('not-observed');
    await fs.symlink('../outside-private.txt', path.join(directory, 'source.txt'));
    await check(); expect((await observer.project(task))[0].status).toBe('not-observed');
    await fs.unlink(path.join(directory, 'source.txt')); await fs.writeFile(path.join(directory, 'source.txt'), '');
    await fs.truncate(path.join(directory, 'source.txt'), 8 * 1024 * 1024 + 1);
    await check(); expect((await observer.project(task))[0].status).toBe('not-observed');
  });
});
