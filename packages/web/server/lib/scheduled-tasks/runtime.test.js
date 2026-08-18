import { afterEach, describe, expect, it, vi } from 'vitest';
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
  return {
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
  };
};

const createClient = () => ({
  session: {
    create: vi.fn(async () => ({ data: { id: 'session-1' } })),
    command: vi.fn(async () => ({ data: true })),
    delete: vi.fn(async () => ({ data: true })),
  },
  command: {
    list: vi.fn(async () => ({ data: [{ name: 'wake' }] })),
  },
});

const createRuntime = ({
  tasks,
  projects = [],
  managedProjectIDs = [],
  resolveTaskExecutionContext,
} = {}) => {
  const projectConfigRuntime = createTaskConfigRuntime(tasks || []);
  const client = createClient();
  const recordTaskSessionOwnership = vi.fn(async () => {});
  const runtime = createScheduledTasksRuntime({
    projectConfigRuntime,
    listProjects: vi.fn(async () => projects),
    listManagedProjectIDs: vi.fn(async () => managedProjectIDs),
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: vi.fn(async () => {}),
    resolveTaskExecutionContext,
    recordTaskSessionOwnership,
    createClient: () => client,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { runtime, projectConfigRuntime, client, recordTaskSessionOwnership };
};

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
    expect(client.session.create).toHaveBeenCalledWith({
      directory: '/managed/worktree',
      title: expect.stringContaining('Wake up '),
    });
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
    expect(client.session.create).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/managed/worktree',
    }));
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
    expect(client.session.create).not.toHaveBeenCalled();
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
    expect(client.session.create).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/local/project',
    }));
    runtime.stop();
  });
});
