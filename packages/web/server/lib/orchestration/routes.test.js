import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import { registerManagedOrchestrationRoutes, captureRequiredCheckUserAuthority, authorizeObjectiveRead } from './routes.js';

describe('managed orchestration UI routes', () => {
  it('waivers require a verified cookie session, owned root and live authorization rather than body flags or loopback access', async () => {
    let live = true;
    const principal = { id: 'owner', scope: 'local-admin' };
    const options = { connection: { authenticateLocalOwner: () => null, captureAuthorization: () => () => live },
      authController: { enabled: false }, resolvePrincipal: async () => principal, ownsSession: async () => true,
      getUiSessionToken: () => 'invented', resolveCurrentNativeOperationContext: async () => null };
    const req = { headers: { cookie: 'made-up=value' }, body: { userWaived: true } };
    const scope = { rootSessionId: 'ses_root', directory: '/project' };
    expect(await captureRequiredCheckUserAuthority(req, scope, options)).toBeNull();
    options.connection.authenticateLocalOwner = () => principal;
    const authority = await captureRequiredCheckUserAuthority(req, scope, options);
    expect(authority.userId).toBe('owner');
    live = false;
    await expect(authority.recheck()).rejects.toMatchObject({ code: 'user_waiver_required' });
    options.connection.authenticateLocalOwner = () => null;
    options.resolvePrincipal = async () => ({ id: 'managed', scope: 'managed' });
    await expect(captureRequiredCheckUserAuthority(req, scope, options)).rejects.toMatchObject({ code: 'user_waiver_required' });
    options.resolveCurrentNativeOperationContext = async () => ({ directory: '/project' });
    expect((await captureRequiredCheckUserAuthority(req, scope, options)).userId).toBe('managed');
    options.resolvePrincipal = async () => ({ id: 'agent', scope: 'managed', accountKind: 'agent_test' });
    expect(await captureRequiredCheckUserAuthority(req, scope, options)).toBeNull();
    expect(await captureRequiredCheckUserAuthority({ headers: { authorization: 'Bearer fabricated' } }, scope, options)).toBeNull();
  });
  it('exposes waiver only through authenticated HTTP authority and never forwards it to model RPC', async () => {
    const runtime = { getSnapshot: vi.fn(), handleRpc: vi.fn(), waiveRequiredChecks: vi.fn(async () => ({ taskId: 'dvr_task_1' })) };
    const app = express();
    registerManagedOrchestrationRoutes(app, { runtime, express });
    expect((await request(app).post('/api/orchestration/task/dvr_task_1/verification/waive').send({ userWaived: true })).status).toBe(403);
    expect(runtime.waiveRequiredChecks).not.toHaveBeenCalled();
    const allowed = express();
    const authority = { userId: 'owner', recheck: vi.fn(async () => {}) };
    registerManagedOrchestrationRoutes(allowed, { runtime, express, authorizeUserWaiver: async () => authority });
    const body = { rootSessionId: 'ses_root', directory: '/project', checks: [{ name: 'visual', contentHash: 'a'.repeat(64) }], reason: 'Accept missing live coverage' };
    expect((await request(allowed).post('/api/orchestration/task/dvr_task_1/verification/waive').send(body)).status).toBe(200);
    expect(runtime.waiveRequiredChecks).toHaveBeenCalledWith({ ...body, taskId: 'dvr_task_1' }, authority);
    expect(runtime.handleRpc).not.toHaveBeenCalled();
  });
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

    const autoResume = await request(app)
      .post('/api/orchestration/task/dvr_task_1/auto-resume')
      .send({ taskId: 'dvr_task_body', rootSessionId: 'ses_root', directory: '/workspace', enabled: false });
    expect(autoResume.status).toBe(200);
    expect(autoResume.body).toEqual({
      method: 'set_auto_resume',
      params: { taskId: 'dvr_task_1', rootSessionId: 'ses_root', directory: '/workspace', enabled: false },
    });

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
      'set_auto_resume',
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

it('binds objective verification and waiver to authenticated current objective, including commit-time recheck', async () => {
  let objective = 'msg_current', turn = 'msg_wake', owner = 'owner', generation = 1, authorized = true;
  const authority = { userId: 'human', recheck: vi.fn(async () => { if (!authorized) throw Object.assign(Error('revoked'), { code: 'user_waiver_required', statusCode: 403 }); }) };
  const runtime = { getSnapshot: vi.fn(), handleRpc: vi.fn(), getObjectiveVerification: vi.fn(async scope => ({ objectiveId: scope.objectiveId })),
    waiveRequiredChecks: vi.fn(async (params, grant) => { await grant.recheck(); return { objectiveId: params.objectiveId }; }) };
  const app = express();
  registerManagedOrchestrationRoutes(app, { runtime, express, authorizeUserWaiver: async () => authorized ? authority : null,
    currentObjective: async () => objective, currentObjectiveTurn: async () => ({ objectiveId: objective, userMessageId: turn, owner, cancellationGeneration: generation, executionGeneration: 2 }), authorizeObjectiveRead: async () => true });
  const scope = { rootSessionId: 'ses_root', directory: '/workspace' };
  expect((await request(app).get('/api/orchestration/objective/verification').query(scope)).body).toEqual({ objectiveId: 'msg_current', verification: { objectiveId: 'msg_current' } });
  expect((await request(app).get('/api/orchestration/objective/verification').query({ ...scope, expectedObjectiveId: 'msg_old' })).status).toBe(409);
  expect((await request(app).get('/api/orchestration/objective/verification').query({ ...scope, originatingMessageId: 'msg_wake' })).body)
    .toEqual({ objectiveId: 'msg_current', originatingMessageId: 'msg_wake', verification: { objectiveId: 'msg_current' } });
  expect((await request(app).get('/api/orchestration/objective/verification').query({ ...scope, expectedObjectiveId: 'msg_current', originatingMessageId: 'msg_wake' })).status).toBe(200);
  expect((await request(app).get('/api/orchestration/objective/verification').query({ ...scope, expectedObjectiveId: 'msg_old', originatingMessageId: 'msg_wake' })).status).toBe(409);
  expect((await request(app).get('/api/orchestration/objective/verification').query({ ...scope, originatingMessageId: 'msg_forged' })).status).toBe(409);
  runtime.getObjectiveVerification.mockImplementationOnce(async () => { turn = 'msg_newhuman'; return null; });
  expect((await request(app).get('/api/orchestration/objective/verification').query({ ...scope, originatingMessageId: 'msg_wake' })).status).toBe(409);
  turn = 'msg_wake';
  runtime.getObjectiveVerification.mockImplementationOnce(async () => { owner = 'replacement'; return null; });
  expect((await request(app).get('/api/orchestration/objective/verification').query({ ...scope, originatingMessageId: 'msg_wake' })).status).toBe(409);
  runtime.getObjectiveVerification.mockImplementationOnce(async () => { generation++; return null; });
  expect((await request(app).get('/api/orchestration/objective/verification').query({ ...scope, originatingMessageId: 'msg_wake' })).status).toBe(409);
  const body = { ...scope, objectiveId: 'msg_current', taskId: 'dvr_task_forged', checks: [{ name: 'unit', contentHash: 'a'.repeat(64) }], reason: 'accepted' };
  expect((await request(app).post('/api/orchestration/objective/verification/waive').send(body)).status).toBe(200);
  expect(runtime.waiveRequiredChecks.mock.calls[0][0]).not.toHaveProperty('taskId');
  objective = 'msg_new';
  expect((await request(app).post('/api/orchestration/objective/verification/waive').send(body)).status).toBe(409);
  authorized = false;
  expect((await request(app).post('/api/orchestration/objective/verification/waive').send({ ...body, objectiveId: 'msg_new' })).status).toBe(403);
  expect((await request(app).get('/api/orchestration/objective/verification').query(scope)).status).toBe(200);
  authorized = true; objective = 'msg_current';
  runtime.waiveRequiredChecks.mockImplementationOnce(async (_params, grant) => { objective = 'msg_new'; await grant.recheck(); });
  expect((await request(app).post('/api/orchestration/objective/verification/waive').send(body)).status).toBe(409);
});


it('objective read accepts a local read grant and refuses foreign session or directory scope', async () => {
  const runtime = { getSnapshot: vi.fn(), handleRpc: vi.fn(), getObjectiveVerification: vi.fn(async () => null) };
  const app = express();
  registerManagedOrchestrationRoutes(app, { runtime, express, currentObjective: async () => 'msg_current',
    authorizeObjectiveRead: async (_req, scope) => scope.rootSessionId === 'ses_owned' && scope.directory === '/owned' });
  expect((await request(app).get('/api/orchestration/objective/verification').query({ rootSessionId: 'ses_owned', directory: '/owned' })).status).toBe(200);
  expect((await request(app).get('/api/orchestration/objective/verification').query({ rootSessionId: 'ses_foreign', directory: '/owned' })).status).toBe(403);
  expect((await request(app).get('/api/orchestration/objective/verification').query({ rootSessionId: 'ses_owned', directory: '/foreign' })).status).toBe(403);
  expect(runtime.getObjectiveVerification).toHaveBeenCalledTimes(1);
});


it('objective read grant permits normal local reads but checks managed owner and canonical directory', async () => {
  const scope = { rootSessionId: 'ses_owned', directory: '/owned' }, principal = { scope: 'managed', id: 'alice' };
  const options = { enabled: false, connection: { captureAuthorization: () => null }, resolvePrincipal: async () => principal,
    ownsSession: async (_principal, id) => id === 'ses_owned',
    resolveCurrentNativeOperationContext: async input => input.directory === '/owned' ? { directory: '/owned' } : null };
  expect(await authorizeObjectiveRead({}, scope, options)).toBe(true);
  options.enabled = true;
  expect(await authorizeObjectiveRead({}, scope, options)).toBe(true);
  expect(await authorizeObjectiveRead({}, { ...scope, rootSessionId: 'ses_other' }, options)).toBe(false);
  expect(await authorizeObjectiveRead({}, { ...scope, directory: '/other' }, options)).toBe(false);
  options.resolvePrincipal = async () => null;
  expect(await authorizeObjectiveRead({}, scope, options)).toBe(false);
});
