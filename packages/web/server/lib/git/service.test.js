import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import simpleGit from 'simple-git';
import { createRecordStore } from '@openchamber/harness-runtime';

import {
  applyHunk,
  buildGitEnv,
  canonicalizeWorktreeState,
  commit,
  configureWorktreeBootstrapRuntime,
  getBranches,
  getLog,
  getRemotes,
  getRemoteUrl,
  getStatus,
  getWorktreeBootstrapStatus,
  isInsideOrSameDirectory,
  isGitRepository,
  resolveBaseRefForLog,
  stageFile,
  unstageFile,
} from './service.js';

const tempDirs = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('isInsideOrSameDirectory', () => {
  it('treats identical and nested paths as inside the parent', () => {
    expect(isInsideOrSameDirectory('/data/worktree', '/data/worktree')).toBe(true);
    expect(isInsideOrSameDirectory('/data/worktree', '/data/worktree/proj/feature')).toBe(true);
  });

  it('treats outside, sibling-prefix, and traversal paths as not inside', () => {
    expect(isInsideOrSameDirectory('/data/worktree', '/data/other')).toBe(false);
    expect(isInsideOrSameDirectory('/data/worktree', '/etc/passwd')).toBe(false);
    expect(isInsideOrSameDirectory('/data/worktree', '/data/worktree-evil')).toBe(false);
    expect(isInsideOrSameDirectory('', '/data/worktree')).toBe(false);
    expect(isInsideOrSameDirectory('/data/worktree', '')).toBe(false);
  });
});

describe('background Git environment', () => {
  it('disables optional index locks only when requested', async () => {
    await expect(buildGitEnv(null, { optionalLocks: false })).resolves.toMatchObject({
      GIT_OPTIONAL_LOCKS: '0',
    });
  });
});

describe('getRemotes', () => {
  it('returns an empty remote list for non-git directories without logging noise', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-non-git-'));
    tempDirs.push(directory);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getRemotes(directory)).resolves.toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('worktree bootstrap compatibility status', () => {
  it('treats an existing non-Git workspace as not applicable and a missing directory as absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-bootstrap-workspace-'));
    tempDirs.push(directory);
    const runtime = configureWorktreeBootstrapRuntime({
      store: createRecordStore({
        directory: join(directory, 'operations'),
      }),
    });

    await expect(getWorktreeBootstrapStatus(directory)).resolves.toMatchObject({
      directory,
      status: 'not_applicable',
    });
    await expect(getWorktreeBootstrapStatus(join(directory, 'missing'))).rejects.toMatchObject({
      code: 'WORKTREE_NOT_FOUND',
      statusCode: 404,
    });
    await runtime.drain();
  });

  it('preserves user edits when a populated worktree bootstrap is replayed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-bootstrap-replay-'));
    tempDirs.push(directory);
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'DevRyan Test');
    await git.addConfig('user.email', 'devryan@example.com');
    await writeFile(join(directory, 'tracked.txt'), 'initial\n');
    await git.add('tracked.txt');
    await git.commit('initial commit');

    const runtime = configureWorktreeBootstrapRuntime({
      store: createRecordStore({ directory: join(directory, '.operations') }),
    });
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'replay-preserves-edit',
      directory,
    });
    await runtime.executeStage(receipt.operationId, 'prepare_remote', async () => undefined);
    await runtime.executeStage(receipt.operationId, 'create_worktree', async () => undefined);
    await runtime.executeStage(receipt.operationId, 'sync_project_metadata', async () => undefined);
    await writeFile(join(directory, 'tracked.txt'), 'user edit\n');

    await runtime.queue(receipt.operationId);
    await runtime.drain();

    expect(await readFile(join(directory, 'tracked.txt'), 'utf8')).toBe('user edit\n');
    expect(await runtime.getReceipt(receipt.operationId)).toMatchObject({ status: 'ready' });
  });

  it('populates a newly created no-checkout worktree before treating it as replay-safe', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openchamber-bootstrap-populate-'));
    tempDirs.push(parent);
    const repository = join(parent, 'repository');
    const worktree = join(parent, 'worktree');
    await mkdir(repository);
    const git = simpleGit(repository);
    await git.init();
    await git.addConfig('user.name', 'DevRyan Test');
    await git.addConfig('user.email', 'devryan@example.com');
    await writeFile(join(repository, 'tracked.txt'), 'initial\n');
    await git.add('tracked.txt');
    await git.commit('initial commit');
    await git.raw(['worktree', 'add', '--no-checkout', '-b', 'populate-test', worktree]);

    const runtime = configureWorktreeBootstrapRuntime({
      store: createRecordStore({ directory: join(parent, '.operations') }),
    });
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'populate-no-checkout',
      directory: worktree,
    });
    await runtime.executeStage(receipt.operationId, 'prepare_remote', async () => undefined);
    await runtime.executeStage(receipt.operationId, 'create_worktree', async () => undefined);
    await runtime.executeStage(receipt.operationId, 'sync_project_metadata', async () => undefined);

    await runtime.queue(receipt.operationId);
    await runtime.drain();

    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('initial\n');
    expect(await runtime.getReceipt(receipt.operationId)).toMatchObject({ status: 'ready' });
  });
});

describe('file staging', () => {
  const createRepo = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-git-service-'));
    tempDirs.push(directory);
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'DevRyan Test');
    await git.addConfig('user.email', 'devryan@example.com');
    await writeFile(join(directory, 'tracked.txt'), 'initial\n');
    await git.add('tracked.txt');
    await git.commit('initial commit');
    return { directory, git };
  };

  it('stages and unstages a modified file', async () => {
    const { directory } = await createRepo();
    await writeFile(join(directory, 'tracked.txt'), 'changed\n');

    await stageFile(directory, 'tracked.txt');
    let status = await getStatus(directory);
    expect(status.files).toContainEqual({ path: 'tracked.txt', index: 'M', working_dir: ' ' });

    await unstageFile(directory, 'tracked.txt');
    status = await getStatus(directory);
    expect(status.files).toContainEqual({ path: 'tracked.txt', index: ' ', working_dir: 'M' });
  });

  it('applies a valid hunk with the stricter repository client contract', async () => {
    const { directory, git } = await createRepo();
    await writeFile(join(directory, 'tracked.txt'), 'changed\n');
    const patch = await git.diff(['--', 'tracked.txt']);

    await applyHunk(directory, 'tracked.txt', { patch, action: 'stage' });

    const status = await git.status();
    expect(status.files).toContainEqual(expect.objectContaining({
      path: 'tracked.txt',
      index: 'M',
      working_dir: ' ',
    }));
  });

  it('commits only staged files when stagedOnly is requested', async () => {
    const { directory, git } = await createRepo();
    await writeFile(join(directory, 'tracked.txt'), 'staged\n');
    await writeFile(join(directory, 'unstaged.txt'), 'untracked\n');

    await stageFile(directory, 'tracked.txt');
    await commit(directory, 'commit staged file', {
      files: ['tracked.txt'],
      stagedOnly: true,
    });

    const committedFiles = await git.raw(['show', '--name-only', '--format=', 'HEAD']);
    expect(committedFiles.trim().split('\n')).toEqual(['tracked.txt']);

    const status = await getStatus(directory);
    expect(status.files).toContainEqual({ path: 'unstaged.txt', index: '?', working_dir: '?' });
    expect(status.files.some((file) => file.path === 'tracked.txt')).toBe(false);
  });
});

describe('project directory isolation', () => {
  it('rejects an empty directory before constructing a repository client', async () => {
    await expect(getRemoteUrl('')).rejects.toThrow('Git directory is required');
  });

  it('does not inherit repository context from an ancestor directory', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'devryan-git-parent-'));
    tempDirs.push(repository);
    await simpleGit(repository).init();
    const nestedProject = join(repository, 'nested-project');
    await mkdir(nestedProject);

    await expect(isGitRepository(nestedProject)).resolves.toBe(false);
    await expect(getStatus(nestedProject)).rejects.toMatchObject({
      code: 'GIT_REPOSITORY_CONTEXT_MISMATCH',
    });
  });

  it('reports missing project directories as non-repositories and rejects status collection', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'devryan-git-missing-'));
    tempDirs.push(parent);
    const missing = join(parent, 'deleted-project');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(isGitRepository(missing)).resolves.toBe(false);
    await expect(getStatus(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('git status remote divergence without upstream tracking', () => {
  const createRepo = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-git-status-'));
    tempDirs.push(directory);
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'DevRyan Test');
    await git.addConfig('user.email', 'devryan@example.com');
    await git.checkoutLocalBranch('main');
    await writeFile(join(directory, 'tracked.txt'), 'base\n');
    await git.add('tracked.txt');
    await git.commit('base commit');
    return { directory, git };
  };

  it('reports pullable commits from the same-named origin branch when no upstream is configured', async () => {
    const { directory, git } = await createRepo();
    const baseHash = (await git.revparse(['HEAD'])).trim();
    await git.checkoutLocalBranch('remote-main');
    await writeFile(join(directory, 'tracked.txt'), 'base\nremote\n');
    await git.add('tracked.txt');
    await git.commit('remote commit');
    const remoteHash = (await git.revparse(['HEAD'])).trim();
    await git.checkout('main');
    await git.raw(['reset', '--hard', baseHash]);
    await git.raw(['update-ref', 'refs/remotes/origin/main', remoteHash]);

    const status = await getStatus(directory);

    expect(status.tracking).toBeNull();
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(1);
  });

  it('does not report origin main as pullable for unrelated untracked feature branches', async () => {
    const { directory, git } = await createRepo();
    const baseHash = (await git.revparse(['HEAD'])).trim();
    await git.checkoutLocalBranch('remote-main');
    await writeFile(join(directory, 'tracked.txt'), 'base\nremote\n');
    await git.add('tracked.txt');
    await git.commit('remote commit');
    const remoteHash = (await git.revparse(['HEAD'])).trim();
    await git.checkout('main');
    await git.raw(['reset', '--hard', baseHash]);
    await git.raw(['update-ref', 'refs/remotes/origin/main', remoteHash]);
    await git.checkoutLocalBranch('feature');
    await writeFile(join(directory, 'tracked.txt'), 'base\nfeature\n');
    await git.add('tracked.txt');
    await git.commit('feature commit');

    const status = await getStatus(directory);

    expect(status.tracking).toBeNull();
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
  });
});

describe('git log base ref resolution', () => {
  it('prefers a local base ref over origin when both exist', async () => {
    const checkedRefs = [];
    const result = await resolveBaseRefForLog('main', async (ref) => {
      checkedRefs.push(ref);
      return ref === 'refs/heads/main' || ref === 'refs/remotes/origin/main';
    });

    expect(result).toBe('main');
    expect(checkedRefs).toEqual(['refs/heads/main']);
  });

  it('falls back to origin base ref when the local ref is absent', async () => {
    const result = await resolveBaseRefForLog('main', async (ref) => ref === 'refs/remotes/origin/main');

    expect(result).toBe('origin/main');
  });

  it('uses a remote-only origin base for custom log ranges', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-git-log-'));
    tempDirs.push(directory);
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'DevRyan Test');
    await git.addConfig('user.email', 'devryan@example.com');
    await git.checkoutLocalBranch('main');
    await writeFile(join(directory, 'tracked.txt'), 'base\n');
    await git.add('tracked.txt');
    await git.commit('base commit');
    const baseHash = (await git.revparse(['HEAD'])).trim();
    await git.checkoutLocalBranch('feature');
    await writeFile(join(directory, 'tracked.txt'), 'base\nfeature\n');
    await git.add('tracked.txt');
    await git.commit('feature commit');
    await git.raw(['update-ref', 'refs/remotes/origin/main', baseHash]);
    await git.raw(['branch', '-D', 'main']);

    const log = await getLog(directory, { from: 'main', to: 'HEAD' });

    expect(log.all.map((entry) => entry.message)).toEqual(['feature commit']);
  });
});

describe('git branch listing', () => {
  const createRepo = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-git-branches-'));
    tempDirs.push(directory);
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'DevRyan Test');
    await git.addConfig('user.email', 'devryan@example.com');
    await git.checkoutLocalBranch('main');
    await writeFile(join(directory, 'tracked.txt'), 'base\n');
    await git.add('tracked.txt');
    await git.commit('base commit');
    return { directory, git };
  };

  it('returns an empty branch list for non-git directories without logging noise', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-non-git-branches-'));
    tempDirs.push(directory);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getBranches(directory)).resolves.toEqual({
      all: [],
      current: null,
      branches: {},
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('preserves local remote-tracking branches when the remote cannot be probed', async () => {
    const { directory, git } = await createRepo();
    const head = (await git.revparse(['HEAD'])).trim();
    await git.raw(['update-ref', 'refs/remotes/origin/main', head]);
    await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    await git.raw(['remote', 'add', 'origin', join(tmpdir(), 'openchamber-missing-remote')]);

    const branches = await getBranches(directory);

    expect(branches.all).toContain('main');
    expect(branches.all).toContain('remotes/origin/main');
    expect(branches.all).not.toContain('remotes/origin/HEAD');
  });
});

describe('worktree canonicalization', () => {
  const createRepo = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openchamber-git-canonical-'));
    tempDirs.push(directory);
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'DevRyan Test');
    await git.addConfig('user.email', 'devryan@example.com');
    await git.checkoutLocalBranch('main');
    await writeFile(join(directory, 'tracked.txt'), 'base\n');
    await git.add('tracked.txt');
    await git.commit('base commit');
    return { directory, git };
  };

  it('uses the primary repository top-level as the canonical worktree root', async () => {
    const { directory } = await createRepo();
    const expectedDirectory = await realpath(directory);

    const canonical = await canonicalizeWorktreeState(directory);

    expect(canonical).toMatchObject({
      worktreeRoot: expectedDirectory,
      cwd: expectedDirectory,
      branch: 'main',
      headState: 'branch',
      worktreeStatus: 'ready',
      degraded: false,
    });
  });

  it('uses the primary repository top-level when canonicalized from a nested directory', async () => {
    const { directory } = await createRepo();
    const nestedDirectory = join(directory, 'src', 'nested');
    await mkdir(nestedDirectory, { recursive: true });
    const expectedDirectory = await realpath(directory);

    const canonical = await canonicalizeWorktreeState(nestedDirectory);

    expect(canonical).toMatchObject({
      worktreeRoot: expectedDirectory,
      cwd: expectedDirectory,
      branch: 'main',
      headState: 'branch',
      worktreeStatus: 'ready',
      degraded: false,
    });
  });

  it('uses a linked worktree top-level as the canonical worktree root', async () => {
    const { git } = await createRepo();
    const worktreeParent = await mkdtemp(join(tmpdir(), 'openchamber-linked-worktree-'));
    tempDirs.push(worktreeParent);
    const worktreeDirectory = join(worktreeParent, 'feature');
    await git.raw(['worktree', 'add', '-b', 'feature', worktreeDirectory]);
    const expectedDirectory = await realpath(worktreeDirectory);

    const canonical = await canonicalizeWorktreeState(worktreeDirectory);

    expect(canonical).toMatchObject({
      worktreeRoot: expectedDirectory,
      cwd: expectedDirectory,
      branch: 'feature',
      headState: 'branch',
      worktreeStatus: 'ready',
      degraded: false,
    });
  });
});
