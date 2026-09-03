import { describe, expect, it, vi } from 'vitest';
import express from 'express';

import request from '../../test-supertest.js';
import { registerProcessesRoutes } from './routes.js';

const createRuntime = () => ({
  snapshot: vi.fn(async ({ directory } = {}) => ({
    supported: true,
    processes: [{ pid: 201, ppid: 200, pgid: 100, startedAt: 10, ageMs: 5, command: 'vite', category: 'dev_server', ports: [5173], sessionId: 'ses_a', workingDirectory: directory ?? null }],
    orphanServers: [],
  })),
  stopProcess: vi.fn(async ({ pid, startedAt }) => ({ pid, terminated: true, stoppedDescendants: [], startedAt })),
  getProjectSetting: vi.fn(async (directory) => ({ directory, trackAgentProcesses: false, heavyCheckSlots: 2 })),
  setProjectSetting: vi.fn(async (directory, value) => ({ directory, trackAgentProcesses: value.trackAgentProcesses === true, heavyCheckSlots: value.heavyCheckSlots ?? 2 })),
});

const createApp = ({ principal, runtime = createRuntime() } = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (principal !== undefined) req.principal = principal;
    next();
  });
  registerProcessesRoutes(app, { runtime });
  return { app, runtime };
};

describe('processes routes', () => {
  it('rejects managed principals on every route with 403', async () => {
    const { app, runtime } = createApp({ principal: { scope: 'managed', id: 'user-1', role: 'admin' } });

    const responses = await Promise.all([
      request(app).get('/api/processes?directory=/repo'),
      request(app).post('/api/processes/201/stop').send({ startedAt: 10 }),
      request(app).get('/api/processes/project?directory=/repo'),
      request(app).put('/api/processes/project').send({ directory: '/repo', trackAgentProcesses: true }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('forbidden');
    }
    expect(runtime.snapshot).not.toHaveBeenCalled();
    expect(runtime.stopProcess).not.toHaveBeenCalled();
    expect(runtime.setProjectSetting).not.toHaveBeenCalled();
  });

  it('serves the snapshot to the local administrator', async () => {
    const { app, runtime } = createApp({ principal: { scope: 'local-admin', role: 'admin' } });
    const response = await request(app).get('/api/processes?directory=/repo');

    expect(response.status).toBe(200);
    expect(response.body.processes[0]).toMatchObject({ pid: 201, workingDirectory: '/repo' });
    expect(runtime.snapshot).toHaveBeenCalledWith({ directory: '/repo' });
  });

  it('treats requests without a principal (single-user mode) as local', async () => {
    const { app } = createApp();
    expect((await request(app).get('/api/processes')).status).toBe(200);
  });

  it('forwards pid and startedAt to the stop guard and maps runtime errors', async () => {
    const { app, runtime } = createApp({ principal: { scope: 'local-admin' } });
    const ok = await request(app).post('/api/processes/201/stop').send({ startedAt: 10 });
    expect(ok.status).toBe(200);
    expect(runtime.stopProcess).toHaveBeenCalledWith({ pid: 201, startedAt: 10 });

    runtime.stopProcess.mockImplementationOnce(async () => {
      const error = new Error('restarted');
      error.statusCode = 409;
      error.code = 'process_restarted';
      throw error;
    });
    const conflict = await request(app).post('/api/processes/201/stop').send({ startedAt: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: 'restarted', code: 'process_restarted' });
  });

  it('reads and writes the project tracking setting', async () => {
    const { app, runtime } = createApp({ principal: { scope: 'local-admin' } });
    const read = await request(app).get('/api/processes/project?directory=/repo');
    expect(read.body).toEqual({ directory: '/repo', trackAgentProcesses: false, heavyCheckSlots: 2 });

    const written = await request(app).put('/api/processes/project').send({ directory: '/repo', trackAgentProcesses: true, heavyCheckSlots: 0 });
    expect(written.status).toBe(200);
    expect(runtime.setProjectSetting).toHaveBeenCalledWith('/repo', { trackAgentProcesses: true, heavyCheckSlots: 0 });
    expect(written.body).toEqual({ directory: '/repo', trackAgentProcesses: true, heavyCheckSlots: 0 });
  });
});
