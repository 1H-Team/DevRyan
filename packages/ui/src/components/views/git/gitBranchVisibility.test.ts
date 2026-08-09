import { describe, expect, test } from 'bun:test';

import { resolveIntegrateBranchChoices, splitVisibleGitBranches } from './gitBranchVisibility';

const assignedProject = {
  id: 'project-1',
  path: '/repo',
  branches: [{ name: 'Dev', directory: '/repo', isDefault: true }],
};

describe('splitVisibleGitBranches', () => {
  test('shows only the assigned local and remote branch to a managed developer', () => {
    expect(splitVisibleGitBranches({
      allBranches: ['main', 'Dev', 'remotes/origin/main', 'remotes/origin/Dev'],
      project: assignedProject,
      restrictToGrantedBranches: true,
    })).toEqual({
      localBranches: ['Dev'],
      remoteBranches: ['origin/Dev'],
    });
  });

  test('fails closed when a restricted directory cannot be resolved to a project', () => {
    expect(splitVisibleGitBranches({
      allBranches: ['main', 'Dev', 'remotes/origin/Dev'],
      project: null,
      restrictToGrantedBranches: true,
    })).toEqual({ localBranches: [], remoteBranches: [] });
  });

  test('preserves the full branch list outside managed developer scope', () => {
    expect(splitVisibleGitBranches({
      allBranches: ['main', 'Dev', 'remotes/origin/main', 'remotes/origin/Dev'],
      project: null,
      restrictToGrantedBranches: false,
    })).toEqual({
      localBranches: ['Dev', 'main'],
      remoteBranches: ['origin/Dev', 'origin/main'],
    });
  });
});

describe('resolveIntegrateBranchChoices', () => {
  test('removes an unassigned default target and the current branch for managed developers', () => {
    expect(resolveIntegrateBranchChoices({
      localBranches: ['Dev'],
      sourceBranch: 'Dev',
      defaultTargetBranch: 'main',
      restrictToGrantedBranches: true,
    })).toEqual({ targetBranches: [], defaultTargetBranch: '' });
  });

  test('allows a managed scratch branch to move commits into its assigned base', () => {
    expect(resolveIntegrateBranchChoices({
      localBranches: ['Dev'],
      sourceBranch: 'openchamber/task-1',
      defaultTargetBranch: 'Dev',
      restrictToGrantedBranches: true,
    })).toEqual({ targetBranches: ['Dev'], defaultTargetBranch: 'Dev' });
  });

  test('preserves an unrestricted metadata target', () => {
    expect(resolveIntegrateBranchChoices({
      localBranches: ['feature'],
      sourceBranch: 'feature',
      defaultTargetBranch: 'main',
      restrictToGrantedBranches: false,
    })).toEqual({ targetBranches: ['main'], defaultTargetBranch: 'main' });
  });
});
