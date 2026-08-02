import { describe, expect, it, vi } from 'vitest';
import {
  expandRepoNetwork,
  resolveGitHubPrStatus,
  resolveRemoteCandidates,
} from './pr-status.js';
import { getRepoDefaultBranch } from './repo/fork-detection.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

describe('GitHub PR status resolution', () => {
  it('resolves remotes and metadata concurrently without changing ranked order', async () => {
    const remoteGates = new Map([
      ['origin', deferred()],
      ['upstream', deferred()],
      ['duplicate', deferred()],
    ]);
    let activeRemoteReads = 0;
    let maxActiveRemoteReads = 0;
    const remoteResolution = resolveRemoteCandidates('/repo', [...remoteGates.keys()], async (_directory, remoteName) => {
      activeRemoteReads += 1;
      maxActiveRemoteReads = Math.max(maxActiveRemoteReads, activeRemoteReads);
      try {
        return await remoteGates.get(remoteName).promise;
      } finally {
        activeRemoteReads -= 1;
      }
    });

    await Promise.resolve();
    expect(activeRemoteReads).toBe(3);
    remoteGates.get('upstream').resolve({ repo: { owner: 'base', repo: 'project' } });
    remoteGates.get('duplicate').resolve({ repo: { owner: 'fork', repo: 'project' } });
    remoteGates.get('origin').resolve({ repo: { owner: 'fork', repo: 'project' } });

    const candidates = await remoteResolution;
    expect(maxActiveRemoteReads).toBe(3);
    expect(candidates).toEqual([
      { remoteName: 'origin', repo: { owner: 'fork', repo: 'project' } },
      { remoteName: 'upstream', repo: { owner: 'base', repo: 'project' } },
    ]);

    const metadataGates = new Map([
      ['fork/project', deferred()],
      ['base/project', deferred()],
    ]);
    let activeMetadataReads = 0;
    let maxActiveMetadataReads = 0;
    const expansion = expandRepoNetwork(
      {},
      candidates.map((candidate, priority) => ({ ...candidate, priority })),
      async (_octokit, repo) => {
        activeMetadataReads += 1;
        maxActiveMetadataReads = Math.max(maxActiveMetadataReads, activeMetadataReads);
        try {
          return await metadataGates.get(`${repo.owner}/${repo.repo}`).promise;
        } finally {
          activeMetadataReads -= 1;
        }
      },
    );

    await Promise.resolve();
    expect(activeMetadataReads).toBe(2);
    metadataGates.get('base/project').resolve({ default_branch: 'main' });
    metadataGates.get('fork/project').resolve({
      default_branch: 'feature',
      parent: { owner: { login: 'base' }, name: 'project', html_url: 'https://github.com/base/project' },
    });

    expect(await expansion).toEqual([
      { repo: { owner: 'fork', repo: 'project' }, remoteName: 'origin', priority: 0 },
      { repo: { owner: 'base', repo: 'project', url: 'https://github.com/base/project' }, remoteName: 'origin', priority: 0.1 },
    ]);
    expect(maxActiveMetadataReads).toBe(2);
  });

  it('skips local status, remotes, and remote resolution when the directory disappeared', async () => {
    const getStatus = vi.fn();
    const getRemotes = vi.fn();
    const resolveRepo = vi.fn();
    const octokit = { rest: { repos: { get: vi.fn() }, pulls: { list: vi.fn() } } };

    const result = await resolveGitHubPrStatus(
      { octokit, directory: '/deleted', branch: 'feature', remoteName: 'origin' },
      {
        directoryExists: async () => false,
        getStatus,
        getRemotes,
        resolveRepo,
      },
    );

    expect(result).toEqual({
      repo: null,
      pr: null,
      defaultBranch: null,
      resolvedRemoteName: null,
    });
    expect(getStatus).not.toHaveBeenCalled();
    expect(getRemotes).not.toHaveBeenCalled();
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(octokit.rest.repos.get).not.toHaveBeenCalled();
  });

  it('reuses cached repository metadata for default-branch reads', async () => {
    const repo = { owner: `owner-${Date.now()}`, repo: 'project' };
    const get = vi.fn(async () => ({ data: { default_branch: 'trunk' } }));
    const octokit = { rest: { repos: { get } } };

    await expect(getRepoDefaultBranch(octokit, repo)).resolves.toBe('trunk');
    await expect(getRepoDefaultBranch(octokit, repo)).resolves.toBe('trunk');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
