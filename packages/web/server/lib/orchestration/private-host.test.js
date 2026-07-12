import { describe, expect, it, vi } from 'vitest';

import { createManagedOrchestrationPrivateHost } from './private-host.js';

const callRpc = (environment, body, options = {}) => fetch(environment.DEVRYAN_ORCHESTRATION_URL, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${options.token ?? environment.DEVRYAN_ORCHESTRATION_TOKEN}`,
    'content-type': 'application/json',
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('managed orchestration private host', () => {
  it('binds IPv4 loopback and requires its random bearer token', async () => {
    const handleRpc = vi.fn(async ({ method, params }) => ({ method, params }));
    const host = createManagedOrchestrationPrivateHost({ handleRpc });
    const environment = await host.start();

    try {
      expect(environment.DEVRYAN_ORCHESTRATION_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rpc$/);
      expect(environment.DEVRYAN_ORCHESTRATION_TOKEN.length).toBeGreaterThanOrEqual(32);
      expect(host.getDiagnostics()).toMatchObject({
        address: '127.0.0.1',
        activeRequests: 0,
        started: true,
      });

      const unauthorized = await callRpc(environment, { method: 'status', params: {} }, {
        token: 'wrong-token',
      });
      expect(unauthorized.status).toBe(401);
      expect(handleRpc).not.toHaveBeenCalled();

      const accepted = await callRpc(environment, {
        method: 'status',
        params: { taskId: 'dvr_task_1' },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({
        ok: true,
        result: { method: 'status', params: { taskId: 'dvr_task_1' } },
      });
      expect(handleRpc).toHaveBeenCalledTimes(1);
    } finally {
      await host.stop();
    }
  });

  it('rejects oversized or malformed bodies without invoking the scheduler', async () => {
    const handleRpc = vi.fn();
    const host = createManagedOrchestrationPrivateHost({
      handleRpc,
      maxBodyBytes: 64,
    });
    const environment = await host.start();

    try {
      const oversized = await callRpc(environment, JSON.stringify({
        method: 'submit',
        params: { prompt: 'x'.repeat(128) },
      }));
      expect(oversized.status).toBe(413);

      const malformed = await callRpc(environment, '{bad-json');
      expect(malformed.status).toBe(400);
      expect(handleRpc).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
  });

  it('maps deterministic RPC errors and releases its listener on stop', async () => {
    const host = createManagedOrchestrationPrivateHost({
      handleRpc: async () => {
        const error = new Error('task was not found');
        error.code = 'task_not_found';
        error.statusCode = 404;
        throw error;
      },
    });
    const firstEnvironment = await host.start();
    expect(await host.start()).toEqual(firstEnvironment);

    const response = await callRpc(firstEnvironment, { method: 'status', params: {} });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'task_not_found', message: 'task was not found' },
    });

    await host.stop();
    await host.stop();
    expect(host.getDiagnostics()).toMatchObject({ started: false, activeRequests: 0 });
    await expect(callRpc(firstEnvironment, { method: 'status', params: {} })).rejects.toThrow();
  });
});
