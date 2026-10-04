import { afterEach, describe, expect, it, vi } from 'vitest';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import {
  computeNextRunAt,
  createScheduledTasksRuntime,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
} from './runtime.js';

const createTask = (overrides = {}) => ({
  id: 'task-1',
  name: 'Wake up',
  enabled: true,
  schedule: {
    kind: 'daily',
    times: ['08:00'],
    timezone: 'UTC',
  },
  execution: {
    providerID: 'provider-1',
    modelID: 'model-1',
    prompt: '/wake',
  },
  state: {},
  ...overrides,
});

const createTaskConfigRuntime = (initialTasks) => {
  let tasks = initialTasks.map((task) => structuredClone(task));
  const runtime = {
    replaceTasks(nextTasks) {
      tasks = nextTasks.map((task) => structuredClone(task));
    },
    listScheduledTasks: vi.fn(async () => tasks.map((task) => structuredClone(task))),
    updateScheduledTaskState: vi.fn(async (_projectID, taskID, patch) => {
      const index = tasks.findIndex((task) => task.id === taskID);
      if (index < 0) return { task: null, tasks };
      tasks[index] = { ...tasks[index], state: { ...tasks[index].state, ...patch } };
      return { task: structuredClone(tasks[index]), tasks: tasks.map((task) => structuredClone(task)) };
    }),
    upsertScheduledTask: vi.fn(async (_projectID, task) => {
      const index = tasks.findIndex((entry) => entry.id === task.id);
      if (index >= 0) tasks[index] = structuredClone(task);
      else tasks.push(structuredClone(task));
      return { task: structuredClone(task), tasks: tasks.map((entry) => structuredClone(entry)) };
    }),
    deleteScheduledTask: vi.fn(async (_projectID, taskID) => {
      const before = tasks.length;
      tasks = tasks.filter((task) => task.id !== taskID);
      return {
        deleted: tasks.length !== before,
        tasks: tasks.map((task) => structuredClone(task)),
      };
    }),
    deleteScheduledTasksForOwner: vi.fn(async (_projectID, ownerUserId, options = {}) => {
      const branchNames = Array.isArray(options.branchNames) ? new Set(options.branchNames) : null;
      const deleted = tasks.filter((task) => (
        task.ownerUserId === ownerUserId
        && (!branchNames || branchNames.has(task.target?.branchName))
      ));
      tasks = tasks.filter((task) => !deleted.some((entry) => entry.id === task.id));
      return {
        deletedCount: deleted.length,
        deletedTaskIds: deleted.map((task) => task.id),
        tasks: tasks.map((task) => structuredClone(task)),
      };
    }),
  };
  runtime.updateScheduledTaskStateConditionally = vi.fn(async (
    _projectID,
    taskID,
    predicate,
    createUpdate,
  ) => {
    const index = tasks.findIndex((task) => task.id === taskID);
    if (index < 0) return { updated: false, task: null, tasks };
    const currentTask = tasks[index];
    if (!predicate(currentTask)) {
      return {
        updated: false,
        task: structuredClone(currentTask),
        tasks: tasks.map((task) => structuredClone(task)),
      };
    }
    const update = typeof createUpdate === 'function'
      ? createUpdate(currentTask)
      : createUpdate;
    tasks[index] = {
      ...currentTask,
      ...(typeof update?.enabled === 'boolean' ? { enabled: update.enabled } : {}),
      state: { ...currentTask.state, ...(update?.statePatch || update || {}) },
    };
    return {
      updated: true,
      task: structuredClone(tasks[index]),
      tasks: tasks.map((task) => structuredClone(task)),
    };
  });
  return runtime;
};

const createClient = () => ({
  generation: vi.fn(() => 2),
  sessions: {
    create: vi.fn(async () => ({ id: 'session-1' })),
    remove: vi.fn(async () => true),
  },
  prompts: {
    prompt: vi.fn(async () => true),
    command: vi.fn(async () => true),
  },
  catalog: {
    commands: vi.fn(async () => [{ name: 'wake' }]),
  },
});

const createRuntime = ({
  tasks,
  projects = [],
  managedProjectIDs = [],
  resolveTaskExecutionContext,
  resolveScheduledTaskAccess,
  maxRunDurationMs,
} = {}) => {
  const projectConfigRuntime = createTaskConfigRuntime(tasks || []);
  const client = createClient();
  const recordTaskSessionOwnership = vi.fn(async () => {});
  const runtime = createScheduledTasksRuntime({
    projectConfigRuntime,
    listProjects: vi.fn(async () => projects),
    listManagedProjectIDs: vi.fn(async () => managedProjectIDs),
    waitForOpenCodeReady: vi.fn(async () => {}),
    resolveTaskExecutionContext,
    resolveScheduledTaskAccess,
    recordTaskSessionOwnership,
    maxRunDurationMs,
    openCodeClient: client,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { runtime, projectConfigRuntime, client, recordTaskSessionOwnership };
};

it('checkpoint refuses a timed-out scheduled operation until its original promise settles', async () => {
  vi.useFakeTimers();
  const { runtime, client } = createRuntime({ tasks: [createTask()], projects: [{ id: 'project-1', path: '/fixture-project' }], maxRunDurationMs: 10 });
  let release;
  client.prompts.command.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await runtime.start();
  const run = runtime.runNow('project-1', 'task-1');
  await vi.advanceTimersByTimeAsync(10);
  expect(await run).toMatchObject({ ok: false, error: 'scheduled task run timed out' });
  expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
  expect(() => runtime.holdForCheckpoint()).toThrow('bundle_scheduled_tasks_unsettled');
  await expect(runtime.runNow('project-1', 'task-1')).rejects.toMatchObject({ code: 'bundle_scheduled_tasks_held' });
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(() => runtime.holdForCheckpoint()).not.toThrow();
  runtime.stop();
});

it('checkpoint includes an admitted status refresh before any running task exists', async () => {
  const { runtime } = createRuntime({ tasks: [createTask()], projects: [{ id: 'project-1', path: '/fixture-project' }] });
  await runtime.start();
  const refresh = runtime.refreshStatus();
  expect(() => runtime.holdForCheckpoint()).toThrow('bundle_scheduled_tasks_unsettled');
  await refresh;
  expect(() => runtime.holdForCheckpoint()).not.toThrow();
  runtime.stop();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });
});

describe('scheduled-tasks managed project execution', () => {
  it('separates enabled records from schedules with a future execution', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-04-16T14:00:00.000Z'));
    const tasks = [
      createTask({
        id: 'expired-once',
        schedule: { kind: 'once', date: '2026-04-16', time: '13:30', timezone: 'UTC' },
      }),
      createTask({
        id: 'future-once',
        schedule: { kind: 'once', date: '2026-04-16', time: '15:30', timezone: 'UTC' },
      }),
      createTask({ id: 'future-daily' }),
      createTask({ id: 'disabled', enabled: false }),
    ];
    const { runtime } = createRuntime({
      tasks,
      projects: [{ id: 'project-1', path: '/repo' }],
    });

    await runtime.start();
    expect(runtime.getStatus()).toMatchObject({
      hasEnabledScheduledTasks: true,
      enabledScheduledTasksCount: 3,
      hasPendingScheduledTasks: true,
      pendingScheduledTasksCount: 2,
      hasRunningScheduledTasks: false,
      runningScheduledTasksCount: 0,
    });
    runtime.stop();
  });

  it('clears quit risk after task deletion and project removal are synchronized', async () => {
    const projects = [{ id: 'project-1', path: '/repo' }];
    const { runtime, projectConfigRuntime } = createRuntime({
      tasks: [createTask()],
      projects,
    });

    await runtime.start();
    expect(runtime.getStatus().pendingScheduledTasksCount).toBe(1);

    projectConfigRuntime.replaceTasks([]);
    await runtime.syncProject('project-1');
    expect(runtime.getStatus().pendingScheduledTasksCount).toBe(0);

    projectConfigRuntime.replaceTasks([createTask()]);
    await runtime.syncProject('project-1');
    expect(runtime.getStatus().pendingScheduledTasksCount).toBe(1);
    projects.splice(0, projects.length);
    await runtime.syncAllProjects();
    expect(runtime.getStatus().pendingScheduledTasksCount).toBe(0);
    runtime.stop();
  });

  it('deletes definitively revoked tasks during startup reconciliation', async () => {
    const revokedTask = createTask({
      ownerUserId: 'owner-1',
      target: { branchName: 'main' },
    });
    const resolveScheduledTaskAccess = vi.fn(async () => ({ state: 'revoked' }));
    const { runtime, projectConfigRuntime } = createRuntime({
      tasks: [revokedTask],
      managedProjectIDs: ['project-1'],
      resolveScheduledTaskAccess,
    });

    await runtime.start();

    expect(projectConfigRuntime.deleteScheduledTask).toHaveBeenCalledWith('project-1', revokedTask.id);
    expect(runtime.getStatus()).toMatchObject({
      enabledScheduledTasksCount: 0,
      pendingScheduledTasksCount: 0,
      verified: true,
    });
    runtime.stop();
  });

  it('retains suspended-owner tasks without scheduling or quit risk', async () => {
    const dormantTask = createTask({
      ownerUserId: 'owner-1',
      target: { branchName: 'main' },
    });
    const { runtime, projectConfigRuntime } = createRuntime({
      tasks: [dormantTask],
      managedProjectIDs: ['project-1'],
      resolveScheduledTaskAccess: vi.fn(async () => ({ state: 'dormant' })),
    });

    await runtime.start();

    expect(projectConfigRuntime.deleteScheduledTask).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toMatchObject({
      enabledScheduledTasksCount: 1,
      pendingScheduledTasksCount: 0,
      verified: true,
    });
    runtime.stop();
  });

  it('retains tasks and marks status unverified when access lookup fails', async () => {
    const task = createTask({
      ownerUserId: 'owner-1',
      target: { branchName: 'main' },
    });
    const { runtime, projectConfigRuntime } = createRuntime({
      tasks: [task],
      managedProjectIDs: ['project-1'],
      resolveScheduledTaskAccess: vi.fn(async () => {
        throw Object.assign(new Error('control plane unavailable'), { code: 'control_plane_unavailable' });
      }),
    });

    await runtime.start();

    expect(projectConfigRuntime.deleteScheduledTask).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toMatchObject({
      enabledScheduledTasksCount: 1,
      pendingScheduledTasksCount: 0,
      verified: false,
    });
    runtime.stop();
  });

  it('rechecks access before a run and deletes a newly revoked task without creating a session', async () => {
    let state = 'runnable';
    const task = createTask({
      ownerUserId: 'owner-1',
      target: { branchName: 'main' },
    });
    const { runtime, projectConfigRuntime, client } = createRuntime({
      tasks: [task],
      managedProjectIDs: ['project-1'],
      resolveScheduledTaskAccess: vi.fn(async () => ({ state })),
    });
    await runtime.start();
    state = 'revoked';

    const result = await runtime.runNow('project-1', task.id);

    expect(result).toMatchObject({ ok: false, skipped: true, revoked: true });
    expect(projectConfigRuntime.deleteScheduledTask).toHaveBeenCalledWith('project-1', task.id);
    expect(client.sessions.create).not.toHaveBeenCalled();
    expect(runtime.getStatus().pendingScheduledTasksCount).toBe(0);
    runtime.stop();
  });

  it('reports a running task independently from its future schedule', async () => {
    let finishRun;
    const runGate = new Promise((resolve) => {
      finishRun = resolve;
    });
    const task = createTask({
      schedule: { kind: 'once', date: '2025-01-01', time: '00:00', timezone: 'UTC' },
    });
    const { runtime, client } = createRuntime({
      tasks: [task],
      projects: [{ id: 'project-1', path: '/repo' }],
    });
    client.prompts.command.mockImplementation(() => runGate);

    await runtime.start();
    const run = runtime.runNow('project-1', task.id);
    for (let attempt = 0; attempt < 20 && client.prompts.command.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(client.prompts.command).toHaveBeenCalled();
    expect(runtime.getStatus()).toMatchObject({
      pendingScheduledTasksCount: 0,
      hasRunningScheduledTasks: true,
      runningScheduledTasksCount: 1,
    });

    finishRun({ data: true });
    await run;
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
    runtime.stop();
  });

  it('restores and manually runs an owner-scoped task without a local settings path', async () => {
    const task = createTask({
      ownerUserId: 'user-1',
      target: { branchName: 'main' },
    });
    const resolveTaskExecutionContext = vi.fn(async () => ({ directory: '/managed/worktree' }));
    const { runtime, client, recordTaskSessionOwnership } = createRuntime({
      tasks: [task],
      managedProjectIDs: ['managed-project'],
      resolveTaskExecutionContext,
    });

    await runtime.start();
    expect(runtime.getStatus().enabledScheduledTasksCount).toBe(1);

    const result = await runtime.runNow('managed-project', task.id);

    expect(result.ok).toBe(true);
    expect(resolveTaskExecutionContext).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      projectId: 'managed-project',
      branchName: 'main',
      taskId: task.id,
    });
    expect(client.sessions.create).toHaveBeenCalledWith({
      directory: '/managed/worktree',
      title: expect.stringContaining('Wake up '),
    }, { directory: '/managed/worktree' });
    expect(recordTaskSessionOwnership).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      projectId: 'managed-project',
      branchName: 'main',
      sessionId: 'session-1',
    });
    runtime.stop();
  });

  it('runs a restored managed timer against the live assigned directory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T07:59:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const task = createTask({
      ownerUserId: 'user-1',
      target: { branchName: 'main' },
    });
    const resolveTaskExecutionContext = vi.fn(async () => ({ directory: '/managed/worktree' }));
    const { runtime, client } = createRuntime({
      tasks: [task],
      managedProjectIDs: ['managed-project'],
      resolveTaskExecutionContext,
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resolveTaskExecutionContext).toHaveBeenCalledTimes(1);
    expect(client.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/managed/worktree',
    }), { directory: '/managed/worktree' });
    runtime.stop();
  });

  it('fails closed when the live owner or branch assignment is unavailable', async () => {
    const task = createTask({
      ownerUserId: 'user-1',
      target: { branchName: 'main' },
    });
    const resolveTaskExecutionContext = vi.fn(async () => {
      throw new Error('Scheduled task branch access has been revoked');
    });
    const { runtime, client } = createRuntime({
      tasks: [task],
      managedProjectIDs: ['managed-project'],
      resolveTaskExecutionContext,
    });

    await runtime.start();
    const result = await runtime.runNow('managed-project', task.id);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Scheduled task branch access has been revoked');
    expect(client.sessions.create).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('keeps ownerless legacy tasks on their local settings project path', async () => {
    const task = createTask();
    const resolveTaskExecutionContext = vi.fn();
    const { runtime, client } = createRuntime({
      tasks: [task],
      projects: [{ id: 'local-project', path: '/local/project' }],
      resolveTaskExecutionContext,
    });

    await runtime.start();
    const result = await runtime.runNow('local-project', task.id);

    expect(result.ok).toBe(true);
    expect(resolveTaskExecutionContext).not.toHaveBeenCalled();
    expect(client.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/local/project',
    }), { directory: '/local/project' });
    runtime.stop();
  });
});

describe('scheduled-tasks cross-process occurrence claims', () => {
  const scheduleCases = [
    ['daily', { kind: 'daily', times: ['08:00'], timezone: 'UTC' }],
    ['weekly', { kind: 'weekly', times: ['08:00'], weekdays: [1], timezone: 'UTC' }],
    ['cron', { kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' }],
    ['one-time', { kind: 'once', date: '2026-08-17', time: '08:00', timezone: 'UTC' }],
  ];

  it.each(scheduleCases)('dispatches one %s occurrence across two runtimes', async (_label, schedule) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T07:59:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devryan-scheduler-claim-'));
    const createConfigRuntime = () => createProjectConfigRuntime({
      fsPromises,
      path,
      projectsDirPath: tempRoot,
      projectLockOptions: { wait: async () => {}, retryMs: 1 },
    });
    const firstConfig = createConfigRuntime();
    const secondConfig = createConfigRuntime();
    const clients = [createClient(), createClient()];
    const createScheduler = (projectConfigRuntime, client) => createScheduledTasksRuntime({
      projectConfigRuntime,
      listProjects: vi.fn(async () => [{ id: 'project-1', path: '/repo' }]),
          waitForOpenCodeReady: vi.fn(async () => {}),
      openCodeClient: client,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const firstScheduler = createScheduler(firstConfig, clients[0]);
    const secondScheduler = createScheduler(secondConfig, clients[1]);

    try {
      await firstConfig.upsertScheduledTask('project-1', {
        id: 'shared-task',
        name: 'Shared task',
        enabled: true,
        schedule,
        execution: {
          providerID: 'provider-1',
          modelID: 'model-1',
          prompt: '/wake',
        },
      });

      await firstScheduler.start();
      await secondScheduler.start();
      const scheduledFor = Date.parse('2026-08-17T08:00:00.000Z');
      await vi.advanceTimersByTimeAsync(60_000);

      let persistedTask;
      // Timer dispatch returns before the cross-process terminal write finishes.
      await vi.waitFor(async () => {
        [persistedTask] = await firstConfig.listScheduledTasks('project-1');
        expect(persistedTask?.state?.lastScheduledFor).toBe(scheduledFor);
        expect(persistedTask.state.lastStatus).toBe('success');
      }, { timeout: 2_000 });

      const dispatchCount = clients.reduce(
        (total, client) => total + client.sessions.create.mock.calls.length,
        0,
      );
      expect(dispatchCount).toBe(1);
      expect(persistedTask.state.lastScheduledFor).toBe(scheduledFor);
      expect(persistedTask.state.lastStatus).toBe('success');
      if (schedule.kind === 'once') {
        expect(persistedTask.enabled).toBe(false);
        expect(persistedTask.state.nextRunAt).toBeUndefined();
      } else {
        expect(persistedTask.state.nextRunAt).toBeGreaterThan(scheduledFor);
      }

      const restartClient = createClient();
      const restartScheduler = createScheduler(createConfigRuntime(), restartClient);
      await restartScheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(restartClient.sessions.create).not.toHaveBeenCalled();
      restartScheduler.stop();
    } finally {
      for (let attempt = 0; attempt < 200
        && [firstScheduler, secondScheduler].some(
          (scheduler) => scheduler.getStatus().runningScheduledTasksCount > 0,
        ); attempt += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      firstScheduler.stop();
      secondScheduler.stop();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('releases its slot and records a scheduled claim lock failure without dispatching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T07:59:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const dueAt = Date.parse('2026-08-17T08:00:00.000Z');
    const { runtime, projectConfigRuntime, client } = createRuntime({
      tasks: [createTask({ state: { nextRunAt: dueAt } })],
      projects: [{ id: 'project-1', path: '/repo' }],
    });
    const timeoutError = Object.assign(new Error('Timed out acquiring cross-process file lock'), {
      code: 'LOCK_TIMEOUT',
    });
    projectConfigRuntime.updateScheduledTaskStateConditionally.mockRejectedValueOnce(timeoutError);

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let attempt = 0; attempt < 20
      && projectConfigRuntime.updateScheduledTaskStateConditionally.mock.calls.length < 2;
      attempt += 1) {
      await Promise.resolve();
    }

    expect(client.sessions.create).not.toHaveBeenCalled();
    expect(projectConfigRuntime.updateScheduledTaskStateConditionally).toHaveBeenCalledTimes(2);
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
    runtime.stop();
  });

  it('claims a persisted past occurrence once without arming a loser zero-delay timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T08:01:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const dueAt = Date.parse('2026-08-17T08:00:00.000Z');
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devryan-scheduler-past-'));
    const createConfigRuntime = () => createProjectConfigRuntime({
      fsPromises,
      path,
      projectsDirPath: tempRoot,
      projectLockOptions: { wait: async () => {}, retryMs: 1 },
    });
    const firstConfig = createConfigRuntime();
    const secondConfig = createConfigRuntime();
    const clients = [createClient(), createClient()];
    const createScheduler = (projectConfigRuntime, client) => createScheduledTasksRuntime({
      projectConfigRuntime,
      listProjects: vi.fn(async () => [{ id: 'project-1', path: '/repo' }]),
          openCodeClient: client,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const schedulers = [
      createScheduler(firstConfig, clients[0]),
      createScheduler(secondConfig, clients[1]),
    ];

    try {
      await firstConfig.upsertScheduledTask('project-1', createTask({
        id: 'past-task',
        state: { nextRunAt: dueAt },
      }));
      await schedulers[0].start();
      await schedulers[1].start();
      await vi.advanceTimersByTimeAsync(0);

      let persistedTask;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        [persistedTask] = await firstConfig.listScheduledTasks('project-1');
        if (persistedTask?.state?.lastStatus === 'success') break;
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(clients.reduce(
        (total, client) => total + client.sessions.create.mock.calls.length,
        0,
      )).toBe(1);
      expect(persistedTask.state.lastScheduledFor).toBe(dueAt);
      expect(persistedTask.state.nextRunAt).toBeGreaterThan(Date.now());
    } finally {
      for (let attempt = 0; attempt < 200
        && schedulers.some((scheduler) => scheduler.getStatus().runningScheduledTasksCount > 0);
        attempt += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      schedulers.forEach((scheduler) => scheduler.stop());
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns a successful manual session with persistError after both terminal writes fail', async () => {
    const now = Date.parse('2026-08-17T07:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { runtime, projectConfigRuntime } = createRuntime({
      tasks: [createTask({ state: { nextRunAt: Date.parse('2026-08-17T08:00:00.000Z') } })],
      projects: [{ id: 'project-1', path: '/repo' }],
    });
    await runtime.start();
    const defaultUpdate = projectConfigRuntime.updateScheduledTaskState.getMockImplementation();
    const persistenceError = new Error('state store unavailable');
    projectConfigRuntime.updateScheduledTaskState
      .mockImplementationOnce(defaultUpdate)
      .mockRejectedValueOnce(persistenceError)
      .mockRejectedValueOnce(persistenceError);

    const result = await runtime.runNow('project-1', 'task-1');

    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      sessionID: 'session-1',
      persistError: 'state store unavailable',
    });
    expect(projectConfigRuntime.updateScheduledTaskState).toHaveBeenCalledTimes(3);
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
    runtime.stop();
  });
});

describe('scheduled-tasks execution on gen 2 (openCodeClient)', () => {
  const createOpenCodeClient = ({ generation = 2, commands = [{ name: 'wake' }] } = {}) => ({
    generation: vi.fn(() => {
      if (generation instanceof Error) throw generation;
      return generation;
    }),
    sessions: {
      create: vi.fn(async () => ({ id: 'ses_v2', version: '2' })),
      remove: vi.fn(async () => true),
    },
    catalog: {
      commands: vi.fn(async () => {
        if (commands instanceof Error) throw commands;
        return commands;
      }),
    },
    prompts: {
      prompt: vi.fn(async () => true),
      command: vi.fn(async () => true),
    },
  });

  const createGen2Runtime = ({ tasks, openCodeClient, recordTaskSessionOwnership = vi.fn(async () => {}), waitForOpenCodeReady = vi.fn(async () => {}) }) => {
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: createTaskConfigRuntime(tasks),
      listProjects: vi.fn(async () => [{ id: 'project-1', path: '/repo' }]),
      listManagedProjectIDs: vi.fn(async () => []),
          waitForOpenCodeReady,
      recordTaskSessionOwnership,
      openCodeClient,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    return { runtime, recordTaskSessionOwnership };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, null, { sessions: {} }])('rejects a missing or malformed client %j', openCodeClient => {
    expect(() => createGen2Runtime({ tasks: [], openCodeClient }))
      .toThrow('openCodeClient must be an openCodeClient');
  });

  it('creates the session and runs a matching slash command through the client', async () => {
    const openCodeClient = createOpenCodeClient();
    const task = createTask({ execution: { providerID: 'provider-1', modelID: 'model-1', prompt: '/wake now', agent: 'build', variant: 'high' } });
    const { runtime } = createGen2Runtime({ tasks: [task], openCodeClient });
    await runtime.start();

    const result = await runtime.runNow('project-1', task.id);

    expect(result).toMatchObject({ ok: true, sessionID: 'ses_v2' });
    expect(openCodeClient.sessions.create).toHaveBeenCalledWith(
      { directory: '/repo', title: expect.stringContaining('Wake up ') },
      { directory: '/repo' },
    );
    expect(openCodeClient.catalog.commands).toHaveBeenCalledWith({ directory: '/repo' });
    expect(openCodeClient.prompts.command).toHaveBeenCalledWith('ses_v2', {
      command: 'wake',
      arguments: 'now',
      agent: 'build',
      model: 'provider-1/model-1',
      variant: 'high',
    }, { directory: '/repo' });
    expect(openCodeClient.prompts.prompt).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('prompts through the client when the prompt is not a known command', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const openCodeClient = createOpenCodeClient({ commands: new Error('catalog unavailable') });
    const task = createTask({ execution: { providerID: 'provider-1', modelID: 'model-1', prompt: '/wake' } });
    const plain = createTask({ id: 'task-2', execution: { providerID: 'provider-1', modelID: 'model-1', prompt: 'Summarize' } });
    const { runtime } = createGen2Runtime({ tasks: [task, plain], openCodeClient });
    await runtime.start();

    await expect(runtime.runNow('project-1', task.id)).resolves.toMatchObject({ ok: true });
    await expect(runtime.runNow('project-1', plain.id)).resolves.toMatchObject({ ok: true });

    expect(openCodeClient.prompts.command).not.toHaveBeenCalled();
    expect(openCodeClient.prompts.prompt).toHaveBeenNthCalledWith(1, 'ses_v2', {
      model: { providerID: 'provider-1', modelID: 'model-1' },
      parts: [{ type: 'text', text: '/wake' }],
    }, { directory: '/repo' });
    expect(openCodeClient.prompts.prompt).toHaveBeenNthCalledWith(2, 'ses_v2', {
      model: { providerID: 'provider-1', modelID: 'model-1' },
      parts: [{ type: 'text', text: 'Summarize' }],
    }, { directory: '/repo' });
    expect(fetchSpy).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('removes the session through the client when ownership cannot be recorded', async () => {
    const openCodeClient = createOpenCodeClient();
    const task = createTask({ ownerUserId: 'user-1', target: { branchName: 'main' } });
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: createTaskConfigRuntime([task]),
      listProjects: vi.fn(async () => []),
      listManagedProjectIDs: vi.fn(async () => ['managed-project']),
          resolveTaskExecutionContext: vi.fn(async () => ({ directory: '/managed/worktree' })),
      recordTaskSessionOwnership: vi.fn(async () => { throw new Error('ownership store unavailable'); }),
      openCodeClient,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await runtime.start();

    const result = await runtime.runNow('managed-project', task.id);

    expect(result).toMatchObject({ ok: false, error: 'ownership store unavailable' });
    expect(openCodeClient.sessions.remove).toHaveBeenCalledWith('ses_v2', { directory: '/managed/worktree', allowNotFound: true });
    expect(openCodeClient.prompts.prompt).not.toHaveBeenCalled();
    expect(openCodeClient.prompts.command).not.toHaveBeenCalled();
    runtime.stop();
  });

  it.each([1, 3, null, undefined])('refuses generation %s before session creation', async (generation) => {
    const openCodeClient = createOpenCodeClient({ generation });
    // The fixture default must not convert an absent identity to generation 2.
    openCodeClient.generation.mockReturnValue(generation);
    const { runtime } = createGen2Runtime({ tasks: [createTask()], openCodeClient });
    await runtime.start();
    await expect(runtime.runNow('project-1', 'task-1')).resolves.toMatchObject({
      ok: false, error: 'The OpenCode runtime generation is unknown',
    });
    expect(openCodeClient.sessions.create).not.toHaveBeenCalled();
    expect(openCodeClient.prompts.command).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('rechecks identity after readiness before creating a session', async () => {
    const openCodeClient = createOpenCodeClient();
    const { runtime } = createGen2Runtime({
      tasks: [createTask()], openCodeClient,
      waitForOpenCodeReady: async () => { openCodeClient.generation.mockReturnValue(1); },
    });
    await runtime.start();
    await expect(runtime.runNow('project-1', 'task-1')).resolves.toMatchObject({ ok: false, error: 'The OpenCode runtime generation is unknown' });
    expect(openCodeClient.sessions.create).not.toHaveBeenCalled();
    expect(openCodeClient.prompts.prompt).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('propagates an identity failure before creating a session', async () => {
    const openCodeClient = createOpenCodeClient({ generation: new Error('identity unavailable') });
    const { runtime } = createGen2Runtime({ tasks: [createTask()], openCodeClient });
    await runtime.start();
    await expect(runtime.runNow('project-1', 'task-1')).resolves.toMatchObject({ ok: false, error: 'identity unavailable' });
    expect(openCodeClient.sessions.create).not.toHaveBeenCalled();
    runtime.stop();
  });

});
