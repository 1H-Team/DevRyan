import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';
import { registerGitHubRoutes } from './routes.js';
import { runWithRequestPrincipal } from '../multi-user/request-context.js';

describe('GitHub OAuth client creation', () => {
  it('routes an OAuth-created client through the shared API factory', async () => {
    const createGitHubApiClient = vi.fn(() => ({
      rest: {
        users: {
          getAuthenticated: async () => ({
            data: {
              login: 'octocat',
              id: 1,
              avatar_url: 'https://avatars.example/octocat',
              name: 'Octo Cat',
              email: 'octocat@example.test',
            },
          }),
        },
      },
    }));
    const setGitHubAuth = vi.fn();
    const app = express();
    app.use(express.json());
    registerGitHubRoutes(app, {
      loadGitHubLibraries: async () => ({
        createGitHubApiClient,
        exchangeDeviceCode: async () => ({
          access_token: 'oauth-token',
          scope: 'repo',
          token_type: 'bearer',
        }),
        getGitHubAuthAccounts: () => [],
        getGitHubClientId: () => 'client-id',
        setGitHubAuth,
      }),
    });

    const response = await request(app)
      .post('/api/github/auth/complete')
      .send({ deviceCode: 'device-code' })
      .expect(200);

    expect(response.body.connected).toBe(true);
    expect(createGitHubApiClient).toHaveBeenCalledWith({ auth: 'oauth-token' });
    expect(setGitHubAuth).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'oauth-token',
      user: expect.objectContaining({ login: 'octocat' }),
    }));
  });

  it('rejects global account switching and disconnect controls for managed principals', async () => {
    const principal = {
      id: 'managed-admin',
      role: 'admin',
      scope: 'managed',
      githubAccountId: null,
      assignments: [],
    };
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithRequestPrincipal(principal, next));
    registerGitHubRoutes(app, { loadGitHubLibraries: async () => ({}) });

    const activate = await request(app)
      .post('/api/github/auth/activate')
      .send({ accountId: 'account-a' })
      .expect(409);
    expect(activate.body.code).toBe('MANAGED_GITHUB_ACCOUNT_REQUIRED');

    const disconnect = await request(app)
      .delete('/api/github/auth')
      .expect(409);
    expect(disconnect.body.code).toBe('MANAGED_GITHUB_ACCOUNT_REQUIRED');

    const ghCli = await request(app)
      .post('/api/github/auth/gh-cli')
      .send({ disabled: true })
      .expect(409);
    expect(ghCli.body.code).toBe('MANAGED_GITHUB_ACCOUNT_REQUIRED');
  });

  it('returns the exact profile-assigned GitHub avatar for a managed developer', async () => {
    const assignedUser = {
      login: 'assigned-dev',
      id: 42,
      avatarUrl: 'https://avatars.example/assigned-dev',
      name: 'Assigned Developer',
      email: null,
    };
    const principal = {
      id: 'managed-developer',
      role: 'developer',
      scope: 'managed',
      githubAccountId: 'account-assigned',
      assignments: [{ projectId: 'project-1', githubAccountId: 'account-assigned' }],
    };
    const staleStoredUser = {
      ...assignedUser,
      avatarUrl: 'https://avatars.example/stale-or-missing',
      name: 'Stale Stored Name',
    };
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithRequestPrincipal(principal, next));
    registerGitHubRoutes(app, {
      getGhCliToken: () => null,
      loadGitHubLibraries: async () => ({
        getGitHubAuth: () => ({ accountId: 'account-assigned', accessToken: 'assigned-token', scope: 'repo', user: staleStoredUser }),
        getGitHubAuthAccounts: () => [{ id: 'account-assigned', user: staleStoredUser, current: false }],
        getOctokitOrNull: () => ({
          rest: {
            users: {
              getAuthenticated: async () => ({
                data: {
                  login: assignedUser.login,
                  id: assignedUser.id,
                  avatar_url: assignedUser.avatarUrl,
                  name: assignedUser.name,
                  email: assignedUser.email,
                },
              }),
              listEmailsForAuthenticatedUser: async () => ({ data: [] }),
            },
          },
        }),
        clearGitHubAuth: vi.fn(),
        isGhCliDisabled: () => false,
      }),
    });

    const response = await request(app).get('/api/github/auth/status').expect(200);

    expect(response.body.connected).toBe(true);
    expect(response.body.activeAccountId).toBe('account-assigned');
    expect(response.body.user.avatarUrl).toBe(assignedUser.avatarUrl);
    expect(response.body.accounts).toEqual([{ id: 'account-assigned', user: assignedUser, current: true }]);
  });

  it('returns assigned public identity without using the credential when GitHub operations are disabled', async () => {
    const assignedUser = {
      login: 'assigned-dev', id: 42, avatarUrl: 'https://avatars.example/assigned-dev', name: 'Assigned Developer', email: null,
    };
    const principal = {
      id: 'managed-developer', role: 'developer', scope: 'managed', githubAccountId: 'account-assigned',
      policy: { github: false }, assignments: [],
    };
    const getOctokitOrNull = vi.fn(() => {
      throw new Error('credential must not be exercised');
    });
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithRequestPrincipal(principal, next));
    registerGitHubRoutes(app, {
      getGhCliToken: () => null,
      loadGitHubLibraries: async () => ({
        getGitHubAuth: () => ({ accountId: 'account-assigned', accessToken: 'assigned-token', scope: 'repo', user: assignedUser }),
        getGitHubAuthAccounts: () => [{ id: 'account-assigned', user: assignedUser, current: false }],
        getOctokitOrNull,
        isGhCliDisabled: () => false,
      }),
    });

    const response = await request(app).get('/api/github/auth/status').expect(200);

    expect(response.body).toMatchObject({
      connected: true,
      activeAccountId: 'account-assigned',
      user: assignedUser,
      accounts: [{ id: 'account-assigned', user: assignedUser, current: true }],
    });
    expect(getOctokitOrNull).not.toHaveBeenCalled();
  });
});
