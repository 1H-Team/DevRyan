import { describe, expect, test } from 'bun:test';

import type { ProjectEntry } from '@/lib/api/types';
import type { AuthAssignment, AuthPrincipal } from '@/lib/authSession';
import { resolveScheduledTaskBranchOptions } from './scheduledTaskBranchOptions';

const assignment = (
  overrides: Partial<AuthAssignment> & Pick<AuthAssignment, 'projectId' | 'branchName'>,
): AuthAssignment => ({
  label: 'Assigned project',
  publicDirectory: `/projects/${overrides.projectId}/${overrides.branchName}`,
  githubAccountId: null,
  isDefault: false,
  ...overrides,
});

const principal = (overrides: Partial<AuthPrincipal> = {}): AuthPrincipal => ({
  id: 'user-1',
  email: 'user@example.com',
  displayName: 'User',
  role: 'admin',
  scope: 'managed',
  policy: {
    settingsPages: ['*'],
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
  assignments: [],
  ...overrides,
});

const project = (branches: ProjectEntry['branches'] = []): ProjectEntry => ({
  id: 'project-1',
  path: '/projects/project-1',
  branches,
});

describe('scheduled task branch options', () => {
  test('uses a managed administrator personal assignments for a new task', () => {
    const options = resolveScheduledTaskBranchOptions({
      principal: principal({
        assignments: [
          assignment({ projectId: 'project-1', branchName: 'feature' }),
          assignment({ projectId: 'project-2', branchName: 'unrelated', isDefault: true }),
          assignment({ projectId: 'project-1', branchName: 'main', isDefault: true }),
          assignment({ projectId: 'project-1', branchName: 'feature' }),
        ],
      }),
      project: project([{ name: 'stale', directory: '/repo', isDefault: true }]),
      task: null,
    });

    expect(options).toEqual([
      { name: 'feature', directory: '/projects/project-1/feature', isDefault: false },
      { name: 'main', directory: '/projects/project-1/main', isDefault: true },
    ]);
    expect(options.find((branch) => branch.isDefault)?.name).toBe('main');
  });

  test('keeps managed developer personal-task behavior', () => {
    const options = resolveScheduledTaskBranchOptions({
      principal: principal({
        role: 'developer',
        assignments: [assignment({ projectId: 'project-1', branchName: 'dev', isDefault: true })],
      }),
      project: project([{ name: 'stale', directory: '/repo' }]),
      task: { ownerUserId: 'user-1' },
    });

    expect(options).toEqual([
      { name: 'dev', directory: '/projects/project-1/dev', isDefault: true },
    ]);
  });

  test('uses project branches for local administrators', () => {
    const branches = [{ name: 'main', directory: '/repo', isDefault: true }];
    const options = resolveScheduledTaskBranchOptions({
      principal: principal({ scope: 'local-admin', assignments: [] }),
      project: project(branches),
      task: null,
    });

    expect(options).toEqual(branches);
  });

  test('uses project branches when a managed administrator edits another or legacy task', () => {
    const branches = [{ name: 'release', directory: '/repo', isDefault: true }];
    const admin = principal({
      assignments: [assignment({ projectId: 'project-1', branchName: 'personal', isDefault: true })],
    });

    expect(resolveScheduledTaskBranchOptions({
      principal: admin,
      project: project(branches),
      task: { ownerUserId: 'user-2' },
    })).toEqual(branches);
    expect(resolveScheduledTaskBranchOptions({
      principal: admin,
      project: project(branches),
      task: {},
    })).toEqual(branches);
  });
});
