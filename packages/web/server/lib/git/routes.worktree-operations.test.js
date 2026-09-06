import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerGitRoutes } from './routes.js';
import { getRequestPrincipal, runWithRequestPrincipal } from '../multi-user/request-context.js';

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

const makeApp = (overrides = {}, principal = null) => {
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
  const requestWitness = [];
  app.use(express.json());
  if (principal) {
    app.use((req, _res, next) => runWithRequestPrincipal(principal, next));
  }
  app.use((req, res, next) => {
    const observedPrincipal = getRequestPrincipal();
    const witness = {
      method: req.method,
      path: req.originalUrl,
      principal: observedPrincipal ? {
        id: observedPrincipal.id,
        role: observedPrincipal.role,
        scope: observedPrincipal.scope,
        assignedBranches: (observedPrincipal.assignments || []).map((entry) => entry.branchName).slice(0, 10),
      } : null,
      matchedRoute: null,
      status: null,
    };
    requestWitness.push(witness);
    res.once('finish', () => {
      witness.matchedRoute = typeof req.route?.path === 'string' ? req.route.path : null;
      witness.status = res.statusCode;
    });
    next();
  });
  registerGitRoutes(app, {
    loadGitLibraries: async () => libraries,
  });
  return { app, libraries, requestWitness };
};

describe('durable worktree operation routes', () => {
  it('returns operation receipts from create, lookup, active-list, retry, and legacy status routes', async () => {
    const { app, libraries, requestWitness } = makeApp();
    const recordUnexpectedStatus = (response) => {
      if (response.status === 200) return;
      console.error('Unexpected worktree operation response', JSON.stringify({
        expectedStatus: 200,
        actualStatus: response.status,
        contentType: response.headers['content-type'] || null,
        body: response.text?.slice(0, 2048) || null,
        bodyTruncated: (response.text?.length || 0) > 2048,
        requestWitness: requestWitness.slice(-10),
        libraryCalls: Object.fromEntries(Object.entries(libraries).map(([name, library]) => [
          name,
          library.mock.calls.slice(-10),
        ])),
      }));
    };
    const created = await request(app)
      .post('/api/git/worktrees?directory=/repo')
      .send({ idempotencyKey: 'request_1', mode: 'new' })
      .expect(recordUnexpectedStatus)
      .expect(200);
    expect(created.body).toMatchObject({
      path: receipt.directory,
      operationId: 'wt_1',
      bootstrap: { status: 'running' },
    });

    expect((await request(app)
      .get('/api/git/worktrees/operations/wt_1')
      .expect(recordUnexpectedStatus)
      .expect(200)).body).toMatchObject({ operationId: 'wt_1' });
    expect((await request(app)
      .get('/api/git/worktrees/operations?active=1')
      .expect(recordUnexpectedStatus)
      .expect(200)).body).toEqual({ operations: [receipt] });
    expect((await request(app)
      .post('/api/git/worktrees/operations/wt_1/retry')
      .expect(recordUnexpectedStatus)
      .expect(200)).body).toMatchObject({ operationId: 'wt_1', attempt: 2 });
    expect((await request(app)
      .get('/api/git/worktrees/bootstrap-status?directory=/legacy')
      .expect(recordUnexpectedStatus)
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

  it('prevents a managed developer from retrying a new-branch operation', async () => {
    const { app, libraries } = makeApp({
      getWorktreeBootstrapOperation: vi.fn(async () => ({
        ...receipt,
        metadata: { mode: 'new' },
      })),
    }, {
      id: 'developer-1',
      scope: 'managed',
      role: 'developer',
      policy: { createBranches: false },
    });

    const response = await request(app)
      .post('/api/git/worktrees/operations/wt_1/retry')
      .expect(403);

    expect(response.body).toEqual({
      error: 'Branch creation is disabled by policy',
      code: 'BRANCH_CREATION_DISABLED',
    });
    expect(libraries.retryWorktreeBootstrapOperation).not.toHaveBeenCalled();
  });
});
