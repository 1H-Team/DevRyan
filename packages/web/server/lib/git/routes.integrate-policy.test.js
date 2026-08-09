import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';

import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import { registerGitRoutes } from './routes.js';

const assignment = {
  projectId: 'project-one-health',
  repositoryPath: '/managed/one-health',
  worktreeContainerPath: '/opencode/worktree/one-health',
  branchName: 'Dev',
  isDefault: true,
};
const principal = {
  id: 'developer-user',
  role: 'developer',
  scope: 'managed',
  policy: { manageGit: true },
  assignments: [assignment],
};

const computeIntegratePlan = vi.fn();
const getPrimaryWorktreeRoot = vi.fn(async () => assignment.repositoryPath);

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithRequestPrincipal(principal, next, { assignment }));
  registerGitRoutes(app, {
    loadGitLibraries: async () => ({ computeIntegratePlan, getPrimaryWorktreeRoot }),
  });
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  computeIntegratePlan.mockImplementation(async (repoRoot, input) => ({
    repoRoot,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    commits: [],
  }));
});

describe('managed commit integration policy', () => {
  it('rejects moving commits into an unassigned branch before Git runs', async () => {
    const response = await request(createApp())
      .post('/api/git/integrate/plan?directory=/managed/one-health')
      .send({ sourceBranch: 'Dev', targetBranch: 'main' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual(expect.objectContaining({ code: 'BRANCH_NOT_ASSIGNED' }));
    expect(getPrimaryWorktreeRoot).not.toHaveBeenCalled();
    expect(computeIntegratePlan).not.toHaveBeenCalled();
  });

  it('allows a scratch branch to target its assigned integration branch', async () => {
    const response = await request(createApp())
      .post('/api/git/integrate/plan?directory=/opencode/worktree/one-health/task')
      .send({ sourceBranch: 'openchamber/task', targetBranch: 'Dev' });

    expect(response.status).toBe(200);
    expect(computeIntegratePlan).toHaveBeenCalledWith(assignment.repositoryPath, {
      sourceBranch: 'openchamber/task',
      targetBranch: 'Dev',
    });
  });
});
