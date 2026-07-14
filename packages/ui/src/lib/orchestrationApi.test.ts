import { describe, expect, test } from 'bun:test';

import { createManagedOrchestrationApi, ManagedOrchestrationApiError } from './orchestrationApi';

describe('managed orchestration API', () => {
  test('preserves authoritative status, code, and message', async () => {
    const api = createManagedOrchestrationApi({
      fetchImpl: async () => Response.json({
        ok: false,
        error: { code: 'task_scope_mismatch', message: 'wrong root' },
      }, { status: 403 }),
    });

    try {
      await api.getTask('dvr_task_1', { rootSessionId: 'ses_root', directory: '/workspace' });
      throw new Error('expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedOrchestrationApiError);
      const apiError = error as ManagedOrchestrationApiError;
      expect(apiError.status).toBe(403);
      expect(apiError.code).toBe('task_scope_mismatch');
      expect(apiError.message).toBe('wrong root');
    }
  });

  test('encodes task identity and sends scoped cancellation and acknowledgement bodies', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const api = createManagedOrchestrationApi({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ task: { taskId: 'dvr_task_1' } });
      },
    });

    await api.cancelTask('dvr_task_1/unsafe', {
      rootSessionId: 'ses_root',
      directory: '/workspace',
      reason: 'stop only this child',
      cascade: false,
    });
    await api.acknowledgeTask('dvr_task_1', {
      rootSessionId: 'ses_root',
      directory: '/workspace',
      action: 'retry',
      idempotencyKey: 'retry-key',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });

    expect(requests.map(({ url }) => url)).toEqual([
      '/api/orchestration/task/dvr_task_1%2Funsafe/cancel',
      '/api/orchestration/task/dvr_task_1/acknowledge',
    ]);
    expect(requests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      {
        rootSessionId: 'ses_root',
        directory: '/workspace',
        reason: 'stop only this child',
        cascade: false,
      },
      {
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'retry-key',
        providerId: 'openai',
        modelId: 'gpt-5.4',
        variant: 'high',
      },
    ]);
  });

  test('posts inspection and confirmed handoff requests without changing their idempotency scope', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const api = createManagedOrchestrationApi({
      fetchImpl: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          rootSessionId: 'ses_root',
          fromMode: 'orchestrator',
          toMode: 'builder',
          state: 'clear',
          tasks: [],
          failures: [],
        });
      },
    });

    await api.handoff({
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      confirm: false,
    });
    await api.handoff({
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      confirm: true,
      idempotencyKey: 'switch-ui-01',
    });

    expect(requests).toEqual([{
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      confirm: false,
    }, {
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      confirm: true,
      idempotencyKey: 'switch-ui-01',
    }]);
  });

  test('uses no-store snapshots and reports invalid successful JSON', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const api = createManagedOrchestrationApi({
      fetchImpl: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response('not-json', { status: 200 });
      },
    });

    let failure: ManagedOrchestrationApiError | null = null;
    try {
      await api.getSnapshot({ rootSessionId: 'ses root' });
    } catch (error) {
      failure = error as ManagedOrchestrationApiError;
    }
    expect(failure?.status).toBe(502);
    expect(failure?.code).toBe('invalid_response');
    expect(requests[0]).toEqual({
      input: '/api/orchestration/snapshot?rootSessionId=ses+root',
      init: {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      },
    });
  });
});
