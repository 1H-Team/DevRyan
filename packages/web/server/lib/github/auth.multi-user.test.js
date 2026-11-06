import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';

let directory;
let auth;
let getOctokitOrNull;
let runWithRequestPrincipal;
let registerGitHubRoutes;
const originalDataDirectory = process.env.DEVRYAN_DATA_DIR;

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-github-auth-'));
  process.env.DEVRYAN_DATA_DIR = directory;
  vi.resetModules();
  auth = await import('./auth.js');
  ({ getOctokitOrNull } = await import('./octokit.js'));
  ({ runWithRequestPrincipal } = await import('../multi-user/request-context.js'));
  ({ registerGitHubRoutes } = await import('./routes.js'));
});

afterAll(async () => {
  if (originalDataDirectory === undefined) delete process.env.DEVRYAN_DATA_DIR;
  else process.env.DEVRYAN_DATA_DIR = originalDataDirectory;
  await fs.rm(directory, { recursive: true, force: true });
});

const accountInput = (accountId, login, token) => ({
  accountId,
  accessToken: token,
  scope: 'repo read:user user:email',
  user: { login, id: accountId === 'account-a' ? 101 : 202, name: `${login} Name`, email: `${login}@example.test` },
});

const managedPrincipal = (role = 'developer') => ({
  id: `${role}-id`,
  role,
  scope: 'managed',
  assignments: [
    { repositoryPath: '/worktree/a', githubAccountId: 'account-a', isDefault: true },
    { repositoryPath: '/worktree/b', githubAccountId: 'account-b', isDefault: false },
  ],
});

describe('multi-user GitHub auth storage', () => {
  it('preserves the current account during concurrent account updates and writes private storage', async () => {
    auth.setGitHubAuth({ ...accountInput('account-a', 'alpha', 'token-alpha'), makeCurrent: true });
    await Promise.all([
      Promise.resolve().then(() => auth.setGitHubAuth(accountInput('account-b', 'beta', 'token-beta'))),
      Promise.resolve().then(() => auth.setGitHubAuth(accountInput('account-a', 'alpha', 'token-alpha-new'))),
    ]);

    const accounts = auth.getGitHubAuthAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts.find((entry) => entry.id === 'account-a')?.current).toBe(true);
    expect(auth.getGitHubAuthById('account-a')?.accessToken).toBe('token-alpha-new');
    expect((await fs.stat(auth.GITHUB_AUTH_FILE)).mode & 0o777).toBe(0o600);
  });

  it('resolves only the profile association and prevents managed principals from mutating the host account pool', async () => {
    const developer = { ...managedPrincipal(), githubAccountId: 'account-a' };
    const selected = await runWithRequestPrincipal(developer, () => auth.getGitHubAuth(), {
      assignment: developer.assignments[1],
    });
    expect(selected?.accountId).toBe('account-a');

    const developerAccounts = await runWithRequestPrincipal(developer, () => auth.getGitHubAuthAccounts(), {
      assignment: developer.assignments[0],
    });
    expect(developerAccounts.map((entry) => entry.id)).toEqual(['account-a']);
    expect(await runWithRequestPrincipal(developer, () => auth.clearGitHubAuth('account-a'), {
      assignment: developer.assignments[0],
    })).toBe(false);
    expect(auth.getGitHubAuthById('account-a')).not.toBeNull();

    const admin = managedPrincipal('admin');
    const adminAccounts = await runWithRequestPrincipal(admin, () => auth.getGitHubAuthAccounts());
    expect(adminAccounts).toHaveLength(0);
    expect(auth.getAllGitHubAuthAccounts()).toHaveLength(2);
    expect(await runWithRequestPrincipal(admin, () => auth.clearGitHubAuth('account-b'))).toBe(false);
    expect(auth.clearGitHubAuthById('account-b')).toBe(true);
    expect(auth.getGitHubAuthById('account-b')).toBeNull();
    expect(auth.getGitHubAuthById('account-a')).not.toBeNull();
    expect(await runWithRequestPrincipal(developer, () => getOctokitOrNull(), {
      assignment: developer.assignments[1],
    })).not.toBeNull();
  });

  it('uses the profile GitHub association ahead of compatibility assignment mirrors', async () => {
    auth.setGitHubAuth({ ...accountInput('account-b', 'beta', 'token-beta'), makeCurrent: false });
    const developer = { ...managedPrincipal(), githubAccountId: 'account-a' };
    const selected = await runWithRequestPrincipal(developer, () => auth.getGitHubAuth(), {
      assignment: developer.assignments[1],
    });

    expect(selected?.accountId).toBe('account-a');
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('GitHub credential revisions', () => {
  it('rotates on every replacement, survives activation and other-account writes, and never leaves the server', async () => {
    const first = auth.setGitHubAuth({ ...accountInput('account-a', 'alpha', 'token-revision'), makeCurrent: true });
    expect(first.credentialRevision).toMatch(UUID_PATTERN);
    expect(auth.getGitHubAuthById('account-a')?.credentialRevision).toBe(first.credentialRevision);

    const replaced = auth.setGitHubAuth({ ...accountInput('account-a', 'alpha', 'token-revision'), makeCurrent: true });
    expect(replaced.credentialRevision).toMatch(UUID_PATTERN);
    expect(replaced.credentialRevision).not.toBe(first.credentialRevision);

    auth.setGitHubAuth({ ...accountInput('account-b', 'beta', 'token-beta'), makeCurrent: false });
    const betaRevision = auth.getGitHubAuthById('account-b')?.credentialRevision;
    expect(betaRevision).toMatch(UUID_PATTERN);
    expect(auth.getGitHubAuthById('account-a')?.credentialRevision).toBe(replaced.credentialRevision);

    expect(auth.activateGitHubAuth('account-b')).toBe(true);
    expect(auth.getGitHubAuth()?.accountId).toBe('account-b');
    expect(auth.getGitHubAuth()?.credentialRevision).toBe(betaRevision);
    expect(auth.getGitHubAuthById('account-a')?.credentialRevision).toBe(replaced.credentialRevision);
    expect(auth.activateGitHubAuth('account-a')).toBe(true);

    const developer = { ...managedPrincipal(), githubAccountId: 'account-a' };
    const projections = [
      auth.getGitHubAuthAccounts(),
      auth.getAllGitHubAuthAccounts(),
      await runWithRequestPrincipal(developer, () => auth.getGitHubAuthAccounts(), {
        assignment: developer.assignments[0],
      }),
    ];
    for (const projection of projections) {
      expect(projection.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(projection);
      expect(serialized).not.toContain('credentialRevision');
      expect(serialized).not.toContain(replaced.credentialRevision);
      expect(serialized).not.toContain(betaRevision);
    }

    const app = express();
    registerGitHubRoutes(app, {
      getGhCliToken: () => null,
      loadGitHubLibraries: async () => ({
        ...auth,
        getOctokitOrNull: () => ({
          rest: {
            users: {
              getAuthenticated: async () => ({
                data: { login: 'alpha', id: 101, avatar_url: null, name: 'alpha Name', email: 'alpha@example.test' },
              }),
            },
          },
        }),
      }),
    });
    const response = await request(app).get('/api/github/auth/status').expect(200);
    expect(response.body.connected).toBe(true);
    expect(response.body.activeAccountId).toBe('account-a');
    const serializedStatus = JSON.stringify(response.body);
    expect(serializedStatus).not.toContain('credentialRevision');
    expect(serializedStatus).not.toContain(replaced.credentialRevision);
    expect(serializedStatus).not.toContain(betaRevision);
    expect(serializedStatus).not.toContain('token-revision');
  });

  it('keeps legacy entries revision-less until their credential is replaced', async () => {
    await fs.writeFile(auth.GITHUB_AUTH_FILE, JSON.stringify([
      { accountId: 'legacy', accessToken: 'token-legacy', user: { login: 'legacy' }, current: true },
    ]), { mode: 0o600 });

    expect(auth.getGitHubAuthById('legacy')).not.toHaveProperty('credentialRevision');
    expect(auth.activateGitHubAuth('legacy')).toBe(true);
    const stored = JSON.parse(await fs.readFile(auth.GITHUB_AUTH_FILE, 'utf8'));
    expect(stored[0]).not.toHaveProperty('credentialRevision');

    const replaced = auth.setGitHubAuth({ accountId: 'legacy', accessToken: 'token-legacy-new', user: { login: 'legacy' } });
    expect(replaced.credentialRevision).toMatch(UUID_PATTERN);
    expect(auth.getGitHubAuthById('legacy')?.credentialRevision).toBe(replaced.credentialRevision);
  });
});
