import { describe, expect, test } from 'bun:test';

import { splitVisibleGitBranches } from './gitBranchVisibility';

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
