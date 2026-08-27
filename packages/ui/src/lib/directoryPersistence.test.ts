import { describe, expect, test } from 'bun:test';

import type { AuthPrincipal } from '@/lib/authSession';
import { resolvePersistedDirectoryForPrincipal } from './directoryPersistence';

const createManagedPrincipal = (
  assignments: AuthPrincipal['assignments'],
): AuthPrincipal => ({
  id: 'user-1',
  email: 'user@example.com',
  displayName: 'Managed User',
  role: 'developer',
  scope: 'managed',
  policy: {
    settingsPages: ['*'],
    bots: true,
    files: true,
    terminal: true,
    browser: true,
    createWorktrees: true,
    createBranches: true,
    manageProjects: true,
    manageUsers: true,
    manageGlobalSettings: true,
    manageGit: true,
    push: true,
    github: true,
  },
  assignments,
});

const assignment = (
  publicDirectory: string,
  isDefault = false,
): AuthPrincipal['assignments'][number] => ({
  projectId: publicDirectory.split('/')[2] || 'project-1',
  label: 'Project',
  branchName: 'main',
  publicDirectory,
  githubAccountId: null,
  isDefault,
});

describe('resolvePersistedDirectoryForPrincipal', () => {
  test('preserves existing behavior without a managed principal', () => {
    expect(resolvePersistedDirectoryForPrincipal('/Users/example/project')).toBe('/Users/example/project');
  });

  test('preserves host-wide directories for managed administrators', () => {
    const principal = createManagedPrincipal([assignment('/projects/project-1/main', true)]);
    principal.role = 'admin';

    expect(resolvePersistedDirectoryForPrincipal('/Users/example/another-project', principal))
      .toBe('/Users/example/another-project');
  });

  test('keeps an assigned public directory and its descendants', () => {
    const principal = createManagedPrincipal([assignment('/projects/project-1/main', true)]);

    expect(resolvePersistedDirectoryForPrincipal('/projects/project-1/main', principal))
      .toBe('/projects/project-1/main');
    expect(resolvePersistedDirectoryForPrincipal('/projects/project-1/main/packages/ui/', principal))
      .toBe('/projects/project-1/main/packages/ui');
  });

  test('replaces stale host paths and sibling-prefix paths with the default assignment', () => {
    const principal = createManagedPrincipal([
      assignment('/projects/project-1/develop'),
      assignment('/projects/project-1/main', true),
    ]);

    expect(resolvePersistedDirectoryForPrincipal('/Users/example/project', principal))
      .toBe('/projects/project-1/main');
    expect(resolvePersistedDirectoryForPrincipal('/projects/project-1/main-copy', principal))
      .toBe('/projects/project-1/main');
  });

  test('normalizes traversal before checking assignment containment', () => {
    const principal = createManagedPrincipal([
      assignment('/projects/project-1/main', true),
      assignment('/projects/project-2/main'),
    ]);

    expect(resolvePersistedDirectoryForPrincipal(
      '/projects/project-1/main/../../../project-2/main',
      principal,
    )).toBe('/projects/project-1/main');
  });

  test('uses the first assignment when no assignment is marked default', () => {
    const principal = createManagedPrincipal([
      assignment('/projects/project-1/develop'),
      assignment('/projects/project-1/main'),
    ]);

    expect(resolvePersistedDirectoryForPrincipal(null, principal))
      .toBe('/projects/project-1/develop');
  });

  test('returns null when a managed principal has no assignments', () => {
    expect(resolvePersistedDirectoryForPrincipal(
      '/Users/example/project',
      createManagedPrincipal([]),
    )).toBeNull();
  });
});
