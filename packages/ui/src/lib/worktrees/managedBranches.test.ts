import { describe, expect, test } from 'bun:test';

import type { WorktreeMetadata } from '@/types/worktree';
import {
  filterBranchNamesByGrantedBranches,
  filterWorktreesByGrantedBranches,
  isManagedBranchGranted,
} from './managedBranches';

const worktree = (branch: string, path: string): WorktreeMetadata => ({
  source: 'sdk',
  path,
  projectDirectory: '/repo',
  branch,
  label: branch || 'detached',
});

describe('filterWorktreesByGrantedBranches', () => {
  test('keeps real worktrees whose checked-out branches are granted', () => {
    const feature = worktree('feature', '/worktrees/feature');
    const worktrees = filterWorktreesByGrantedBranches([
      worktree('main', '/worktrees/main'),
      feature,
      worktree('private', '/worktrees/private'),
    ], {
      id: 'project-1',
      path: '/repo',
      branches: [
        { name: 'main', directory: '/repo', isDefault: true },
        { name: 'feature', directory: '/repo' },
      ],
    });
    expect(worktrees.map((entry) => entry.branch)).toEqual(['main', 'feature']);
    expect(worktrees[1]).toBe(feature);
  });

  test('normalizes refs and hides detached or ungranted worktrees', () => {
    expect(filterWorktreesByGrantedBranches([
      worktree('refs/heads/feature', '/worktrees/feature'),
      worktree('', '/worktrees/detached'),
      worktree('other', '/worktrees/other'),
    ], {
      id: 'project-1',
      path: '/repo',
      branches: [
        { name: 'feature', directory: '/repo' },
      ],
    }).map((entry) => entry.path)).toEqual(['/worktrees/feature']);
  });

  test('treats same-name remote refs as one grant and retains owned chat worktrees', () => {
    expect(filterWorktreesByGrantedBranches([
      worktree('refs/heads/dev', '/worktrees/dev'),
      worktree('generated/multi-run-1', '/worktrees/generated'),
      worktree('private', '/worktrees/private'),
    ], {
      id: 'project-1',
      path: '/repo',
      branches: [
        { name: 'remotes/origin/dev', directory: '/repo', isDefault: true },
      ],
    }, ['/worktrees/generated/']).map((entry) => entry.path)).toEqual([
      '/worktrees/dev',
      '/worktrees/generated',
    ]);
  });

  test('does not retain an ungranted project root just because a historical session references it', () => {
    expect(filterWorktreesByGrantedBranches([
      worktree('main', '/repo'),
      worktree('Dev', '/worktrees/Dev'),
    ], {
      id: 'project-1',
      path: '/repo',
      branches: [{ name: 'Dev', directory: '/repo', isDefault: true }],
    }, ['/repo']).map((entry) => entry.path)).toEqual(['/worktrees/Dev']);
  });
});

describe('filterBranchNamesByGrantedBranches', () => {
  test('hides ungranted local branch choices for managed developers', () => {
    expect(filterBranchNamesByGrantedBranches([
      'feature/hidden',
      'feature/visible',
      'main',
    ], {
      id: 'project-1',
      path: '/repo',
      branches: [
        { name: 'main', directory: '/repo', isDefault: true },
        { name: 'refs/heads/feature/visible', directory: '/repo' },
      ],
    })).toEqual(['feature/visible', 'main']);
  });


  test('matches local and remote spellings of the same logical branch', () => {
    expect(filterBranchNamesByGrantedBranches([
      'refs/heads/dev',
      'remotes/upstream/dev',
      'main',
    ], {
      id: 'project-1',
      path: '/repo',
      branches: [
        { name: 'refs/remotes/origin/dev', directory: '/repo', isDefault: true },
      ],
    })).toEqual(['refs/heads/dev', 'remotes/upstream/dev']);
  });
});

describe('isManagedBranchGranted', () => {
  test('matches local and remote spellings without granting another branch', () => {
    const project = {
      id: 'project-1',
      path: '/repo',
      branches: [{ name: 'remotes/origin/Dev', directory: '/repo', isDefault: true }],
    };

    expect(isManagedBranchGranted(project, 'refs/heads/Dev')).toBe(true);
    expect(isManagedBranchGranted(project, 'main')).toBe(false);
  });
});
