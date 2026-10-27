import { beforeEach, afterEach, describe, expect, test } from 'bun:test';

import { opencodeClient } from './opencode/client';
let releaseGate: (() => void) | undefined;
beforeEach(() => { releaseGate = opencodeClient.registerInputSubscriptionGate(async () => () => {}); });
afterEach(() => releaseGate?.());

import { createManagedOrchestrationApi, ManagedOrchestrationApiError } from './orchestrationApi';

describe('managed orchestration API', () => {
  test('waiver sends exact current file hashes and reason through the authenticated UI route', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const api = createManagedOrchestrationApi({ fetchImpl: async (input, init) => {
      request = { url: String(input), init };
      return Response.json({ taskId: 'dvr_task_check' });
    } });
    const body = { rootSessionId: 'ses_root', directory: '/workspace',
      checks: [{ name: 'Populated cards', contentHash: 'a'.repeat(64) }], reason: 'Accept fixture coverage for this change' };
    await api.waiveVerification?.('dvr_task_check/unsafe', body);
    expect(request?.url).toBe('/api/orchestration/task/dvr_task_check%2Funsafe/verification/waive');
    expect(JSON.parse(String(request?.init?.body))).toEqual(body);
    expect(new Headers(request?.init?.headers).get('X-DevRyan-CSRF')).toBe('1');
    expect(request?.init?.credentials).toBe('same-origin');
  });
  test('reads and waives root objective checks through scoped UI routes', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const api = createManagedOrchestrationApi({ fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init }); return Response.json({});
    } });
    const scope = { rootSessionId: 'ses_root', directory: '/project with spaces' };
    const body = { ...scope, objectiveId: 'msg_user', checks: [{ name: 'unit', contentHash: 'a'.repeat(64) }], reason: 'accepted' };
    await api.getObjectiveVerification?.(scope); await api.waiveObjectiveVerification?.(body);
    expect(requests[0]?.url).toBe('/api/orchestration/objective/verification?rootSessionId=ses_root&directory=%2Fproject+with+spaces');
    expect(requests[1]?.url).toBe('/api/orchestration/objective/verification/waive');
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(body);
    expect(new Headers(requests[1]?.init?.headers).get('X-DevRyan-CSRF')).toBe('1');
    expect(requests.map(request => request.init?.credentials)).toEqual(['same-origin', 'same-origin']);
  });
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
    expect(requests.map(({ init }) => new Headers(init?.headers).get('X-DevRyan-CSRF'))).toEqual([
      '1',
      '1',
    ]);
  });

  test('posts inspection and confirmed handoff requests without changing their idempotency scope', async () => {
    const requests: Array<{ body: Record<string, unknown>; csrf: string | null }> = [];
    const api = createManagedOrchestrationApi({
      fetchImpl: async (_input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          csrf: new Headers(init?.headers).get('X-DevRyan-CSRF'),
        });
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
      body: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      },
      csrf: '1',
    }, {
      body: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: true,
        idempotencyKey: 'switch-ui-01',
      },
      csrf: '1',
    }]);
  });

  test('posts auto-resume toggles to the task route with the scoped body', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const api = createManagedOrchestrationApi({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ resultEnvelope: { envelopeId: 'dvr_result_1', taskId: 'dvr_task_1' } });
      },
    });

    const response = await api.setAutoResume('dvr_task_1/unsafe', {
      rootSessionId: 'ses_root',
      directory: '/workspace',
      enabled: false,
    });

    expect(response).toEqual({ resultEnvelope: { envelopeId: 'dvr_result_1', taskId: 'dvr_task_1' } });
    expect(requests.map(({ url }) => url)).toEqual([
      '/api/orchestration/task/dvr_task_1%2Funsafe/auto-resume',
    ]);
    expect(requests[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      rootSessionId: 'ses_root',
      directory: '/workspace',
      enabled: false,
    });
    expect(new Headers(requests[0]?.init?.headers).get('X-DevRyan-CSRF')).toBe('1');
  });

  test('surfaces auto-resume conflicts with their authoritative code', async () => {
    const api = createManagedOrchestrationApi({
      fetchImpl: async () => Response.json({
        ok: false,
        error: { code: 'auto_resume_stale', message: 'newer revision exists' },
      }, { status: 409 }),
    });

    let failure: ManagedOrchestrationApiError | null = null;
    try {
      await api.setAutoResume('dvr_task_1', { rootSessionId: 'ses_root', enabled: true });
    } catch (error) {
      failure = error as ManagedOrchestrationApiError;
    }
    expect(failure?.status).toBe(409);
    expect(failure?.code).toBe('auto_resume_stale');
    expect(failure?.message).toBe('newer revision exists');
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

test('recovery intent waits across SSE readiness, revalidates once and never retries an uncertain POST', async () => {
  let ready: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  let gateTimeout: number | undefined, rechecks = 0, posts = 0;
  const unregister = opencodeClient.registerInputSubscriptionGate(async (_signal, timeout) => { gateTimeout = timeout; await waiting; return () => {}; });
  try {
    const api = createManagedOrchestrationApi({ fetchImpl: async () => { posts++; throw new TypeError('connection lost after send'); } });
    const operation = api.acknowledgeTask('task', { rootSessionId: 'root', action: 'retry_in_place', idempotencyKey: 'same-intent' }, { signal: new AbortController().signal, beforeSend: () => { rechecks++; } });
    await Promise.resolve();
    expect(posts).toBe(0);
    expect(gateTimeout).toBe(Infinity);
    ready?.();
    await expect(operation).rejects.toThrow('connection lost');
    expect(posts).toBe(1);
    expect(rechecks).toBe(1);
  } finally { unregister(); }
});

test('cancelled recovery and stale revision checks cannot POST after SSE readiness returns', async () => {
  for (const cancel of [true, false]) {
    let ready: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const controller = new AbortController();
    let posts = 0;
    const unregister = opencodeClient.registerInputSubscriptionGate(async () => { await waiting; return () => {}; });
    try {
      const api = createManagedOrchestrationApi({ fetchImpl: async () => { posts++; return Response.json({}); } });
      const operation = api.acknowledgeTask('task', { rootSessionId: 'root', action: 'retry', idempotencyKey: 'same-intent' }, { signal: controller.signal,
        beforeSend: () => { throw new Error('revision changed'); } });
      if (cancel) controller.abort();
      ready?.();
      await expect(operation).rejects.toThrow(cancel ? 'cancelled' : 'revision changed');
      expect(posts).toBe(0);
    } finally { unregister(); }
  }
});
