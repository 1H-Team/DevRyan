import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';
import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import {
  createGitHubPermissionRefusalCache,
  createGitHubRateLimitTracker,
  isStableGitHubPermissionRefusal,
} from './rate-limit.js';
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
  const octokit = { rest: { pulls: { get: vi.fn() } } };
  const getGitHubClientSnapshot = vi.fn(() => ({ auth: null, octokit }));
  const rateLimitTracker = createGitHubRateLimitTracker({ now: () => now.value });
  const app = express();
  registerGitHubRoutes(app, {
    loadGitHubLibraries: async () => ({
      clearGitHubAuth,
    }),
    getGitHubClientSnapshot,
    rateLimitTracker,
    resolveGitHubPrStatus,
  });
  return { app, clearGitHubAuth, getGitHubClientSnapshot, octokit, rateLimitTracker };
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
    const { app, getGitHubClientSnapshot, octokit, rateLimitTracker } = createApp({ now, resolveGitHubPrStatus });
    rateLimitTracker.recordFailure(rateLimitError(20));

    await request(app)
      .get('/api/github/pr/status?directory=/cooldown&branch=feature')
      .expect(429);
    // The local auth snapshot keys the status cache; no GitHub work starts.
    expect(getGitHubClientSnapshot).toHaveBeenCalledTimes(1);
    expect(resolveGitHubPrStatus).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();

    now.value = 20_000;
    const response = await request(app)
      .get('/api/github/pr/status?directory=/cooldown&branch=feature')
      .expect(200);
    expect(response.body.connected).toBe(true);
    expect(getGitHubClientSnapshot).toHaveBeenCalledTimes(2);
    expect(resolveGitHubPrStatus).toHaveBeenCalledTimes(1);
    expect(resolveGitHubPrStatus).toHaveBeenCalledWith(expect.objectContaining({ octokit }));
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

const forbiddenError = () => ({
  status: 403,
  response: { headers: {}, data: { message: 'Must have push access to view repository collaborators.' } },
});

const refusalIdentity = (overrides = {}) => ({
  accountId: 'account-a',
  credentialRevision: 'revision-1',
  owner: 'Octo',
  repo: 'Project',
  ...overrides,
});

describe('GitHub permission refusal cache', () => {
  it('expires refusals after the TTL and drops them on access', () => {
    const now = { value: 1_000 };
    const cache = createGitHubPermissionRefusalCache({ now: () => now.value });

    expect(cache.record(refusalIdentity(), forbiddenError())).toBe(true);
    now.value += 299_999;
    expect(cache.has(refusalIdentity())).toBe(true);
    now.value += 1;
    expect(cache.has(refusalIdentity())).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it('evicts the oldest entry at capacity and refreshes a re-recorded entry', () => {
    const cache = createGitHubPermissionRefusalCache({ now: () => 1_000, maxEntries: 2 });
    const first = refusalIdentity({ repo: 'first' });
    const second = refusalIdentity({ repo: 'second' });
    const third = refusalIdentity({ repo: 'third' });

    cache.record(first, forbiddenError());
    cache.record(second, forbiddenError());
    cache.record(first, forbiddenError());
    cache.record(third, forbiddenError());

    expect(cache.size()).toBe(2);
    expect(cache.has(first)).toBe(true);
    expect(cache.has(second)).toBe(false);
    expect(cache.has(third)).toBe(true);
  });

  it('never caches authentication, missing, rate-limit, server, transport or internal branch failures', () => {
    const cache = createGitHubPermissionRefusalCache({ now: () => 1_000 });
    const unstable = [
      { status: 401 },
      { status: 404 },
      rateLimitError(40),
      { status: 403, response: { headers: { 'retry-after': '30' } } },
      { status: 403, response: { headers: {}, data: { message: 'You have exceeded a secondary rate limit' } } },
      { status: 429 },
      { status: 500 },
      { status: 502 },
      Object.assign(new Error('GitHub API request timed out after 15000ms'), { code: 'GITHUB_API_TIMEOUT' }),
      new TypeError('fetch failed'),
      Object.assign(new Error('Pull request branch is not assigned to this account'), { statusCode: 403, code: 'BRANCH_NOT_ASSIGNED' }),
      { status: 403, code: 'BRANCH_NOT_ASSIGNED' },
      { response: { status: 403 } },
    ];

    for (const error of unstable) {
      expect(isStableGitHubPermissionRefusal(error)).toBe(false);
      expect(cache.record(refusalIdentity(), error)).toBe(false);
    }
    expect(cache.size()).toBe(0);
    expect(cache.has(refusalIdentity())).toBe(false);
    expect(isStableGitHubPermissionRefusal(forbiddenError())).toBe(true);
  });

  it('bypasses credentials without a revision', () => {
    const cache = createGitHubPermissionRefusalCache({ now: () => 1_000 });

    expect(cache.record(refusalIdentity({ credentialRevision: undefined }), forbiddenError())).toBe(false);
    expect(cache.record(refusalIdentity({ credentialRevision: '' }), forbiddenError())).toBe(false);
    expect(cache.has(refusalIdentity({ credentialRevision: undefined }))).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it('keys by API origin, account, credential revision and case-insensitive repository', () => {
    const cache = createGitHubPermissionRefusalCache({ now: () => 1_000 });
    cache.record(refusalIdentity(), forbiddenError());

    expect(cache.has(refusalIdentity({ owner: 'octo', repo: 'PROJECT' }))).toBe(true);
    expect(cache.has(refusalIdentity({ credentialRevision: 'revision-2' }))).toBe(false);
    expect(cache.has(refusalIdentity({ accountId: 'account-b' }))).toBe(false);
    expect(cache.has(refusalIdentity({ repo: 'other' }))).toBe(false);
    expect(cache.has(refusalIdentity({ apiOrigin: 'https://github.example.test/api/v3' }))).toBe(false);
  });
});

const accountAuth = (accountId, credentialRevision, login) => ({
  accountId,
  accessToken: `token-${accountId}`,
  ...(credentialRevision ? { credentialRevision } : {}),
  user: { login },
});

const managedPrincipal = (branchName) => ({
  id: 'developer-user',
  role: 'developer',
  scope: 'managed',
  assignments: [{ projectId: 'project', repositoryPath: '/managed/repo', branchName, isDefault: true }],
});

const createPermissionApp = ({ now = { value: 1_000 }, auth, principal = null } = {}) => {
  const authRef = { current: auth === undefined ? accountAuth('account-a', 'revision-1', 'alpha') : auth };
  const principalRef = { current: principal };
  const getCollaboratorPermissionLevel = vi.fn(async () => ({ data: { permission: 'write' } }));
  const octokit = {
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: {
            number: 7,
            title: 'Change',
            body: '',
            html_url: 'https://github.com/Octo/Project/pull/7',
            state: 'open',
            draft: false,
            base: { ref: 'main' },
            head: { ref: 'feature', sha: 'sha-7' },
            mergeable: true,
            mergeable_state: 'clean',
          },
        })),
      },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
      repos: {
        getCombinedStatusForRef: vi.fn(async () => ({ data: { statuses: [] } })),
        getCollaboratorPermissionLevel,
      },
    },
  };
  const resolveGitHubPrStatus = vi.fn(async () => ({
    repo: { owner: 'Octo', repo: 'Project' },
    pr: { number: 7 },
    defaultBranch: 'main',
    resolvedRemoteName: 'origin',
  }));
  const permissionRefusalCache = createGitHubPermissionRefusalCache({ now: () => now.value });
  const app = express();
  app.use((_req, _res, next) => (
    principalRef.current ? runWithRequestPrincipal(principalRef.current, next) : next()
  ));
  registerGitHubRoutes(app, {
    loadGitHubLibraries: async () => ({ clearGitHubAuth: vi.fn() }),
    getGitHubClientSnapshot: () => ({ auth: authRef.current, octokit }),
    permissionRefusalCache,
    rateLimitTracker: createGitHubRateLimitTracker({ now: () => now.value }),
    resolveGitHubPrStatus,
  });
  const status = ({ force = true, directory = '/repo' } = {}) => request(app)
    .get(`/api/github/pr/status?directory=${encodeURIComponent(directory)}&branch=feature${force ? '&force=true' : ''}`)
    .expect(200);
  return {
    app,
    authRef,
    getCollaboratorPermissionLevel,
    now,
    octokit,
    permissionRefusalCache,
    principalRef,
    resolveGitHubPrStatus,
    status,
  };
};

describe('GitHub PR status permission refusals', () => {
  it('reuses a stable refusal for the same credential until it expires', async () => {
    const harness = createPermissionApp();
    harness.getCollaboratorPermissionLevel.mockRejectedValue(forbiddenError());

    expect((await harness.status()).body.canMerge).toBe(false);
    expect((await harness.status()).body.canMerge).toBe(false);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: 'Octo',
      repo: 'Project',
      username: 'alpha',
    });

    harness.now.value += 300_000;
    expect((await harness.status()).body.canMerge).toBe(false);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(2);
  });

  it('re-checks permission after authentication, missing, server or transport failures', async () => {
    const failures = [{ status: 401 }, { status: 404 }, { status: 500 }, new TypeError('fetch failed')];
    for (const failure of failures) {
      const harness = createPermissionApp();
      harness.getCollaboratorPermissionLevel.mockRejectedValue(failure);

      expect((await harness.status()).body.canMerge).toBe(false);
      expect((await harness.status()).body.canMerge).toBe(false);
      expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(2);
      expect(harness.permissionRefusalCache.size()).toBe(0);
    }
  });

  it('treats a permission rate limit as a cooldown, never a cached refusal', async () => {
    const harness = createPermissionApp({ now: { value: 30_000 } });
    harness.getCollaboratorPermissionLevel.mockRejectedValueOnce(rateLimitError(40));

    await request(harness.app)
      .get('/api/github/pr/status?directory=%2Frepo&branch=feature&force=true')
      .expect(429);
    expect(harness.permissionRefusalCache.size()).toBe(0);

    harness.now.value = 40_000;
    expect((await harness.status()).body.canMerge).toBe(true);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(2);
  });

  it('bypasses the refusal cache for stored credentials without a revision', async () => {
    const harness = createPermissionApp({ auth: accountAuth('account-a', null, 'alpha') });
    harness.getCollaboratorPermissionLevel.mockRejectedValue(forbiddenError());

    await harness.status();
    await harness.status();
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(2);
    expect(harness.permissionRefusalCache.size()).toBe(0);
  });

  it('does not apply a refusal to a credential replaced in the same millisecond', async () => {
    const harness = createPermissionApp();
    harness.getCollaboratorPermissionLevel.mockRejectedValueOnce(forbiddenError());

    expect((await harness.status()).body.canMerge).toBe(false);
    harness.authRef.current = accountAuth('account-a', 'revision-2', 'alpha');
    expect((await harness.status()).body.canMerge).toBe(true);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(2);
  });

  it('writes a late refusal only under the credential revision that requested it', async () => {
    const harness = createPermissionApp();
    let rejectOldCredential;
    harness.getCollaboratorPermissionLevel.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectOldCredential = reject;
    }));

    const oldRequest = harness.status().then((response) => response);
    await vi.waitFor(() => expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1));

    harness.authRef.current = accountAuth('account-a', 'revision-2', 'alpha-renamed');
    expect((await harness.status()).body.canMerge).toBe(true);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenLastCalledWith(expect.objectContaining({
      username: 'alpha-renamed',
    }));

    rejectOldCredential(forbiddenError());
    expect((await oldRequest).body.canMerge).toBe(false);

    expect((await harness.status()).body.canMerge).toBe(true);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(3);

    harness.authRef.current = accountAuth('account-a', 'revision-1', 'alpha');
    expect((await harness.status()).body.canMerge).toBe(false);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(3);
  });

  it('isolates cached PR status by account and credential source', async () => {
    const harness = createPermissionApp();
    harness.getCollaboratorPermissionLevel.mockImplementation(async ({ username }) => {
      if (username === 'alpha') return { data: { permission: 'write' } };
      throw forbiddenError();
    });

    expect((await harness.status({ force: false })).body.canMerge).toBe(true);

    harness.authRef.current = accountAuth('account-b', 'revision-1', 'beta');
    expect((await harness.status({ force: false })).body.canMerge).toBe(false);
    expect(harness.resolveGitHubPrStatus).toHaveBeenCalledTimes(2);

    harness.authRef.current = null;
    expect((await harness.status({ force: false })).body.canMerge).toBe(false);
    expect(harness.resolveGitHubPrStatus).toHaveBeenCalledTimes(3);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(2);

    harness.authRef.current = accountAuth('account-a', 'revision-1', 'alpha');
    expect((await harness.status({ force: false })).body.canMerge).toBe(true);
    expect(harness.resolveGitHubPrStatus).toHaveBeenCalledTimes(3);
  });

  it('recomputes canMerge against the live managed branch assignment on a cache hit', async () => {
    const harness = createPermissionApp({ principal: managedPrincipal('main') });
    const directory = '/managed/repo';

    expect((await harness.status({ force: false, directory })).body.canMerge).toBe(true);

    harness.principalRef.current = managedPrincipal('other');
    const revoked = await harness.status({ force: false, directory });
    expect(revoked.body.canMerge).toBe(false);
    expect(revoked.body.pr).toEqual(expect.objectContaining({ number: 7, base: 'main' }));
    expect(harness.resolveGitHubPrStatus).toHaveBeenCalledTimes(1);
    expect(harness.octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1);

    harness.principalRef.current = managedPrincipal('main');
    expect((await harness.status({ force: false, directory })).body.canMerge).toBe(true);
    expect(harness.resolveGitHubPrStatus).toHaveBeenCalledTimes(1);
  });
});
