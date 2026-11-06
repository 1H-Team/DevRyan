import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';

vi.mock('./index.js', () => ({
  resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'one-health', repo: 'connector' } })),
}));

vi.mock('../git/index.js', () => ({
  getStatus: vi.fn(async () => ({ tracking: 'origin/developer' })),
  getRemotes: vi.fn(async () => [{ name: 'origin' }]),
}));

import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import { createGitHubPermissionRefusalCache } from './rate-limit.js';
import { registerGitHubRoutes } from './routes.js';

const assignment = {
  projectId: 'project-one-health',
  repositoryPath: '/managed/one-health',
  worktreeContainerPath: '/opencode/worktree/one-health',
  publicDirectory: '/managed/one-health',
  branchName: 'developer',
  githubAccountId: 'github-account',
  isDefault: true,
};
const principal = {
  id: 'developer-user',
  role: 'developer',
  scope: 'managed',
  assignments: [assignment],
};

const pulls = {
  create: vi.fn(),
  get: vi.fn(),
  merge: vi.fn(),
  update: vi.fn(),
};
const repos = {
  getBranch: vi.fn(),
  getCollaboratorPermissionLevel: vi.fn(),
  getCombinedStatusForRef: vi.fn(),
};
const checks = { listForRef: vi.fn() };
const octokit = { rest: { pulls, repos, checks }, graphql: vi.fn() };

const createApp = (dependencies = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithRequestPrincipal(principal, next, { assignment }));
  registerGitHubRoutes(app, {
    loadGitHubLibraries: async () => ({
      getOctokitOrNull: () => octokit,
      clearGitHubAuth: vi.fn(),
    }),
    ...dependencies,
  });
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  pulls.create.mockResolvedValue({
    data: {
      number: 42,
      title: 'Developer change',
      body: '',
      html_url: 'https://github.com/one-health/connector/pull/42',
      state: 'open',
      draft: false,
      base: { ref: 'main' },
      head: { ref: 'developer', sha: 'abc123' },
    },
  });
  pulls.get.mockResolvedValue({ data: { base: { ref: 'main' }, node_id: 'PR_node', draft: true } });
  pulls.merge.mockResolvedValue({ data: { merged: true } });
  repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'write' } });
  repos.getCombinedStatusForRef.mockResolvedValue({ data: { statuses: [] } });
  checks.listForRef.mockResolvedValue({ data: { check_runs: [] } });
});

describe('managed GitHub project policy', () => {
  it('allows a real project branch to open a PR', async () => {
    const response = await request(createApp())
      .post('/api/github/pr/create')
      .send({
        directory: assignment.repositoryPath,
        title: 'Developer change',
        head: 'developer',
        base: 'main',
      });

    expect(response.status).toBe(200);
    expect(pulls.create).toHaveBeenCalledWith(expect.objectContaining({ head: 'developer', base: 'main' }));
  });

  it('rejects a PR whose writable head branch is not assigned', async () => {
    const response = await request(createApp())
      .post('/api/github/pr/create')
      .send({
        directory: assignment.repositoryPath,
        title: 'Wrong branch',
        head: 'main',
        base: 'developer',
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual(expect.objectContaining({ code: 'BRANCH_NOT_ASSIGNED' }));
    expect(pulls.create).not.toHaveBeenCalled();
  });

  it('rejects merging a PR into an unassigned base branch', async () => {
    const response = await request(createApp())
      .post('/api/github/pr/merge')
      .send({ directory: `${assignment.worktreeContainerPath}/feature`, number: 42, method: 'squash' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual(expect.objectContaining({ code: 'BRANCH_NOT_ASSIGNED' }));
    expect(pulls.merge).not.toHaveBeenCalled();
  });

  it('allows merging a PR into an assigned base branch from a contained worktree', async () => {
    pulls.get.mockResolvedValueOnce({ data: { base: { ref: 'developer' }, node_id: 'PR_node', draft: false } });

    const response = await request(createApp())
      .post('/api/github/pr/merge')
      .send({ directory: `${assignment.worktreeContainerPath}/feature`, number: 42, method: 'squash' });

    expect(response.status).toBe(200);
    expect(pulls.merge).toHaveBeenCalled();
  });
});

describe('managed GitHub permission refusal cache', () => {
  it('never caches internal branch 403s or branch denials as GitHub permission refusals', async () => {
    const permissionRefusalCache = createGitHubPermissionRefusalCache();
    const app = createApp({
      permissionRefusalCache,
      getGitHubClientSnapshot: () => ({
        auth: {
          accountId: 'github-account',
          accessToken: 'token',
          credentialRevision: 'revision-1',
          user: { login: 'developer-login' },
        },
        octokit,
      }),
      resolveGitHubPrStatus: async () => ({
        repo: { owner: 'one-health', repo: 'connector' },
        pr: { number: 42 },
        defaultBranch: 'main',
        resolvedRemoteName: 'origin',
      }),
    });

    const merge = await request(app)
      .post('/api/github/pr/merge')
      .send({ directory: assignment.repositoryPath, number: 42, method: 'squash' });
    expect(merge.status).toBe(403);
    expect(merge.body).toEqual(expect.objectContaining({ code: 'BRANCH_NOT_ASSIGNED' }));

    pulls.get.mockResolvedValue({ data: { number: 42, base: { ref: 'main' }, head: { ref: 'developer', sha: 'abc123' } } });
    const unassignedBase = await request(app)
      .get(`/api/github/pr/status?directory=${encodeURIComponent(assignment.repositoryPath)}&branch=developer&force=true`)
      .expect(200);
    expect(unassignedBase.body.canMerge).toBe(false);
    expect(repos.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1);

    pulls.get.mockResolvedValue({ data: { number: 42, base: { ref: 'developer' }, head: { ref: 'feature', sha: 'abc123' } } });
    const assignedBase = await request(app)
      .get(`/api/github/pr/status?directory=${encodeURIComponent(assignment.repositoryPath)}&branch=feature&force=true`)
      .expect(200);
    expect(assignedBase.body.canMerge).toBe(true);
    expect(repos.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(2);
    expect(permissionRefusalCache.size()).toBe(0);
  });
});
