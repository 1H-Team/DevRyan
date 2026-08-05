import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let directory;
let auth;
let getOctokitOrNull;
let runWithRequestPrincipal;
const originalDataDirectory = process.env.OPENCHAMBER_DATA_DIR;

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-github-auth-'));
  process.env.OPENCHAMBER_DATA_DIR = directory;
  vi.resetModules();
  auth = await import('./auth.js');
  ({ getOctokitOrNull } = await import('./octokit.js'));
  ({ runWithRequestPrincipal } = await import('../multi-user/request-context.js'));
});

afterAll(async () => {
  if (originalDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = originalDataDirectory;
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
