import type { GitLogEntry } from '@/lib/api/types';

export type HistoryCommitIndicator = {
  dotColor: string;
  ringColor: string | null;
  hasHeadRing: boolean;
  hasPushedFill: boolean;
  ariaLabelKey:
    | 'gitView.history.commitStatus.latestLocalCommit'
    | 'gitView.history.commitStatus.latestPushedCommit'
    | 'gitView.history.commitStatus.localAndPushedCommit'
     | 'gitView.history.commitStatus.olderCommit';
};

export type HistoryCommitBadge = {
  key: 'local' | 'remote';
  label: string;
  ariaLabelKey: 'gitView.history.commitBadge.localTip' | 'gitView.history.commitBadge.remoteTip';
};

export function resolveHistoryCommitIndicator(entry: GitLogEntry): HistoryCommitIndicator {
  const successColor = 'var(--status-success)';
  const neutralColor = 'var(--surface-muted-foreground)';
  const hasHeadRing = !!entry.isHead;
  const hasPushedFill = !!entry.isRemoteHead;

  if (hasHeadRing && hasPushedFill) {
    return {
      dotColor: successColor,
      ringColor: successColor,
      hasHeadRing,
      hasPushedFill,
      ariaLabelKey: 'gitView.history.commitStatus.localAndPushedCommit',
    };
  }

  if (hasHeadRing) {
    return {
      dotColor: neutralColor,
      ringColor: successColor,
      hasHeadRing,
      hasPushedFill,
      ariaLabelKey: 'gitView.history.commitStatus.latestLocalCommit',
    };
  }

  if (hasPushedFill) {
    return {
      dotColor: successColor,
      ringColor: null,
      hasHeadRing,
      hasPushedFill,
      ariaLabelKey: 'gitView.history.commitStatus.latestPushedCommit',
    };
  }

  return {
    dotColor: neutralColor,
    ringColor: null,
    hasHeadRing,
    hasPushedFill,
    ariaLabelKey: 'gitView.history.commitStatus.olderCommit',
  };
}

export function resolveHistoryCommitBadges(
  entry: GitLogEntry,
  options: { currentBranch?: string | null; trackingBranch?: string | null } = {}
): HistoryCommitBadge[] {
  const badges: HistoryCommitBadge[] = [];
  const currentBranch = options.currentBranch?.trim();
  const trackingBranch = options.trackingBranch?.trim();

  if (entry.isHead && currentBranch) {
    badges.push({
      key: 'local',
      label: currentBranch,
      ariaLabelKey: 'gitView.history.commitBadge.localTip',
    });
  }

  if (entry.isRemoteHead && trackingBranch) {
    badges.push({
      key: 'remote',
      label: trackingBranch,
      ariaLabelKey: 'gitView.history.commitBadge.remoteTip',
    });
  }

  return badges;
}
