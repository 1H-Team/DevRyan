import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  createConfigApplyCoordinator,
  createConfigChangeMarker,
} from '@openchamber/shared-runtime';
import { registerCommonRequestMiddleware } from './core-routes.js';
import { registerConfigApplyRoutes } from './config-apply-runtime.js';

const createApp = ({ runtimeMode = 'managed', activeSessionCount = 0 } = {}) => {
  const applyChanges = vi.fn(async () => {});
  const refreshExternalCatalogs = vi.fn(async () => {});
  const auditForceRestart = vi.fn(async () => {});
  const abortActiveSessions = vi.fn(async () => {});
  const coordinator = createConfigApplyCoordinator({
    getRuntimeMode: () => runtimeMode,
    getActiveSessionCount: () => activeSessionCount,
    getAuthoritativeActiveSessionCount: async () => activeSessionCount,
    applyChanges,
    refreshExternalCatalogs,
    forceAbortTimeoutMs: 1,
  });
  const markConfigChange = createConfigChangeMarker({ coordinator, getCanForceRestart: () => true });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  app.use((req, _res, next) => {
    req.principal = req.get('x-test-role') === 'developer'
      ? { scope: 'managed', role: 'developer' }
      : { scope: 'local-admin', role: 'admin' };
    next();
  });
  registerConfigApplyRoutes(app, {
    coordinator,
    markConfigChange,
    canForceRestart: (principal) => principal?.scope === 'local-admin' || principal?.role === 'admin',
    auditForceRestart,
    abortActiveSessions,
  });
  return {
    app,
    coordinator,
    markConfigChange,
    applyChanges,
    refreshExternalCatalogs,
    auditForceRestart,
    abortActiveSessions,
  };
};

describe('configuration apply HTTP contract', () => {
  it('returns fresh status and hides force restart from non-administrators', async () => {
    const runtime = createApp({ activeSessionCount: 2 });
    await runtime.markConfigChange('skill update');

    const response = await request(runtime.app)
      .get('/api/config/apply-status')
      .set('x-test-role', 'developer')
      .expect(200);

    expect(response.body).toMatchObject({
      revision: 1,
      state: 'pending',
      activeSessionCount: 2,
      canForceRestart: false,
      scopes: ['skills'],
    });
  });

  it('returns HTTP 409 with fresh status for a stale expected revision', async () => {
    const runtime = createApp();
    await runtime.markConfigChange('agent model override');

    const response = await request(runtime.app)
      .post('/api/config/apply')
      .send({ expectedRevision: 0, mode: 'when-idle' })
      .expect(409);

    expect(response.body).toMatchObject({
      code: 'CONFIG_APPLY_REVISION_CONFLICT',
      applyStatus: { revision: 1, state: 'pending' },
    });
    expect(runtime.applyChanges).not.toHaveBeenCalled();
  });

  it('forces only for an administrator and audits before aborting active chats', async () => {
    const runtime = createApp({ activeSessionCount: 1 });
    const mutation = await runtime.markConfigChange('mcp update');

    await request(runtime.app)
      .post('/api/config/apply')
      .set('x-test-role', 'developer')
      .send({ expectedRevision: mutation.applyRevision, mode: 'force' })
      .expect(403);

    await request(runtime.app)
      .post('/api/config/apply')
      .send({ expectedRevision: mutation.applyRevision, mode: 'force' })
      .expect(200);

    expect(runtime.auditForceRestart).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      { revision: 1, activeSessionCount: 1 },
    );
    expect(runtime.abortActiveSessions).toHaveBeenCalledOnce();
    expect(runtime.applyChanges).toHaveBeenCalledOnce();
  });

  it('requires explicit acknowledgment for an external runtime', async () => {
    const runtime = createApp({ runtimeMode: 'external' });
    const mutation = await runtime.markConfigChange('provider disconnect');

    const applyResponse = await request(runtime.app)
      .post('/api/config/apply')
      .send({ expectedRevision: mutation.applyRevision, mode: 'when-idle' })
      .expect(200);
    expect(applyResponse.body.status.state).toBe('external_restart_required');
    expect(runtime.applyChanges).not.toHaveBeenCalled();

    const acknowledgeResponse = await request(runtime.app)
      .post('/api/config/apply/acknowledge-external')
      .send({ expectedRevision: mutation.applyRevision })
      .expect(200);
    expect(acknowledgeResponse.body).toMatchObject({ userConfirmed: true, status: { state: 'clean' } });
    expect(runtime.refreshExternalCatalogs).toHaveBeenCalledWith({ revision: 1, scopes: ['providers'] });
  });
});
