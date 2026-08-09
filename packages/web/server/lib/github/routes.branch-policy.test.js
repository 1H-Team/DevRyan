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
const octokit = { rest: { pulls, repos: { getBranch: vi.fn() } }, graphql: vi.fn() };

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithRequestPrincipal(principal, next, { assignment }));
  registerGitHubRoutes(app, {
    loadGitHubLibraries: async () => ({
      getOctokitOrNull: () => octokit,
      clearGitHubAuth: vi.fn(),
    }),
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
