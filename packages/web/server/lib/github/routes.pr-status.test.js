import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';
import { createGitHubRateLimitTracker } from './rate-limit.js';
import { registerGitHubRoutes } from './routes.js';

const rateLimitError = (resetAtSeconds) => ({
  status: 403,
  response: {
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetAtSeconds),
    },
  },
});

const createApp = ({ now, resolveGitHubPrStatus }) => {
  const clearGitHubAuth = vi.fn();
  const getOctokitOrNull = vi.fn(() => ({ rest: {} }));
  const rateLimitTracker = createGitHubRateLimitTracker({ now: () => now.value });
  const app = express();
  registerGitHubRoutes(app, {
    loadGitHubLibraries: async () => ({
      clearGitHubAuth,
      getGitHubAuth: () => null,
      getOctokitOrNull,
    }),
    rateLimitTracker,
    resolveGitHubPrStatus,
  });
  return { app, clearGitHubAuth, getOctokitOrNull, rateLimitTracker };
};

const createPullListApp = (pullRequests) => {
  const list = vi.fn(async () => ({
    data: pullRequests,
    headers: {},
  }));
  const octokit = { rest: { pulls: { list } } };
  const app = express();
  registerGitHubRoutes(app, {
    loadGitHubLibraries: async () => ({
      clearGitHubAuth: vi.fn(),
      getOctokitOrNull: () => octokit,
    }),
    resolveGitHubRepoFromDirectory: async () => ({
      repo: { owner: 'octo', repo: 'project', url: 'https://github.com/octo/project' },
    }),
    resolveRepoNetwork: async () => [
      { owner: 'octo', repo: 'project', source: 'origin' },
    ],
  });
  return { app, list };
};

describe('GitHub PR status rate limits', () => {
  it('avoids network work during cooldown and resumes after it expires', async () => {
    const now = { value: 10_000 };
    const resolveGitHubPrStatus = vi.fn(async () => ({
      repo: null,
      pr: null,
      defaultBranch: null,
      resolvedRemoteName: null,
    }));
    const { app, getOctokitOrNull, rateLimitTracker } = createApp({ now, resolveGitHubPrStatus });
    rateLimitTracker.recordFailure(rateLimitError(20));

    await request(app)
      .get('/api/github/pr/status?directory=/cooldown&branch=feature')
      .expect(429);
    expect(getOctokitOrNull).not.toHaveBeenCalled();
    expect(resolveGitHubPrStatus).not.toHaveBeenCalled();

    now.value = 20_000;
    const response = await request(app)
      .get('/api/github/pr/status?directory=/cooldown&branch=feature')
      .expect(200);
    expect(response.body.connected).toBe(true);
    expect(getOctokitOrNull).toHaveBeenCalledTimes(1);
    expect(resolveGitHubPrStatus).toHaveBeenCalledTimes(1);
  });

  it('records rate limits without clearing auth and still clears true auth failures', async () => {
    const now = { value: 30_000 };
    const rateLimitedResolver = vi.fn(async () => {
      throw rateLimitError(40);
    });
    const rateLimited = createApp({ now, resolveGitHubPrStatus: rateLimitedResolver });

    await request(rateLimited.app)
      .get('/api/github/pr/status?directory=/rate-limited&branch=feature')
      .expect(429);
    expect(rateLimited.clearGitHubAuth).not.toHaveBeenCalled();
    expect(rateLimited.rateLimitTracker.getCooldown()).toEqual({
      retryAt: 40_000,
      retryAfterMs: 10_000,
    });

    const authResolver = vi.fn(async () => {
      throw { status: 401 };
    });
    const authFailure = createApp({ now, resolveGitHubPrStatus: authResolver });
    const response = await request(authFailure.app)
      .get('/api/github/pr/status?directory=/auth-failure&branch=feature')
      .expect(200);
    expect(response.body).toEqual({ connected: false });
    expect(authFailure.clearGitHubAuth).toHaveBeenCalledTimes(1);
  });
});

describe('GitHub pull request list states', () => {
  const makePullRequest = ({ number, state, mergedAt = null, updatedAt }) => ({
    number,
    title: `Pull request ${number}`,
    html_url: `https://github.com/octo/project/pull/${number}`,
    state,
    merged_at: mergedAt,
    draft: false,
    base: { ref: 'main' },
    head: { ref: `feature-${number}`, sha: `sha-${number}`, repo: null },
    user: { login: 'octocat', id: 1, avatar_url: 'https://example.com/avatar.png' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: updatedAt,
  });

  it('defaults existing consumers to open pull requests', async () => {
    const { app, list } = createPullListApp([
      makePullRequest({ number: 1, state: 'open', updatedAt: '2026-01-02T00:00:00Z' }),
    ]);

    await request(app)
      .get('/api/github/pulls/list?directory=/repo&page=1')
      .expect(200);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      state: 'open',
      sort: 'updated',
      direction: 'desc',
    }));
  });

  it('returns all states with timestamps ordered by most recently updated', async () => {
    const { app, list } = createPullListApp([
      makePullRequest({ number: 1, state: 'closed', updatedAt: '2026-01-02T00:00:00Z' }),
      makePullRequest({ number: 2, state: 'closed', mergedAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' }),
      makePullRequest({ number: 3, state: 'open', updatedAt: '2026-01-03T00:00:00Z' }),
    ]);

    const response = await request(app)
      .get('/api/github/pulls/list?directory=/repo&page=1&state=all')
      .expect(200);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ state: 'all' }));
    expect(response.body.prs.map((pullRequest) => pullRequest.number)).toEqual([2, 3, 1]);
    expect(response.body.prs.map((pullRequest) => pullRequest.state)).toEqual(['merged', 'open', 'closed']);
    expect(response.body.prs[0]).toEqual(expect.objectContaining({
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-04T00:00:00Z',
    }));
  });

  it('rejects unsupported state filters before calling GitHub', async () => {
    const { app, list } = createPullListApp([]);

    await request(app)
      .get('/api/github/pulls/list?directory=/repo&state=closed')
      .expect(400);

    expect(list).not.toHaveBeenCalled();
  });
});
