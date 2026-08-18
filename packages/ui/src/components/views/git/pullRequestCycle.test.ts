import { describe, expect, test } from 'bun:test';
import {
  createNextPullRequestDraft,
  DEFAULT_PULL_REQUEST_PANEL_VIEW,
  formatPullRequestStatus,
  isCurrentPullRequestSelection,
  nextPullRequestPanelView,
  shouldClearNextPullRequestDraft,
  shouldShowPullRequestChecks,
  shouldShowPullRequestDetails,
} from './pullRequestCycle';

describe('reusable PR branch lifecycle', () => {
  test('opens the PR tab on the full pull request list', () => {
    expect(DEFAULT_PULL_REQUEST_PANEL_VIEW).toBe('list');
  });

  test('starts a clean next-cycle draft without mutating the branch', () => {
    expect(createNextPullRequestDraft('Dev', 7023, (branch) => branch)).toEqual({
      title: 'Dev',
      body: '',
      draft: false,
      additionalContext: '',
      terminalPrNumber: 7023,
    });
  });

  test('clears a retained next-cycle draft when an open PR is discovered', () => {
    expect(shouldClearNextPullRequestDraft(7023, 'merged')).toBe(false);
    expect(shouldClearNextPullRequestDraft(7023, 'open')).toBe(true);
  });

  test('shows existing PR details only while the PR is open', () => {
    expect(shouldShowPullRequestDetails('open')).toBe(true);
    expect(shouldShowPullRequestDetails('merged')).toBe(false);
    expect(shouldShowPullRequestDetails('closed')).toBe(false);
  });

  test('formats PR summary statuses in title case', () => {
    expect(formatPullRequestStatus('open')).toBe('Open');
    expect(formatPullRequestStatus('draft')).toBe('Draft');
    expect(formatPullRequestStatus('merged')).toBe('Merged');
    expect(formatPullRequestStatus('closed')).toBe('Closed');
    expect(formatPullRequestStatus('blocked')).toBe('Blocked');
  });

  test('shows only meaningful pull request check summaries', () => {
    expect(shouldShowPullRequestChecks(null)).toBe(false);
    expect(shouldShowPullRequestChecks({ state: 'unknown', total: 0, success: 0, failure: 0, pending: 0 })).toBe(false);
    expect(shouldShowPullRequestChecks({ state: 'success', total: 1, success: 1, failure: 0, pending: 0 })).toBe(true);
    expect(shouldShowPullRequestChecks({ state: 'pending', total: 1, success: 0, failure: 0, pending: 1 })).toBe(true);
    expect(shouldShowPullRequestChecks({ state: 'failure', total: 1, success: 0, failure: 1, pending: 0 })).toBe(true);
  });

  test('navigates current detail to list, selected detail, and back', () => {
    expect(nextPullRequestPanelView('current', 'show-list')).toBe('list');
    expect(nextPullRequestPanelView('list', 'show-selected')).toBe('selected');
    expect(nextPullRequestPanelView('selected', 'show-list')).toBe('list');
  });

  test('keeps management mode only for the current repository pull request', () => {
    const selected = {
      number: 24,
      title: 'Selected PR',
      url: 'https://github.com/octo/project/pull/24',
      state: 'open' as const,
      draft: false,
      base: 'main',
      head: 'feature',
      sourceRepo: { owner: 'octo', repo: 'project', source: 'origin' },
    };
    expect(isCurrentPullRequestSelection(24, { owner: 'octo', repo: 'project' }, selected)).toBe(true);
    expect(isCurrentPullRequestSelection(24, { owner: 'octo', repo: 'other' }, selected)).toBe(false);
    expect(isCurrentPullRequestSelection(24, null, selected)).toBe(false);
    expect(isCurrentPullRequestSelection(25, { owner: 'octo', repo: 'project' }, selected)).toBe(false);
  });
});
