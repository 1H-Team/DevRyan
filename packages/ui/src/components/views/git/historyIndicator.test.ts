import { describe, expect, test } from 'bun:test';
import { resolveHistoryCommitBadges, resolveHistoryCommitIndicator } from './historyIndicator';
import type { GitLogEntry } from '@/lib/api/types';

const createEntry = (overrides: Partial<GitLogEntry>): GitLogEntry => ({
  hash: 'abc123',
  date: '2026-05-15T12:00:00.000Z',
  message: 'Test commit',
  refs: '',
  body: '',
  author_name: 'Dev Ryan',
  author_email: 'dev@example.com',
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  ...overrides,
});

describe('resolveHistoryCommitIndicator', () => {
  test('shows the outer ring on local HEAD when it is ahead of the pushed branch', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({ isHead: true, isRemoteHead: false }));

    expect(indicator.hasHeadRing).toBe(true);
    expect(indicator.hasPushedFill).toBe(false);
    expect(indicator.dotColor).toBe('var(--surface-muted-foreground)');
    expect(indicator.ringColor).toBe('var(--status-success)');
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.latestLocalCommit');
  });

  test('fills the latest pushed commit when local HEAD is ahead', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({ isHead: false, isRemoteHead: true, isSyncPoint: true }));

    expect(indicator.hasHeadRing).toBe(false);
    expect(indicator.hasPushedFill).toBe(true);
    expect(indicator.dotColor).toBe('var(--status-success)');
    expect(indicator.ringColor).toBeNull();
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.latestPushedCommit');
  });

  test('shows both markers when local HEAD is already pushed', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({ isHead: true, isRemoteHead: true }));

    expect(indicator.hasHeadRing).toBe(true);
    expect(indicator.hasPushedFill).toBe(true);
    expect(indicator.dotColor).toBe('var(--status-success)');
    expect(indicator.ringColor).toBe('var(--status-success)');
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.localAndPushedCommit');
  });

  test('keeps older commits neutral', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({ isHead: false, isRemoteHead: false }));

    expect(indicator.hasHeadRing).toBe(false);
    expect(indicator.hasPushedFill).toBe(false);
    expect(indicator.dotColor).toBe('var(--surface-muted-foreground)');
    expect(indicator.ringColor).toBeNull();
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.olderCommit');
  });

  test('keeps local HEAD gray with a green ring when origin is ahead', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({
      isHead: true,
      isRemoteHead: false,
      isSyncPoint: true,
      syncStatus: 'remote',
    }));

    expect(indicator.dotColor).toBe('var(--surface-muted-foreground)');
    expect(indicator.ringColor).toBe('var(--status-success)');
    expect(indicator.hasHeadRing).toBe(true);
    expect(indicator.hasPushedFill).toBe(false);
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.latestLocalCommit');
  });

  test('fills the remote tip when origin is ahead without adding a ring', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({
      isHead: false,
      isRemoteHead: true,
      isSyncPoint: false,
    }));

    expect(indicator.dotColor).toBe('var(--status-success)');
    expect(indicator.ringColor).toBeNull();
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.latestPushedCommit');
  });

  test('keeps a shared ancestor separate from both tips neutral', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({
      isHead: false,
      isRemoteHead: false,
      isSyncPoint: true,
    }));

    expect(indicator.dotColor).toBe('var(--surface-muted-foreground)');
    expect(indicator.ringColor).toBeNull();
    expect(indicator.hasPushedFill).toBe(false);
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.olderCommit');
  });

  test('keeps local HEAD gray with a green ring without upstream metadata', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({ isHead: true }));

    expect(indicator.dotColor).toBe('var(--surface-muted-foreground)');
    expect(indicator.ringColor).toBe('var(--status-success)');
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.latestLocalCommit');
  });

  test('does not infer the remote tip from a sync point when tip metadata is missing', () => {
    const indicator = resolveHistoryCommitIndicator(createEntry({ isSyncPoint: true }));

    expect(indicator.dotColor).toBe('var(--surface-muted-foreground)');
    expect(indicator.ringColor).toBeNull();
    expect(indicator.ariaLabelKey).toBe('gitView.history.commitStatus.olderCommit');
  });

  test('labels separate local and remote tips when local is ahead', () => {
    const localBadges = resolveHistoryCommitBadges(
      createEntry({ isHead: true, isRemoteHead: false }),
      { currentBranch: 'main', trackingBranch: 'origin/main' }
    );
    const remoteBadges = resolveHistoryCommitBadges(
      createEntry({ isHead: false, isRemoteHead: true, isSyncPoint: true }),
      { currentBranch: 'main', trackingBranch: 'origin/main' }
    );

    expect(localBadges).toEqual([
      { key: 'local', label: 'main', ariaLabelKey: 'gitView.history.commitBadge.localTip' },
    ]);
    expect(remoteBadges).toEqual([
      { key: 'remote', label: 'origin/main', ariaLabelKey: 'gitView.history.commitBadge.remoteTip' },
    ]);
  });

  test('labels separate remote and local tips when local is behind', () => {
    const remoteBadges = resolveHistoryCommitBadges(
      createEntry({ isHead: false, isRemoteHead: true }),
      { currentBranch: 'main', trackingBranch: 'origin/main' }
    );
    const localBadges = resolveHistoryCommitBadges(
      createEntry({ isHead: true, isRemoteHead: false }),
      { currentBranch: 'main', trackingBranch: 'origin/main' }
    );

    expect(remoteBadges.map((badge) => badge.label)).toEqual(['origin/main']);
    expect(localBadges.map((badge) => badge.label)).toEqual(['main']);
  });

  test('shows both branch badges when local and remote are synced', () => {
    const badges = resolveHistoryCommitBadges(
      createEntry({ isHead: true, isRemoteHead: true }),
      { currentBranch: 'main', trackingBranch: 'origin/main' }
    );

    expect(badges.map((badge) => badge.label)).toEqual(['main', 'origin/main']);
  });

  test('omits remote badge when there is no upstream', () => {
    const badges = resolveHistoryCommitBadges(
      createEntry({ isHead: true, isRemoteHead: false }),
      { currentBranch: 'main', trackingBranch: null }
    );

    expect(badges).toEqual([
      { key: 'local', label: 'main', ariaLabelKey: 'gitView.history.commitBadge.localTip' },
    ]);
  });
});
