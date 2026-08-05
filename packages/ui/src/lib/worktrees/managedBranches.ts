import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';

export const normalizeManagedBranchName = (value: string): string => value
  .trim()
  .replace(/^refs\/heads\//, '')
  .replace(/^heads\//, '')
  .replace(/^refs\/remotes\/[^/]+\//, '')
  .replace(/^remotes\/[^/]+\//, '');

const normalizePath = (value: string): string => value.replace(/[\\/]+$/, '');

const grantedBranchNames = (project: ProjectEntry): Set<string> => new Set(
  (project.branches || [])
    .map((branch) => normalizeManagedBranchName(typeof branch?.name === 'string' ? branch.name : ''))
    .filter(Boolean),
);

export const isManagedBranchGranted = (
  project: ProjectEntry,
  branch: string | null | undefined,
): boolean => {
  const normalizedBranch = normalizeManagedBranchName(branch || '');
  return Boolean(normalizedBranch && grantedBranchNames(project).has(normalizedBranch));
};

export const filterBranchNamesByGrantedBranches = (
  branches: readonly string[],
  project: ProjectEntry,
): string[] => {
  const grantedBranches = grantedBranchNames(project);
  return branches.filter((branch) => grantedBranches.has(normalizeManagedBranchName(branch)));
};

export const filterWorktreesByGrantedBranches = (
  worktrees: readonly WorktreeMetadata[],
  project: ProjectEntry,
  visibleDirectories: Iterable<string> = [],
): WorktreeMetadata[] => {
  const grantedBranches = grantedBranchNames(project);
  const visiblePaths = new Set(Array.from(visibleDirectories, normalizePath));
  const projectRoot = normalizePath(project.path);

  return worktrees.filter((worktree) => (
    grantedBranches.has(normalizeManagedBranchName(worktree.branch || ''))
    || (
      normalizePath(worktree.path) !== projectRoot
      && visiblePaths.has(normalizePath(worktree.path))
    )
  ));
};
