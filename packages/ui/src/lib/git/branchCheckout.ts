import type { GitAPI, GitStatus } from '@/lib/api/types';
import type { SessionWorktreeAttachment } from '@/stores/types/sessionTypes';
import {
  getMutationBlockingReasons,
  type MutationBlockingReason,
} from '@/sync/session-worktree-contract';

export type BranchCheckoutResult =
  | { type: 'already-current'; branch: string }
  | { type: 'blocked'; branch: string; reason: string }
  | { type: 'needs-stash'; branch: string; dirtyFiles?: number }
  | { type: 'checked-out'; branch: string; stashed: boolean; restored: boolean }
  | { type: 'restore-failed'; branch: string; error: unknown };

export type BranchCheckoutOptions = {
  git: GitAPI;
  directory: string;
  branch: string;
  status?: GitStatus | null;
  attachment?: SessionWorktreeAttachment | null;
  stashConfirmed?: boolean;
  restoreAfter?: boolean;
};

export type FinishBranchIntoMainResult =
  | { type: 'blocked'; reason: string }
  | { type: 'merged'; sourceBranch: string; targetBranch: 'main'; stashed: boolean; restored: boolean }
  | { type: 'conflict'; sourceBranch: string; targetBranch: 'main'; conflictFiles?: string[]; stashed: boolean }
  | { type: 'delete-failed'; sourceBranch: string; targetBranch: 'main'; error: unknown; stashed: boolean }
  | { type: 'restore-failed'; sourceBranch: string; targetBranch: 'main'; error: unknown; stashed: boolean };

export type FinishBranchIntoMainOptions = {
  git: GitAPI;
  directory: string;
  restoreAfter?: boolean;
};

export function normalizeCheckoutBranchName(branch: string): string {
  return branch.trim().replace(/^remotes\//, '');
}

export function formatMutationBlockingReason(reason: MutationBlockingReason): string {
  if (reason.reason === 'attention') {
    return `${reason.attentionReason} in progress`;
  }
  if (reason.reason === 'missing') {
    return 'worktree is missing';
  }
  if (reason.reason === 'dirty') {
    if (typeof reason.dirtyFiles === 'number') {
      return `${reason.dirtyFiles} changed ${reason.dirtyFiles === 1 ? 'file' : 'files'}`;
    }
    return 'worktree has uncommitted changes';
  }
  return 'worktree is invalid';
}

export async function checkoutBranchWithOptionalStash({
  git,
  directory,
  branch,
  status,
  attachment,
  stashConfirmed = false,
  restoreAfter = false,
}: BranchCheckoutOptions): Promise<BranchCheckoutResult> {
  const normalized = normalizeCheckoutBranchName(branch);

  if (!normalized) {
    return { type: 'blocked', branch: normalized, reason: 'branch is required' };
  }

  if (status?.current === normalized) {
    return { type: 'already-current', branch: normalized };
  }

  const blockingReasons = getMutationBlockingReasons(attachment, status ?? undefined);
  const nonDirtyReason = blockingReasons.find((reason) => reason.reason !== 'dirty');
  if (nonDirtyReason) {
    return { type: 'blocked', branch: normalized, reason: formatMutationBlockingReason(nonDirtyReason) };
  }

  const dirtyReason = blockingReasons.find((reason) => reason.reason === 'dirty');
  if (dirtyReason && !stashConfirmed) {
    return { type: 'needs-stash', branch: normalized, dirtyFiles: dirtyReason.dirtyFiles };
  }

  const shouldStash = Boolean(dirtyReason && stashConfirmed);

  if (shouldStash) {
    await git.stash(directory, {
      message: `Auto-stash before checkout ${normalized}`,
      includeUntracked: true,
    });
  }

  await git.checkoutBranch(directory, normalized);

  if (shouldStash && restoreAfter) {
    try {
      await git.stashPop(directory);
    } catch (error) {
      return { type: 'restore-failed', branch: normalized, error };
    }
  }

  return {
    type: 'checked-out',
    branch: normalized,
    stashed: shouldStash,
    restored: shouldStash && restoreAfter,
  };
}

export async function finishCurrentBranchIntoMainWithOptionalStash({
  git,
  directory,
  restoreAfter = false,
}: FinishBranchIntoMainOptions): Promise<FinishBranchIntoMainResult> {
  const [status, branches] = await Promise.all([
    git.getGitStatus(directory),
    git.getGitBranches(directory),
  ]);

  const sourceBranch = status.current?.trim();
  if (!sourceBranch || sourceBranch === 'HEAD') {
    return { type: 'blocked', reason: 'current branch is required' };
  }

  if (sourceBranch === 'main') {
    return { type: 'blocked', reason: 'already on main' };
  }

  if (!branches.all.some((branch) => branch === 'main')) {
    return { type: 'blocked', reason: 'local main branch is required' };
  }

  const shouldStash = status.isClean === false || (status.files?.length ?? 0) > 0;

  if (shouldStash) {
    await git.stash(directory, {
      message: `Auto-stash before merging ${sourceBranch} into main`,
      includeUntracked: true,
    });
  }

  await git.checkoutBranch(directory, 'main');

  const mergeResult = await git.merge(directory, { branch: sourceBranch });
  if (mergeResult.conflict) {
    return {
      type: 'conflict',
      sourceBranch,
      targetBranch: 'main',
      conflictFiles: mergeResult.conflictFiles,
      stashed: shouldStash,
    };
  }

  if (!mergeResult.success) {
    throw new Error('Merge failed');
  }

  try {
    await git.deleteGitBranch(directory, { branch: sourceBranch, force: false });
  } catch (error) {
    return {
      type: 'delete-failed',
      sourceBranch,
      targetBranch: 'main',
      error,
      stashed: shouldStash,
    };
  }

  if (shouldStash && restoreAfter) {
    try {
      await git.stashPop(directory);
    } catch (error) {
      return {
        type: 'restore-failed',
        sourceBranch,
        targetBranch: 'main',
        error,
        stashed: shouldStash,
      };
    }
  }

  return {
    type: 'merged',
    sourceBranch,
    targetBranch: 'main',
    stashed: shouldStash,
    restored: shouldStash && restoreAfter,
  };
}
