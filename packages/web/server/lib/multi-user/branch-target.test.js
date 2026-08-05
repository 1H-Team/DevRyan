import { describe, expect, it, vi } from 'vitest';

import { buildBranchOptions, ensureBranchTarget } from './branch-target.js';

describe('managed branch targets', () => {
  it('folds local and same-name remote refs into deterministic options', () => {
    expect(buildBranchOptions({
      all: ['dev', 'remotes/upstream/dev', 'remotes/origin/dev', 'remotes/fork/release'],
      branches: { dev: { tracking: 'origin/dev' } },
    })).toEqual([
      {
        name: 'dev',
        local: true,
        remoteRefs: ['remotes/origin/dev', 'remotes/upstream/dev'],
        preferredRef: 'dev',
      },
      {
        name: 'release',
        local: false,
        remoteRefs: ['remotes/fork/release'],
        preferredRef: 'remotes/fork/release',
      },
    ]);
  });

  it('reuses a linked worktree and never falls back to the root branch', async () => {
    const git = {
      getBranches: vi.fn(async () => ({ all: ['dev', 'main'], branches: {} })),
      getWorktrees: vi.fn(async () => [
        { path: '/repo', branch: 'refs/heads/main' },
        { path: '/worktrees/dev', branch: 'refs/heads/dev' },
      ]),
      getStatus: vi.fn(),
      createWorktree: vi.fn(),
    };
    await expect(ensureBranchTarget({
      repositoryPath: '/repo', branchName: 'refs/heads/dev', idempotencyKey: 'request-1', ownerId: 'user-1', git,
    })).resolves.toMatchObject({ status: 'success', source: 'worktree', directory: '/worktrees/dev', branchName: 'dev' });
    expect(git.getStatus).not.toHaveBeenCalled();
    expect(git.createWorktree).not.toHaveBeenCalled();
  });

  it('creates a remote-only assigned branch with upstream metadata', async () => {
    const git = {
      getBranches: vi.fn(async () => ({ all: ['main', 'remotes/origin/dev'], branches: {} })),
      getWorktrees: vi.fn(async () => [{ path: '/repo', branch: 'refs/heads/main' }]),
      getStatus: vi.fn(async () => ({ current: 'main' })),
      createWorktree: vi.fn(async () => ({ path: '/worktrees/dev', operationId: 'op-1', bootstrap: { status: 'ready' } })),
    };
    await expect(ensureBranchTarget({
      repositoryPath: '/repo', branchName: 'dev', idempotencyKey: 'request-2', ownerId: 'user-1', git,
    })).resolves.toMatchObject({ status: 'success', source: 'created', directory: '/worktrees/dev' });
    expect(git.createWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
      existingBranch: 'remotes/origin/dev',
      branchName: 'dev',
      setUpstream: true,
      upstreamRemote: 'origin',
      upstreamBranch: 'dev',
    }));
  });

  it('returns unavailable for a stale grant without selecting main', async () => {
    const git = {
      getBranches: vi.fn(async () => ({ all: ['main'], branches: {} })),
      getWorktrees: vi.fn(async () => [{ path: '/repo', branch: 'refs/heads/main' }]),
      getStatus: vi.fn(),
      createWorktree: vi.fn(),
    };
    await expect(ensureBranchTarget({
      repositoryPath: '/repo', branchName: 'dev', idempotencyKey: 'request-3', ownerId: 'user-1', git,
    })).resolves.toMatchObject({ status: 'unavailable', branchName: 'dev' });
    expect(git.getStatus).not.toHaveBeenCalled();
    expect(git.createWorktree).not.toHaveBeenCalled();
  });
});
