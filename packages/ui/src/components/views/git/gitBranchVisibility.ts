import type { ProjectEntry } from '@/lib/api/types';
import {
  filterBranchNamesByGrantedBranches,
  normalizeManagedBranchName,
} from '@/lib/worktrees/managedBranches';

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

export function resolveIntegrateBranchChoices({
  localBranches,
  sourceBranch,
  defaultTargetBranch,
  restrictToGrantedBranches,
}: {
  localBranches: readonly string[];
  sourceBranch: string | null;
  defaultTargetBranch: string;
  restrictToGrantedBranches: boolean;
}): { targetBranches: string[]; defaultTargetBranch: string } {
  const source = normalizeManagedBranchName(sourceBranch || '');
  const targets = localBranches.filter((branch) => (
    normalizeManagedBranchName(branch) !== source
  ));
  const defaultTarget = normalizeManagedBranchName(defaultTargetBranch);
  const matchingTarget = targets.find((branch) => (
    normalizeManagedBranchName(branch) === defaultTarget
  ));

  if (!restrictToGrantedBranches) {
    const unrestrictedTargets = [...targets];
    if (defaultTarget && defaultTarget !== 'HEAD' && defaultTarget !== source && !matchingTarget) {
      unrestrictedTargets.push(defaultTargetBranch);
    }
    return {
      targetBranches: unrestrictedTargets,
      defaultTargetBranch: matchingTarget || defaultTargetBranch,
    };
  }

  return {
    targetBranches: targets,
    defaultTargetBranch: matchingTarget || '',
  };
}
