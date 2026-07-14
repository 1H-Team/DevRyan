import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import { registerManagedOrchestrationRoutes } from './routes.js';

describe('managed orchestration UI routes', () => {
  it('serves a safe authoritative snapshot without private queue input', async () => {
    const runtime = {
      getSnapshot: vi.fn(async () => ({
        available: true,
        bridgeReady: true,
        recoveryWarning: null,
        tasks: [{ owner: 'devryan', taskId: 'dvr_task_1', rootSessionId: 'ses_root' }],
        resultEnvelopes: [],
      })),
      handleRpc: vi.fn(),
    };
    const app = express();
    registerManagedOrchestrationRoutes(app, { runtime, express });

    const response = await request(app)
      .get('/api/orchestration/snapshot')
      .query({ rootSessionId: 'ses_root' });

    expect(response.status).toBe(200);
    expect(response.body.tasks[0]).not.toHaveProperty('prompt');
    expect(response.body.tasks[0]).not.toHaveProperty('idempotencyKey');
    expect(runtime.getSnapshot).toHaveBeenCalledWith({ rootSessionId: 'ses_root' });
  });

  it('routes task status, cancellation, and acknowledgement with root scope', async () => {
    const runtime = {
      getSnapshot: vi.fn(),
      handleRpc: vi.fn(async ({ method, params }) => ({ method, params })),
    };
    const app = express();
    registerManagedOrchestrationRoutes(app, { runtime, express });

    const status = await request(app)
      .get('/api/orchestration/task/dvr_task_1')
      .query({ rootSessionId: 'ses_root', directory: '/workspace' });
    expect(status.status).toBe(200);
    expect(status.body.method).toBe('status');

    const cancel = await request(app)
      .post('/api/orchestration/task/dvr_task_1/cancel')
      .send({ rootSessionId: 'ses_root', directory: '/workspace', cascade: false });
    expect(cancel.status).toBe(200);
    expect(cancel.body.method).toBe('cancel');

    const acknowledge = await request(app)
      .post('/api/orchestration/task/dvr_task_1/acknowledge')
      .send({
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry_in_place',
        idempotencyKey: 'retry-1',
        providerId: 'openai',
        modelId: 'gpt-5.4',
        variant: 'high',
      });
    expect(acknowledge.status).toBe(200);
    expect(acknowledge.body.method).toBe('acknowledge');
    expect(runtime.handleRpc.mock.calls.map(([input]) => input.method)).toEqual([
      'status',
      'cancel',
      'acknowledge',
    ]);
  });

  it('routes the public handoff body through the shared runtime contract', async () => {
    const runtime = {
      getSnapshot: vi.fn(),
      handleRpc: vi.fn(async ({ method, params }) => ({ method, params })),
    };
    const app = express();
    registerManagedOrchestrationRoutes(app, { runtime, express });
    const body = {
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      confirm: true,
      idempotencyKey: 'switch-route-01',
    };

    const response = await request(app)
      .post('/api/orchestration/handoff')
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ method: 'handoff', params: body });
    expect(runtime.handleRpc).toHaveBeenCalledWith({ method: 'handoff', params: body });
  });

  it('returns deterministic recoverable errors and enforces the body limit', async () => {
    const runtime = {
      getSnapshot: vi.fn(),
      handleRpc: vi.fn(async () => {
        const error = new Error('task was not found');
        error.code = 'task_not_found';
        error.statusCode = 404;
        throw error;
      }),
    };
    const app = express();
    registerManagedOrchestrationRoutes(app, { runtime, express, jsonLimit: '1kb' });

    const missing = await request(app)
      .get('/api/orchestration/task/dvr_task_missing')
      .query({ rootSessionId: 'ses_root' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      ok: false,
      error: { code: 'task_not_found', message: 'task was not found' },
    });

    const oversized = await request(app)
      .post('/api/orchestration/task/dvr_task_1/cancel')
      .send({ rootSessionId: 'ses_root', reason: 'x'.repeat(2_000) });
    expect(oversized.status).toBe(413);
    expect(runtime.handleRpc).toHaveBeenCalledTimes(1);
  });
});
