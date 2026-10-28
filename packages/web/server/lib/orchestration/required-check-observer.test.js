import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManagedTaskScheduler, decodeRequiredCheckVerification, projectRequiredCheckCompletion } from '@devryan/orchestration-runtime';
import { createRequiredCheckObserver, diagnoseRequiredCheckEnvironment, PREVIEW_FRESHNESS_HINT } from './required-check-observer.js';

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
    expect((await observer.project(task))[0]).toMatchObject({ status: 'pending', reason: 'check_not_observed' });
    await check();
    const first = (await observer.project(task))[0];
    expect(first).toMatchObject({ status: 'passed', evidence: { callId: 'call_check', exitCode: 0 } });
    await fs.writeFile(path.join(directory, 'source.txt'), 'after');
    expect((await observer.project(task))[0]).toMatchObject({ status: 'pending', reason: 'content_changed_or_check_incomplete' });
    await check();
    expect((await observer.project(task))[0].status).toBe('passed');
    expect((await observer.project(task))[0].coverage.contentHash).not.toBe(first.coverage.contentHash);
  });
  it('persists root objective checks, rejects changed authority, and invalidates stale evidence', async () => {
    let saved = null;
    const persistence = { load: async () => saved, save: async value => { saved = structuredClone(value); } };
    const scheduler = createManagedTaskScheduler({ persistence, executor: { async start() {}, async abort() {} } });
    const rootObserver = createRequiredCheckObserver({ scheduler, now: () => 100 });
    const scope = { rootSessionId: 'ses_root', directory, objectiveId: 'msg_user' };
    const rootInput = { ...input, sessionId: 'ses_root', objectiveId: 'msg_user' };
    try {
      await scheduler.declareObjectiveChecks(scope, task.requiredChecks, [], async () => {});
      await expect(scheduler.declareObjectiveChecks(scope, [{ ...task.requiredChecks[0], command: 'other' }], [], async () => {})).rejects.toMatchObject({ code: 'objective_checks_immutable' });
      expect(await rootObserver.before(rootInput)).toEqual({ tracked: true });
      expect(await rootObserver.after({ ...rootInput, objectiveId: 'msg_other', exitCode: 0 })).toEqual({ recorded: false });
      expect((await rootObserver.project(scheduler.getObjectiveRequiredChecks(scope)))[0].status).toBe('pending');
      await rootObserver.before({ ...rootInput, callId: 'call_valid' });
      expect(await rootObserver.after({ ...rootInput, callId: 'call_valid', exitCode: 0 })).toEqual({ recorded: true });
      expect((await rootObserver.project(scheduler.getObjectiveRequiredChecks(scope)))[0].status).toBe('passed');
      expect(saved.objectiveChecks[0].requiredCheckReceipts[0].status).toBe('passed');
      await fs.writeFile(path.join(directory, 'source.txt'), 'changed');
      expect((await rootObserver.project(scheduler.getObjectiveRequiredChecks(scope)))[0].status).toBe('pending');
    } finally { rootObserver.dispose(); await scheduler.shutdown(); }
    const restored = createManagedTaskScheduler({ persistence, executor: { async start() {}, async abort() {} } });
    try { await restored.initialize(); expect(restored.getObjectiveRequiredChecks(scope).requiredCheckReceipts[0].status).toBe('passed'); }
    finally { await restored.shutdown(); }
  });
  it('binds cwd and environment to exact execution evidence and invalidates a changed command identity', async () => {
    await fs.mkdir(path.join(directory, 'package'));
    task.requiredChecks[0] = { ...task.requiredChecks[0], cwd: 'package', environment: 'native' };
    expect(await observer.before(input)).toEqual({ tracked: false });
    const scoped = { ...input, workdir: 'package', environment: 'native' };
    expect(await observer.before({ ...scoped, environment: 'container' })).toEqual({ tracked: false });
    expect(await observer.before(scoped)).toEqual({ tracked: true });
    await observer.after({ ...scoped, exitCode: 0 });
    expect((await observer.project(task))[0]).toMatchObject({ status: 'passed', execution: { cwd: 'package', environment: 'native' } });
    task.requiredChecks[0].environment = 'container';
    expect((await observer.project(task))[0].status).toBe('pending');
  });
  it('records an explicit unavailable environment as skipped without passing, losing exit evidence or masking SQL defects', async () => {
    await observer.before(input);
    await observer.after({ ...input, exitCode: 1, outputComplete: true, output: 'Cannot connect to the Docker daemon. Is the docker daemon running?' });
    const projected = (await observer.project(task))[0];
    expect(projected).toMatchObject({ status: 'skipped', reason: 'environment_unavailable',
      environmentUnavailable: { reason: 'docker_daemon_unavailable' }, evidence: { exitCode: 1, callId: input.callId } });
    expect(projectRequiredCheckCompletion([projected])).toMatchObject({ ready: true, status: 'skipped' });
    await observer.before({ ...input, callId: 'call_incomplete' });
    await observer.after({ ...input, callId: 'call_incomplete', exitCode: 1, outputComplete: false, output: 'Cannot connect to the Docker daemon' });
    expect((await observer.project(task))[0].status).toBe('failed');
    const completion = projectRequiredCheckCompletion([projected]);
    expect(decodeRequiredCheckVerification({ ...completion, checks: [projected], objectiveId: null, observedAt: 100 })).not.toBeNull();
    expect(diagnoseRequiredCheckEnvironment('SQLSTATE 42501 permission denied for table users; Cannot connect to the Docker daemon')).toBeNull();
    expect(diagnoseRequiredCheckEnvironment('AssertionError: Docker daemon is not running')).toBeNull();
    expect(diagnoseRequiredCheckEnvironment('write /proc/123/uid_map: operation not permitted')).toMatchObject({ reason: 'uid_mapping_unavailable' });
    expect(diagnoseRequiredCheckEnvironment('permission denied while connecting to docker.sock')).toMatchObject({ reason: 'docker_socket_denied' });
  });
  it('records canonical UID-resolution failures as skipped with the failing receipt retained', async () => {
    await observer.before(input);
    await observer.after({ ...input, exitCode: 255, outputComplete: true, output: 'No user exists for uid 501' });
    expect((await observer.project(task))[0]).toMatchObject({ status: 'skipped', reason: 'environment_unavailable',
      environmentUnavailable: { reason: 'uid_mapping_unavailable', hint: expect.stringContaining('UID resolvable') }, evidence: { exitCode: 255 } });
  });
  it.each(['/var/run/docker.sock', '/run/docker.sock', '/run/user/501/docker.sock', '/Users/test/.docker/run/docker.sock', '/home/test/.docker/run/docker.sock'])(
    'records a missing Docker socket as skipped with the original receipt: %s', async socket => {
      await observer.before(input);
      await observer.after({ ...input, exitCode: 1, outputComplete: true,
        output: `ENOENT: no such file or directory, stat '${socket}'\n\nExited with code 1` });
      const projected = (await observer.project(task))[0];
      expect(projected).toMatchObject({ status: 'skipped', reason: 'environment_unavailable',
        environmentUnavailable: { reason: 'docker_daemon_unavailable' },
        evidence: { exitCode: 1, callId: input.callId, messageId: input.messageId } });
      expect(projectRequiredCheckCompletion([projected])).toMatchObject({ ready: true, status: 'skipped' });
    },
  );
  it('requires complete output and matching command, environment, message and content for a missing-socket skip', async () => {
    const diagnostic = { exitCode: 1, outputComplete: true, output: "ENOENT: no such file or directory, stat '/var/run/docker.sock'" };
    expect(await observer.before({ ...input, command: 'docker info' })).toEqual({ tracked: false });
    expect(await observer.after({ ...input, command: 'docker info', ...diagnostic })).toEqual({ recorded: false });
    expect(await observer.before({ ...input, environment: 'container' })).toEqual({ tracked: false });
    expect(await observer.after({ ...input, environment: 'container', ...diagnostic })).toEqual({ recorded: false });
    expect((await observer.project(task))[0].status).toBe('pending');
    await observer.before(input);
    expect(await observer.after({ ...input, ...diagnostic, messageId: 'msg_other' })).toEqual({ recorded: false });
    expect((await observer.project(task))[0].status).toBe('pending');
    await observer.before(input);
    await observer.after({ ...input, ...diagnostic, outputComplete: false });
    expect((await observer.project(task))[0].status).toBe('failed');
    await observer.before(input);
    await fs.writeFile(path.join(directory, 'source.txt'), 'changed');
    await observer.after({ ...input, ...diagnostic });
    expect((await observer.project(task))[0]).toMatchObject({ status: 'failed', evidence: { exitCode: 1 } });
    expect(task.requiredCheckReceipts[0].contentHash).toBeNull();
    expect(task.requiredCheckReceipts[0].environmentUnavailable).toBeUndefined();
  });
  it.each([
    "ENOENT: no such file or directory, stat '/project/docker.sock'",
    "ENOENT: no such file or directory, stat '/var/run/docker.sock.backup'",
    "ENOENT: no such file or directory, open '/var/run/docker.sock'",
    "ENOENT: no such file or directory, stat '/var/run/docker.sock'\nENOENT: no such file or directory, stat '/project/source.ts'",
    "ENOENT: no such file or directory, stat '/var/run/docker.sock'\nSQLSTATE 42501 permission denied for table users",
    "ENOENT: no such file or directory, stat '/var/run/docker.sock'\nAssertionError: expected two rows",
    "ENOENT: no such file or directory, stat '/var/run/docker.sock'\nError: unrelated application defect",
  ])('does not skip unrelated or mixed missing-file failures: %s', async output => {
    await observer.before(input);
    await observer.after({ ...input, exitCode: 1, outputComplete: true, output });
    expect((await observer.project(task))[0]).toMatchObject({ status: 'failed', evidence: { exitCode: 1 } });
  });
  it('recognizes lstat diagnostics and an optional error prefix for known Docker sockets', () => {
    expect(diagnoseRequiredCheckEnvironment('Error: ENOENT: no such file or directory, lstat "/var/run/docker.sock"'))
      .toMatchObject({ reason: 'docker_daemon_unavailable' });
  });
  it.each([
    'ERROR: column package_id does not exist', 'ERROR: relation public.packages does not exist',
    'FATAL: application initialization failed', 'TypeError: Cannot read properties of undefined',
    'test failure: expected two rows', 'Error: unrelated application defect',
  ])('never skips a real failure alongside Docker diagnostics: %s', async defect => {
    await observer.before(input);
    await observer.after({ ...input, exitCode: 1, outputComplete: true, output: `Cannot connect to the Docker daemon.\n${defect}` });
    expect((await observer.project(task))[0]).toMatchObject({ status: 'failed', evidence: { exitCode: 1 } });
  });
  it('accepts only prerequisite error lines and exact UID resolution diagnostics', () => {
    expect(diagnoseRequiredCheckEnvironment('Error: Cannot connect to the Docker daemon. Is the docker daemon running?'))
      .toMatchObject({ reason: 'docker_daemon_unavailable' });
    expect(diagnoseRequiredCheckEnvironment('newuidmap: write to uid_map failed: Operation not permitted'))
      .toMatchObject({ reason: 'uid_mapping_unavailable' });
    expect(diagnoseRequiredCheckEnvironment('No user exists for uid unknown')).toBeNull();
    expect(diagnoseRequiredCheckEnvironment('No user exists for uid 501; application failure')).toBeNull();
    expect(diagnoseRequiredCheckEnvironment('Cannot connect to the Docker daemon: Error: application defect')).toBeNull();
  });
  it('retains actual failures even when a later summary says passed', async () => {
    await check(1); task.recoverablePreview = 'All tests passed.';
    expect((await observer.project(task))[0]).toMatchObject({ status: 'failed', evidence: { exitCode: 1 } });
  });
  it('requires populated named visual assertions and current artifact bytes, with fixture coverage explicit', async () => {
    task.requiredChecks[0] = { ...task.requiredChecks[0], kind: 'visual', visual: {
      state: 'populated', dataSource: 'fixture', assertions: ['populated rows visible', 'no horizontal overflow'], reportPath: 'visual.json' } };
    await fs.writeFile(path.join(directory, 'screen.png'), 'screenshot');
    const evidence = [{ path: 'screen.png', sha256: crypto.createHash('sha256').update('screenshot').digest('hex') }];
    await check();
    expect((await observer.project(task))[0].status).toBe('blocked');
    await fs.writeFile(path.join(directory, 'visual.json'), JSON.stringify({ state: 'populated', dataSource: 'fixture', assertions: [], evidence }));
    await check();
    expect((await observer.project(task))[0].status).toBe('blocked');
    const report = { state: 'populated', dataSource: 'fixture', assertions: task.requiredChecks[0].visual.assertions.map(name => ({ name, status: 'passed' })), evidence };
    await fs.writeFile(path.join(directory, 'visual.json'), JSON.stringify(report));
    await check();
    expect((await observer.project(task))[0]).toMatchObject({ status: 'passed', visual: { dataSource: 'fixture', observation: { state: 'populated' } } });
    await fs.writeFile(path.join(directory, 'screen.png'), 'replaced screenshot');
    expect((await observer.project(task))[0].status).toBe('pending');
    await fs.writeFile(path.join(directory, 'screen.png'), 'screenshot');
    await fs.writeFile(path.join(directory, 'visual.json'), JSON.stringify({ ...report, dataSource: 'live' }));
    await check();
    expect((await observer.project(task))[0].status).toBe('blocked');
  });
  it('passes a visual check only when the servers it named served current files, and says why otherwise', async () => {
    task.requiredChecks[0] = { ...task.requiredChecks[0], kind: 'visual', visual: {
      state: 'populated', dataSource: 'fixture', assertions: ['populated rows visible'], reportPath: 'visual.json' } };
    await fs.writeFile(path.join(directory, 'screen.png'), 'screenshot');
    await fs.writeFile(path.join(directory, 'visual.json'), JSON.stringify({ state: 'populated', dataSource: 'fixture',
      assertions: [{ name: 'populated rows visible', status: 'passed' }],
      evidence: [{ path: 'screen.png', sha256: crypto.createHash('sha256').update('screenshot').digest('hex') }] }));
    const observe = async (before, after) => {
      await observer.before({ ...input, servedFreshness: before }); await observer.after({ ...input, exitCode: 0, servedFreshness: after });
      return (await observer.project(task))[0];
    };
    expect(await observe('unknown', 'unknown')).toMatchObject({ status: 'blocked', reason: 'preview_freshness_unproven', hint: PREVIEW_FRESHNESS_HINT,
      visual: { observation: { servedFreshness: 'unknown' } } });
    // A server that fell behind while the check ran fails it too, and a later
    // report cannot clear what the start of the check saw.
    expect(await observe('fresh', 'stale')).toMatchObject({ status: 'blocked', reason: 'preview_freshness_unproven', visual: { observation: { servedFreshness: 'stale' } } });
    expect(await observe('unknown', 'fresh')).toMatchObject({ status: 'blocked', reason: 'preview_freshness_unproven' });
    expect(await observe('fresh', 'fresh')).toMatchObject({ status: 'passed', visual: { observation: { servedFreshness: 'fresh' } } });
    // A check that named no server is unaffected, and unknown values are ignored.
    const unnamed = await observe(undefined, 'guessed');
    expect(unnamed.status).toBe('passed');
    expect(unnamed.visual.observation.servedFreshness).toBeUndefined();
  });
  it('does not infer success from output prose, unmatched checks, tools, or missing hooks', async () => {
    await observer.after({ ...input, exitCode: 0 });
    expect(await observer.before({ ...input, command: 'echo All tests passed' })).toEqual({ tracked: false });
    expect(await observer.before({ ...input, tool: 'custom-bash', readOnly: true })).toEqual({ tracked: false });
    await check(undefined);
    await observer.before(input); await observer.after({ ...input, exitCode: null });
    expect((await observer.project(task))[0].status).toBe('pending');
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
    expect((await observer.project(task))[0].status).toBe('pending');
  });
  it('keeps durable receipts useful after restart but incomplete observations unknown', async () => {
    await check(); observer.dispose();
    expect((await observer.project(structuredClone(task)))[0].status).toBe('passed');
    task.requiredCheckReceipts = []; await observer.before(input); observer.dispose();
    await observer.after({ ...input, exitCode: 0 });
    expect((await observer.project(task))[0].status).toBe('pending');
  });
  it('does not resurrect an older pass after a newly started check loses its completion hook', async () => {
    await check();
    expect((await observer.project(task))[0].status).toBe('passed');
    await observer.before({ ...input, callId: 'call_unresolved' });
    expect((await observer.project(task))[0].status).toBe('pending');
    observer.dispose();
    expect((await observer.project(structuredClone(task)))[0].status).toBe('pending');
  });
  it('reserves an unverified receipt before canonical message identity is available', async () => {
    await check();
    const unresolved = { ...input, callId: 'call_unresolved', messageId: undefined };
    expect(await observer.before(unresolved)).toEqual({ tracked: false, needsIdentity: true });
    expect((await observer.project(task))[0]).toMatchObject({ status: 'pending', evidence: { callId: 'call_unresolved', messageId: null } });
    expect(await observer.after({ ...unresolved, exitCode: 0 })).toEqual({ recorded: false });
    expect((await observer.project(task))[0].status).toBe('pending');
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
    expect((await observer.project(task))[0].status).toBe('pending');
  });
  it('accepts a symlink alias for the declared command working directory', async () => {
    await fs.symlink(directory, path.join(directory, 'alias'));
    const alias = { ...input, workdir: 'alias' };
    expect(await observer.before(alias)).toEqual({ tracked: true });
    expect(await observer.after({ ...alias, exitCode: 0 })).toEqual({ recorded: true });
  });
  it.each([
    { newerExit: null, expectedStatus: 'pending' },
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
      expect((await liveObserver.project(current))[0]).toMatchObject({ status: 'pending', reason: 'canonical_check_identity_conflict' });
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
      expect((await liveObserver.project(scheduler.getTask(liveTask.taskId))).map(check => check.status)).toEqual(['pending', 'pending']);
    } finally { liveObserver.dispose(); await scheduler.shutdown(); }
  });
  it('binds a native check to both its execution snapshot and published content',async()=>{
    const view=path.join(directory,'private-view');await fs.mkdir(view);await fs.writeFile(path.join(view,'source.txt'),'before');
    await observer.before({...input,executionDirectory:view});
    await observer.after({...input,exitCode:0});expect((await observer.project(task))[0].status).toBe('passed');
    await observer.before({...input,callId:'call_mismatch',executionDirectory:view});
    await fs.writeFile(path.join(view,'source.txt'),'different tested bytes');
    await observer.after({...input,callId:'call_mismatch',exitCode:0});
    expect((await observer.project(task))[0].status).toBe('pending');
  });
  it('fingerprints bounded source directories and invalidates evidence on membership or content changes', async () => {
    await fs.mkdir(path.join(directory,'src'));
    await fs.writeFile(path.join(directory,'src','a.ts'),'export const a=1');
    task.requiredChecks[0].paths=['src'];
    await observer.before(input);await observer.after({...input,exitCode:0});
    expect((await observer.project(task))[0].status).toBe('passed');
    await fs.writeFile(path.join(directory,'src','b.ts'),'export const b=2');
    expect((await observer.project(task))[0].status).toBe('pending');
    await fs.symlink(directory,path.join(directory,'src','cycle'));
    expect((await observer.project(task))[0].coverage.contentHash).toBeNull();
  });
  it('rejects missing, oversized, and escaping symlink content without reading outside the project', async () => {
    await fs.unlink(path.join(directory, 'source.txt'));
    await check(); expect((await observer.project(task))[0].status).toBe('pending');
    await fs.symlink('../outside-private.txt', path.join(directory, 'source.txt'));
    await check(); expect((await observer.project(task))[0].status).toBe('pending');
    await fs.unlink(path.join(directory, 'source.txt')); await fs.writeFile(path.join(directory, 'source.txt'), '');
    await fs.truncate(path.join(directory, 'source.txt'), 8 * 1024 * 1024 + 1);
    await check(); expect((await observer.project(task))[0].status).toBe('pending');
  });
  it('never accepts a shell-success suffix as check proof and preserves actual nonzero failure evidence', async () => {
    const command = 'npm test; echo done';
    task.requiredChecks[0].command = command;
    await observer.before({ ...input, command });
    await observer.after({ ...input, command, exitCode: 0 });
    expect(task.requiredCheckReceipts[0].status).toBe('blocked');
    expect((await observer.project(task))[0]).toMatchObject({ status: 'blocked', reason: 'required_check_command_exit_ambiguous' });
    const checks = await observer.project(task);
    const wire = decodeRequiredCheckVerification({ ...projectRequiredCheckCompletion(checks), checks, objectiveId: 'msg_root', observedAt: 100 });
    expect(wire.checks[0].hint).toContain('standalone command');
    const failed = { ...input, command, callId: 'call_failed', messageId: 'msg_failed' };
    await observer.before(failed); await observer.after({ ...failed, exitCode: 1 });
    expect((await observer.project(task))[0]).toMatchObject({ status: 'failed', reason: 'observed_nonzero_exit', evidence: { exitCode: 1 } });
  });
  it('keeps legacy ambiguous passing receipts blocked while a failure-preserving && chain may pass', async () => {
    const command = 'npm test && npm run lint';
    task.requiredChecks[0].command = command;
    await observer.before({ ...input, command }); await observer.after({ ...input, command, exitCode: 0 });
    expect((await observer.project(task))[0].status).toBe('passed');
    task.requiredChecks[0].command = 'npm test || true';
    expect((await observer.project(task))[0]).toMatchObject({ status: 'blocked', reason: 'required_check_command_exit_ambiguous' });
  });
});
