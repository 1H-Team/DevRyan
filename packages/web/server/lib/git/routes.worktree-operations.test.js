import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerGitRoutes } from './routes.js';

const receipt = {
  operationId: 'wt_1',
  idempotencyKey: 'request_1',
  directory: '/repo-worktrees/feature',
  stage: 'populate_worktree',
  status: 'running',
  attempt: 1,
  warnings: [],
  stages: {},
  updatedAt: 1,
};

const makeApp = (overrides = {}) => {
  const libraries = {
    createWorktree: vi.fn(async () => ({
      head: 'abc',
      name: 'feature',
      branch: 'feature',
      path: receipt.directory,
      operationId: receipt.operationId,
      bootstrap: receipt,
    })),
    getWorktreeBootstrapStatus: vi.fn(async () => ({ ...receipt, status: 'not_applicable' })),
    getWorktreeBootstrapOperation: vi.fn(async (operationId) => {
      if (operationId === 'missing') {
        const error = new Error('Worktree bootstrap operation not found');
        error.statusCode = 404;
        throw error;
      }
      return receipt;
    }),
    listActiveWorktreeBootstrapOperations: vi.fn(async () => [receipt]),
    retryWorktreeBootstrapOperation: vi.fn(async () => ({ ...receipt, attempt: 2 })),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  registerGitRoutes(app, {
    loadGitLibraries: async () => libraries,
  });
  return { app, libraries };
};

describe('durable worktree operation routes', () => {
  it('returns operation receipts from create, lookup, active-list, retry, and legacy status routes', async () => {
    const { app, libraries } = makeApp();
    const created = await request(app)
      .post('/api/git/worktrees?directory=/repo')
      .send({ idempotencyKey: 'request_1', mode: 'new' })
      .expect(200);
    expect(created.body).toMatchObject({
      path: receipt.directory,
      operationId: 'wt_1',
      bootstrap: { status: 'running' },
    });

    expect((await request(app)
      .get('/api/git/worktrees/operations/wt_1')
      .expect(200)).body).toMatchObject({ operationId: 'wt_1' });
    expect((await request(app)
      .get('/api/git/worktrees/operations?active=1')
      .expect(200)).body).toEqual({ operations: [receipt] });
    expect((await request(app)
      .post('/api/git/worktrees/operations/wt_1/retry')
      .expect(200)).body).toMatchObject({ operationId: 'wt_1', attempt: 2 });
    expect((await request(app)
      .get('/api/git/worktrees/bootstrap-status?directory=/legacy')
      .expect(200)).body).toMatchObject({ status: 'not_applicable' });
    expect(libraries.createWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
      idempotencyKey: 'request_1',
    }));
  });

  it('returns 404 for an unknown operation ID', async () => {
    const { app } = makeApp();
    const response = await request(app)
      .get('/api/git/worktrees/operations/missing')
      .expect(404);
    expect(response.body.error).toContain('not found');
  });
});
