import { afterEach, describe, expect, it, vi } from 'vitest';

import { canReceiveProjectMetadataEvent, registerScheduledTaskRoutes } from './routes.js';

const createRegistry = () => {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'put', 'post', 'delete']) {
    app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  }
  return { app, route: (method, path) => routes.get(`${method} ${path}`) };
};

const response = () => ({
  statusCode: 200,
  payload: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.payload = payload; return this; },
});

const developer = {
  id: 'user-1',
  scope: 'managed',
  role: 'developer',
  assignments: [{ projectId: 'project-1', branchName: 'dev', isDefault: true }],
};

const dependencies = (tasks) => ({
  readSettingsFromDiskMigrated: async () => ({ projects: [] }),
  sanitizeProjects: (projects) => projects,
  resolveManagedProject: async () => ({ project: { id: 'project-1', path: '/repo' } }),
  projectConfigRuntime: {
    listScheduledTasks: vi.fn(async () => tasks),
    upsertScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
  },
  scheduledTasksRuntime: { syncProject: vi.fn(), runNow: vi.fn() },
  getOpenChamberEventClients: () => new Set(),
  writeSseEvent: vi.fn(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('personal scheduled-task routes', () => {
  it('reports future schedules separately from enabled records', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-04-16T14:00:00.000Z'));
    const tasks = [
      {
        id: 'expired',
        ownerUserId: 'user-1',
        enabled: true,
        schedule: { kind: 'once', date: '2026-04-16', time: '13:30', timezone: 'UTC' },
        state: { lastStatus: 'idle' },
      },
      {
        id: 'future',
        ownerUserId: 'user-1',
        enabled: true,
        schedule: { kind: 'once', date: '2026-04-16', time: '15:30', timezone: 'UTC' },
        state: { lastStatus: 'idle' },
      },
    ];
    const { app, route } = createRegistry();
    registerScheduledTaskRoutes(app, dependencies(tasks));
    const res = response();

    await route('GET', '/api/openchamber/scheduled-tasks/status')({ principal: developer }, res);

    expect(res.payload).toMatchObject({
      enabledScheduledTasksCount: 2,
      hasEnabledScheduledTasks: true,
      pendingScheduledTasksCount: 1,
      hasPendingScheduledTasks: true,
    });
  });

  it('scopes project metadata events to administrators and assigned projects', () => {
    expect(canReceiveProjectMetadataEvent({ isAdmin: true, projectIds: new Set() }, 'project-1')).toBe(true);
    expect(canReceiveProjectMetadataEvent({ isAdmin: false, projectIds: new Set(['project-1']) }, 'project-1')).toBe(true);
    expect(canReceiveProjectMetadataEvent({ isAdmin: false, projectIds: new Set(['project-2']) }, 'project-1')).toBe(false);
    expect(canReceiveProjectMetadataEvent({ isAdmin: false }, 'project-1')).toBe(false);
  });

  it('lists only tasks owned by the managed developer', async () => {
    const { app, route } = createRegistry();
    const tasks = [
      { id: 'mine', ownerUserId: 'user-1' },
      { id: 'theirs', ownerUserId: 'user-2' },
      { id: 'legacy' },
    ];
    registerScheduledTaskRoutes(app, dependencies(tasks));
    const res = response();
    await route('GET', '/api/projects/:projectId/scheduled-tasks')({
      params: { projectId: 'project-1' }, principal: developer,
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.tasks.map((task) => task.id)).toEqual(['mine']);
  });

  it('hides another user task mutations while administrators can list legacy tasks', async () => {
    const { app, route } = createRegistry();
    const deps = dependencies([{ id: 'theirs', ownerUserId: 'user-2' }, { id: 'legacy' }]);
    registerScheduledTaskRoutes(app, deps);
    const denied = response();
    await route('DELETE', '/api/projects/:projectId/scheduled-tasks/:taskId')({
      params: { projectId: 'project-1', taskId: 'theirs' }, principal: developer,
    }, denied);
    expect(denied.statusCode).toBe(404);
    expect(deps.projectConfigRuntime.deleteScheduledTask).not.toHaveBeenCalled();

    const adminResponse = response();
    await route('GET', '/api/projects/:projectId/scheduled-tasks')({
      params: { projectId: 'project-1' },
      principal: { ...developer, id: 'admin-1', role: 'admin' },
    }, adminResponse);
    expect(adminResponse.payload.tasks.map((task) => task.id)).toEqual(['theirs', 'legacy']);
  });
});
