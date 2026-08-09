import type { GitHubChecksSummary, GitHubPullRequestSummary } from '@/lib/api/types';

export type PullRequestPanelView = 'current' | 'list' | 'selected';
export type PullRequestPanelEvent = 'show-current' | 'show-list' | 'show-selected';

export type NextPullRequestDraft = {
  title: string;
  body: string;
  draft: boolean;
  additionalContext: string;
  terminalPrNumber: number;
};

export const createNextPullRequestDraft = (
  branch: string,
  terminalPrNumber: number,
  branchTitle: (branchName: string) => string,
): NextPullRequestDraft => ({
  title: branchTitle(branch),
  body: '',
  draft: false,
  additionalContext: '',
  terminalPrNumber,
});

export const shouldClearNextPullRequestDraft = (
  terminalPrNumber: number | null,
  currentPrState: string | null | undefined,
): boolean => terminalPrNumber !== null && currentPrState === 'open';

export const shouldShowPullRequestDetails = (
  currentPrState: string | null | undefined,
): boolean => currentPrState === 'open';

export const formatPullRequestStatus = (status: string): string => status
  .replace(/\b\w/g, (character) => character.toUpperCase());

export const shouldShowPullRequestChecks = (
  checks: GitHubChecksSummary | null | undefined,
): checks is GitHubChecksSummary => Boolean(
  checks && checks.total > 0 && checks.state !== 'unknown',
);

export const nextPullRequestPanelView = (
  _current: PullRequestPanelView,
  event: PullRequestPanelEvent,
): PullRequestPanelView => {
  switch (event) {
    case 'show-current':
      return 'current';
    case 'show-selected':
      return 'selected';
    case 'show-list':
      return 'list';
  }
};

export const isCurrentPullRequestSelection = (
  currentNumber: number | null,
  currentRepo: { owner: string; repo: string } | null,
  selected: GitHubPullRequestSummary,
): boolean => {
  if (currentNumber !== selected.number) {
    return false;
  }
  if (!selected.sourceRepo) {
    return true;
  }
  if (!currentRepo) {
    return false;
  }
  return currentRepo.owner === selected.sourceRepo.owner
    && currentRepo.repo === selected.sourceRepo.repo;
};
