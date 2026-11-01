import express from 'express';
import request from '../../test-supertest.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerGitRoutes } from './routes.js';

const configured = { providerID: 'opencode', modelID: 'deepseek-v4.1-flash', revision: 'saved-1', selectionMode: 'configured', selectionRevision: 'saved-1' };

const makeApp = ({
  resolveHelperSelection = vi.fn(async () => configured),
  generateTextWithSessionModel = vi.fn(async ({ accept }) => ({ ok: true, value: await accept('Homepage language audit'), attempts: 1 })),
} = {}) => {
  const app = express();
  app.use(express.json());
  registerGitRoutes(app, {
    resolveHelperSelection,
    generateTextWithSessionModel,
    generateHelperText: vi.fn(),
    buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    loadGitLibraries: async () => ({}),
  });
  return { app, resolveHelperSelection, generateTextWithSessionModel };
};

const post = (app, body = { prompt: 'Audit the homepage copy for language issues' }) => request(app)
  .post('/api/git/branch-name?directory=/repo')
  .send(body);

describe('POST /api/git/branch-name', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns the configured helper model slug through the no-tools branch agent', async () => {
    const { app, resolveHelperSelection, generateTextWithSessionModel } = makeApp();
    const response = await post(app);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ slug: 'homepage-language-audit', source: 'helper_model', model: 'opencode/deepseek-v4.1-flash' });
    expect(resolveHelperSelection).toHaveBeenCalledWith({ directory: '/repo', agent: 'devryan-branch', selectionMode: 'configured' });
    const call = generateTextWithSessionModel.mock.calls[0][0];
    expect(call).toMatchObject({ directory: '/repo', agent: 'devryan-branch', selection: configured, denyTools: true, timeoutMs: 6_000 });
    expect(call.prompt).toContain('Audit the homepage copy for language issues');
  });

  it('rejects a missing directory or prompt', async () => {
    const { app, generateTextWithSessionModel } = makeApp();
    expect((await request(app).post('/api/git/branch-name').send({ prompt: 'x' })).status).toBe(400);
    expect((await post(app, { prompt: '   ' })).status).toBe(400);
    expect(generateTextWithSessionModel).not.toHaveBeenCalled();
  });

  it('fails without a usable helper so the client falls back to a random slug', async () => {
    const unavailable = makeApp({ resolveHelperSelection: vi.fn(async () => { throw Object.assign(new Error('unavailable'), { statusCode: 503 }); }) });
    const noSelection = await post(unavailable.app);
    expect(noSelection.status).toBe(502);
    expect(noSelection.body.code).toBe('HELPER_MODEL_FAILED');
    expect(unavailable.generateTextWithSessionModel).not.toHaveBeenCalled();

    const timedOut = makeApp({ generateTextWithSessionModel: vi.fn(async () => ({ ok: false, value: null, reason: 'timeout', attempts: 1 })) });
    const failed = await post(timedOut.app);
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ code: 'HELPER_MODEL_FAILED', reason: 'timeout' });
  });

  it('keeps an authorization refusal distinct', async () => {
    const { app } = makeApp({ generateTextWithSessionModel: vi.fn(async () => ({ ok: false, reason: 'authorization_revoked', code: 'native_session_access_revoked' })) });
    const response = await post(app);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('native_session_access_revoked');
  });
});
