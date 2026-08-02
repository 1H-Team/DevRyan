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
