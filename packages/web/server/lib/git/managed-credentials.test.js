import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => new Map());

vi.mock('../github/auth.js', () => ({
  getGitHubAuthById: (accountId) => accounts.get(accountId) || null,
}));

import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import { buildGitEnv, commit, getBranches, merge, pull, stageFile } from './service.js';

const execFileAsync = promisify(execFile);

const temporaryDirectories = [];
const originalDataDirectory = process.env.OPENCHAMBER_DATA_DIR;

beforeEach(async () => {
  accounts.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-credentials-'));
  temporaryDirectories.push(directory);
  process.env.OPENCHAMBER_DATA_DIR = directory;
});

afterEach(async () => {
  if (originalDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = originalDataDirectory;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const account = (login, id, token) => ({
  accessToken: token,
  user: { login, id, name: `${login} Name`, email: `${login}@example.test` },
});

const principal = (id, directory, accountId) => ({
  id,
  email: `${id}@example.test`,
  displayName: id,
  role: 'developer',
  scope: 'managed',
  githubAccountId: accountId,
  assignments: [{ repositoryPath: directory, githubAccountId: accountId }],
});

const git = (directory, args) => execFileAsync('git', ['-C', directory, ...args], { encoding: 'utf8' });

const createManagedRepository = async () => {
  const directory = path.join(temporaryDirectories[0], 'repository');
  await fs.mkdir(directory, { recursive: true });
  await git(directory, ['init', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Test User']);
  await git(directory, ['config', 'user.email', 'test@example.test']);
  await fs.writeFile(path.join(directory, 'README.md'), 'initial\n');
  await git(directory, ['add', 'README.md']);
  await git(directory, ['commit', '-m', 'initial']);
  await git(directory, ['branch', 'unselected']);
  await git(directory, ['checkout', '-b', 'developer']);
  return directory;
};

describe('managed Git credential isolation', () => {
  it('builds concurrent operation environments with distinct tokens and authors', async () => {
    const firstDirectory = path.join(temporaryDirectories[0], 'first');
    const secondDirectory = path.join(temporaryDirectories[0], 'second');
    accounts.set('account-first', account('first-user', 101, 'token-first'));
    accounts.set('account-second', account('second-user', 202, 'token-second'));

    const [first, second] = await Promise.all([
      runWithRequestPrincipal(principal('user-first', firstDirectory, 'account-first'), () => (
        buildGitEnv(firstDirectory, { includeCredentials: true })
      )),
      runWithRequestPrincipal(principal('user-second', secondDirectory, 'account-second'), () => (
        buildGitEnv(secondDirectory, { includeCredentials: true })
      )),
    ]);

    expect(first.DEVRYAN_GIT_ASKPASS_TOKEN).toBe('token-first');
    expect(first.GIT_AUTHOR_NAME).toBe('first-user Name');
    expect(first.GIT_AUTHOR_EMAIL).toBe('first-user@example.test');
    expect(second.DEVRYAN_GIT_ASKPASS_TOKEN).toBe('token-second');
    expect(second.GIT_AUTHOR_NAME).toBe('second-user Name');
    expect(second.GIT_AUTHOR_EMAIL).toBe('second-user@example.test');
    expect(first.GIT_ASKPASS).toBe(second.GIT_ASKPASS);
    const helper = await fs.readFile(first.GIT_ASKPASS, 'utf8');
    expect(helper).not.toContain('token-first');
    expect(helper).not.toContain('token-second');
  });

  it('uses an explicitly selected account during durable provisioning retries without a request principal', async () => {
    accounts.set('provisioning-account', account('provisioner', 303, 'provisioning-token'));

    const env = await buildGitEnv(temporaryDirectories[0], {
      includeCredentials: true,
      githubAccountId: 'provisioning-account',
    });

    expect(env.DEVRYAN_GIT_ASKPASS_TOKEN).toBe('provisioning-token');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('keeps branch listings authoritative because grants are only a UI visibility filter', async () => {
    const directory = await createManagedRepository();
    const managedPrincipal = {
      ...principal('user-first', directory, null),
      assignments: [{
        projectId: 'project-1',
        repositoryPath: directory,
        publicDirectory: directory,
        worktreeContainerPath: path.join(temporaryDirectories[0], 'worktrees'),
        branchName: 'developer',
        githubAccountId: null,
      }],
    };

    const branches = await runWithRequestPrincipal(managedPrincipal, () => getBranches(directory));

    expect(branches.current).toBe('developer');
    expect(branches.all).toEqual(expect.arrayContaining(['developer', 'main', 'unselected']));
  });

  it('allows real branch mutations without an internal-branch guard', async () => {
    const directory = await createManagedRepository();
    const managedPrincipal = {
      ...principal('user-first', directory, null),
      assignments: [{
        projectId: 'project-1',
        repositoryPath: directory,
        publicDirectory: directory,
        worktreeContainerPath: path.join(temporaryDirectories[0], 'worktrees'),
        branchName: 'developer',
        githubAccountId: null,
      }],
    };

    await expect(runWithRequestPrincipal(managedPrincipal, () => merge(directory, { branch: 'main' })))
      .resolves.toMatchObject({ success: true });

    await git(directory, ['checkout', 'main']);
    await expect(runWithRequestPrincipal(managedPrincipal, () => stageFile(directory, 'README.md')))
      .resolves.toBeUndefined();
  });

  it('allows mutations inside the shared OpenCode worktree container', async () => {
    const directory = await createManagedRepository();
    const worktreeContainerPath = path.join(temporaryDirectories[0], 'worktrees');
    const worktreePath = path.join(worktreeContainerPath, 'feature');
    await fs.mkdir(worktreeContainerPath, { recursive: true });
    await git(directory, ['branch', 'feature']);
    await git(directory, ['worktree', 'add', worktreePath, 'feature']);
    const managedPrincipal = {
      ...principal('user-first', directory, null),
      assignments: [{
        projectId: 'project-1',
        repositoryPath: directory,
        publicDirectory: directory,
        worktreeContainerPath,
        branchName: 'developer',
        githubAccountId: null,
      }],
    };

    await fs.writeFile(path.join(worktreePath, 'FEATURE.md'), 'feature\n');
    await expect(runWithRequestPrincipal(managedPrincipal, () => (
      commit(worktreePath, 'feature commit', { addAll: true })
    ))).resolves.toMatchObject({ success: true, branch: 'feature' });
  });

  it('classifies managed pull and commit attempts against an unmerged index', async () => {
    const directory = await createManagedRepository();
    const managedPrincipal = {
      ...principal('user-first', directory, null),
      assignments: [{
        projectId: 'project-1',
        repositoryPath: directory,
        publicDirectory: directory,
        worktreeContainerPath: path.join(temporaryDirectories[0], 'worktrees'),
        branchName: 'developer',
        githubAccountId: null,
        remoteUrl: null,
      }],
    };

    await fs.writeFile(path.join(directory, 'README.md'), 'managed change\n');
    await git(directory, ['add', 'README.md']);
    await git(directory, ['commit', '-m', 'managed change']);
    await git(directory, ['checkout', 'main']);
    await fs.writeFile(path.join(directory, 'README.md'), 'main change\n');
    await git(directory, ['add', 'README.md']);
    await git(directory, ['commit', '-m', 'main change']);
    await git(directory, ['checkout', 'developer']);
    await git(directory, ['merge', 'main']).catch(() => undefined);
    await git(directory, ['remote', 'add', 'origin', directory]);

    await expect(runWithRequestPrincipal(managedPrincipal, () => pull(directory, { branch: 'developer' })))
      .resolves.toMatchObject({
        success: false,
        conflict: true,
        conflictFiles: ['README.md'],
      });
    await expect(runWithRequestPrincipal(managedPrincipal, () => commit(directory, 'blocked commit')))
      .rejects.toMatchObject({
        code: 'GIT_UNMERGED_INDEX',
        statusCode: 409,
        conflictFiles: ['README.md'],
        message: 'Resolve merge conflicts before continuing',
      });
  });
});
