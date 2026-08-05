import type { ProjectEntry } from '@/lib/api/types';
import { filterBranchNamesByGrantedBranches } from '@/lib/worktrees/managedBranches';

export type VisibleGitBranches = {
  localBranches: string[];
  remoteBranches: string[];
};

export function splitVisibleGitBranches({
  allBranches,
  project,
  restrictToGrantedBranches,
}: {
  allBranches: readonly string[];
  project: ProjectEntry | null;
  restrictToGrantedBranches: boolean;
}): VisibleGitBranches {
  const visibleBranches = restrictToGrantedBranches
    ? (project ? filterBranchNamesByGrantedBranches(allBranches, project) : [])
    : [...allBranches];

  return {
    localBranches: visibleBranches
      .filter((branchName) => !branchName.startsWith('remotes/'))
      .sort(),
    remoteBranches: visibleBranches
      .filter((branchName) => branchName.startsWith('remotes/'))
      .map((branchName) => branchName.replace(/^remotes\//, ''))
      .sort(),
  };
}
