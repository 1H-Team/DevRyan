import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';
import { registerGitHubRoutes } from './routes.js';

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
});
