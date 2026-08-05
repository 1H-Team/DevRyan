import { describe, expect, test } from 'bun:test';
import { filterWorktreesByGrantedBranches } from '@/lib/worktrees/managedBranches';
import { resolveSessionGroupDirectoryKey } from './utils';

const archivedKey = '__archived__';
const projectRoot = '/Users/example/Repositories/DevRyan';
const worktreePath = '/Users/example/.config/openchamber/worktrees/p1/u-1/feature';

describe('resolveSessionGroupDirectoryKey', () => {
  test('routes project-root sessions to the root group', () => {
    const key = resolveSessionGroupDirectoryKey(projectRoot, projectRoot, () => true, archivedKey);
    expect(key).toBe(projectRoot);
  });

  test('project root wins even when a worktree entry aliases it', () => {
    // Regression: a leaked primary-checkout entry must not steal main sessions.
    const key = resolveSessionGroupDirectoryKey(
      projectRoot,
      projectRoot,
      (directory) => directory === projectRoot,
      archivedKey,
    );
    expect(key).toBe(projectRoot);
  });

  test('routes known worktree directories to their branch group', () => {
    const key = resolveSessionGroupDirectoryKey(
      worktreePath,
      projectRoot,
      (directory) => directory === worktreePath,
      archivedKey,
    );
    expect(key).toBe(worktreePath);
  });

  test('falls back to the root group for unknown directories instead of Archived', () => {
    const key = resolveSessionGroupDirectoryKey('/somewhere/else', projectRoot, () => false, archivedKey);
    expect(key).toBe(projectRoot);
  });

  test('returns the archived key only when there is no directory at all', () => {
    expect(resolveSessionGroupDirectoryKey(null, projectRoot, () => false, archivedKey)).toBe(archivedKey);
  });

  test('uses the placeholder root key when the project root is unknown', () => {
    expect(resolveSessionGroupDirectoryKey('/somewhere/else', null, () => false, archivedKey)).toBe('__project_root__');
  });

  test('buckets a granted real worktree session under its project', () => {
    const managedRoot = '/Users/example/Repositories/DevRyan';
    const featureDirectory = '/Users/example/.local/share/opencode/worktree/project-1/feature';
    const worktrees = filterWorktreesByGrantedBranches([{
      source: 'sdk',
      path: featureDirectory,
      projectDirectory: managedRoot,
      branch: 'feature',
      label: 'feature',
    }], {
      id: 'project-1',
      path: managedRoot,
      branches: [
        { name: 'main', directory: managedRoot, isDefault: true },
        { name: 'feature', directory: managedRoot, isDefault: false },
      ],
    });
    const matchesWorktree = (directory: string) => worktrees.some((entry) => entry.path === directory);

    expect(worktrees).toHaveLength(1);
    expect(resolveSessionGroupDirectoryKey(managedRoot, managedRoot, matchesWorktree, archivedKey)).toBe(managedRoot);
    expect(resolveSessionGroupDirectoryKey(featureDirectory, managedRoot, matchesWorktree, archivedKey)).toBe(featureDirectory);
  });
});
