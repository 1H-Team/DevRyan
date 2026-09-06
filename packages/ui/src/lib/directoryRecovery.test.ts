import { describe, expect, test } from 'bun:test';
import {
  recoverMissingActiveDirectory,
  type DirectoryRecoveryDependencies,
} from './directoryRecovery';

type HarnessOverrides = Partial<DirectoryRecoveryDependencies>;

const createHarness = (overrides: HarnessOverrides = {}) => {
  let currentDirectory = '/projects/app/.worktrees/feature';
  const commits: Array<[string, string]> = [];
  const disposed: string[] = [];
  const invalidated: string[] = [];
  const probeResults = new Map<string, 'unknown' | 'exists' | 'missing'>([
    ['/projects/app/.worktrees/feature', 'missing'],
    ['/projects/app', 'exists'],
    ['/home/dev', 'exists'],
  ]);
  const dependencies: DirectoryRecoveryDependencies = {
    isManaged: () => false,

    getCurrentDirectory: () => currentDirectory,
    getHomeDirectory: () => '/home/dev',
    getProjects: () => [{
      id: 'app',
      path: '/projects/app',
      branches: [{ directory: '/projects/app/.worktrees/feature', name: 'feature' }],
    }],
    getActiveProjectId: () => 'app',
    getRegisteredWorktrees: () => new Map([
      ['/projects/app', [{ path: '/projects/app/.worktrees/feature' }]],
    ]),
    probe: async (directory) => probeResults.get(directory) ?? 'missing',
    commit: (missing, fallback) => {
      if (currentDirectory !== missing) return false;
      commits.push([missing, fallback]);
      currentDirectory = fallback;
      return true;
    },
    disposeDirectory: (directory) => disposed.push(directory),
    invalidateLocalDirectory: (directory) => invalidated.push(directory),
    ...overrides,
  };
  return { dependencies, commits, disposed, invalidated, probeResults, getCurrent: () => currentDirectory };
};

describe('deleted active-directory recovery', () => {
  test('selects the owning root and clears both cache layers once', async () => {
    const harness = createHarness();
    const result = await recoverMissingActiveDirectory(
      '/projects/app/.worktrees/feature/',
      harness.dependencies,
    );
    expect(result).toEqual({ recovered: true, fallback: '/projects/app' });
    expect(harness.commits).toEqual([['/projects/app/.worktrees/feature', '/projects/app']]);
    expect(harness.disposed).toEqual(['/projects/app/.worktrees/feature']);
    expect(harness.invalidated).toEqual(['/projects/app/.worktrees/feature']);
    expect(harness.getCurrent()).toBe('/projects/app');
  });

  test('does nothing for an inactive deletion', async () => {
    const harness = createHarness({ getCurrentDirectory: () => '/projects/other' });
    expect(await recoverMissingActiveDirectory('/projects/app/.worktrees/feature', harness.dependencies))
      .toEqual({ recovered: false, reason: 'inactive' });
    expect(harness.commits).toHaveLength(0);
  });

  test('preserves the active directory for transient failures', async () => {
    const harness = createHarness({ probe: async () => 'unknown' });
    expect(await recoverMissingActiveDirectory('/projects/app/.worktrees/feature', harness.dependencies))
      .toEqual({ recovered: false, reason: 'unknown' });
    expect(harness.commits).toHaveLength(0);
  });

  test('never replaces managed paths', async () => {
    const managed = createHarness({ isManaged: () => true });
    expect((await recoverMissingActiveDirectory('/projects/app/.worktrees/feature', managed.dependencies)).reason).toBe('managed');
    expect(managed.commits).toHaveLength(0);
  });

  test('falls back to runtime home when no registered root remains', async () => {
    const harness = createHarness({
      getProjects: () => [],
      getActiveProjectId: () => null,
      getRegisteredWorktrees: () => new Map(),
    });
    const result = await recoverMissingActiveDirectory('/projects/app/.worktrees/feature', harness.dependencies);
    expect(result).toEqual({ recovered: true, fallback: '/home/dev' });
  });

  test('aborts instead of skipping an unknown fallback candidate', async () => {
    const harness = createHarness();
    harness.probeResults.set('/projects/app', 'unknown');
    const result = await recoverMissingActiveDirectory('/projects/app/.worktrees/feature', harness.dependencies);
    expect(result).toEqual({ recovered: false, reason: 'unknown' });
    expect(harness.commits).toHaveLength(0);
  });
});
