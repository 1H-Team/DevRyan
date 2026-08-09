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

  it('returns a linked worktree as pending while its bootstrap is still running', async () => {
    const bootstrap = {
      status: 'running',
      stage: 'populate_worktree',
      operationId: 'op-running',
    };
    const git = {
      getBranches: vi.fn(async () => ({ all: ['dev', 'main'], branches: {} })),
      getWorktrees: vi.fn(async () => [
        { path: '/repo', branch: 'refs/heads/main' },
        { path: '/worktrees/dev', branch: 'refs/heads/dev' },
      ]),
      getWorktreeBootstrapStatus: vi.fn(async () => bootstrap),
      retryWorktreeBootstrapOperation: vi.fn(),
      getStatus: vi.fn(),
      createWorktree: vi.fn(),
    };

    await expect(ensureBranchTarget({
      repositoryPath: '/repo', branchName: 'dev', idempotencyKey: 'request-running', ownerId: 'user-1', git,
    })).resolves.toMatchObject({
      status: 'pending',
      source: 'worktree',
      operationId: 'op-running',
      bootstrap,
    });
    expect(git.retryWorktreeBootstrapOperation).not.toHaveBeenCalled();
  });

  it('retries a failed existing-branch population receipt before reusing its worktree', async () => {
    const failed = {
      status: 'failed',
      stage: 'populate_worktree',
      operationId: 'op-failed',
      metadata: { mode: 'existing' },
    };
    const retried = { ...failed, status: 'queued', attempt: 2 };
    const git = {
      getBranches: vi.fn(async () => ({ all: ['dev', 'main'], branches: {} })),
      getWorktrees: vi.fn(async () => [
        { path: '/repo', branch: 'refs/heads/main' },
        { path: '/worktrees/dev', branch: 'refs/heads/dev' },
      ]),
      getWorktreeBootstrapStatus: vi.fn(async () => failed),
      retryWorktreeBootstrapOperation: vi.fn(async () => retried),
      getStatus: vi.fn(),
      createWorktree: vi.fn(),
    };

    await expect(ensureBranchTarget({
      repositoryPath: '/repo', branchName: 'dev', idempotencyKey: 'request-retry', ownerId: 'user-1', git,
    })).resolves.toMatchObject({
      status: 'pending',
      source: 'worktree',
      operationId: 'op-failed',
      bootstrap: retried,
    });
    expect(git.retryWorktreeBootstrapOperation).toHaveBeenCalledWith('op-failed');
    expect(git.createWorktree).not.toHaveBeenCalled();
  });

  it('surfaces non-retryable linked-worktree failures without falling back to another branch', async () => {
    const failed = {
      status: 'needs_attention',
      stage: 'run_project_setup',
      operationId: 'op-attention',
      metadata: { mode: 'existing' },
    };
    const git = {
      getBranches: vi.fn(async () => ({ all: ['dev', 'main'], branches: {} })),
      getWorktrees: vi.fn(async () => [
        { path: '/repo', branch: 'refs/heads/main' },
        { path: '/worktrees/dev', branch: 'refs/heads/dev' },
      ]),
      getWorktreeBootstrapStatus: vi.fn(async () => failed),
      retryWorktreeBootstrapOperation: vi.fn(),
      getStatus: vi.fn(),
      createWorktree: vi.fn(),
    };

    await expect(ensureBranchTarget({
      repositoryPath: '/repo', branchName: 'dev', idempotencyKey: 'request-attention', ownerId: 'user-1', git,
    })).resolves.toMatchObject({
      status: 'failure',
      source: 'worktree',
      operationId: 'op-attention',
      message: 'Worktree setup needs attention before this branch can be used',
    });
    expect(git.retryWorktreeBootstrapOperation).not.toHaveBeenCalled();
    expect(git.getStatus).not.toHaveBeenCalled();
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
