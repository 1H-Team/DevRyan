import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./PullRequestSection.tsx', import.meta.url)),
  'utf8',
);

describe('PullRequestSection list actions', () => {
  test('opens the current branch workflow from the pull request list', () => {
    expect(source).toContain('const openCurrentPullRequest = React.useCallback(() => {');
    expect(source).toContain("if (pr?.state === 'closed' || pr?.state === 'merged') {");
    expect(source).toContain('startNextPr();');
    expect(source).toContain("nextPullRequestPanelView(current, 'show-current')");
    expect(source).toContain('onClick={openCurrentPullRequest}');
  });

  test('labels create and existing pull request states', () => {
    expect(source).toContain("const currentBranchActionLabel = pr?.state === 'open'");
    expect(source).toContain("t('gitView.pr.actions.viewCurrentPr', { number: pr.number })");
    expect(source).toContain("t('gitView.pr.actions.createPr')");
    expect(source).not.toContain("t('gitView.pr.list.description')");
  });

  test('keeps the action visible but explains ineligible branches', () => {
    expect(source).toContain('const isCurrentBranchActionLoading = canShow && !isInitialStatusResolved;');
    expect(source).toContain('disabled={!canShow || isCurrentBranchActionLoading}');
    expect(source).toContain("aria-label={t('gitView.pr.actions.creationUnavailableAria')}");
    expect(source).toContain("<TooltipContent><p>{t('gitView.pullRequest.availableOnFeatureBranches')}</p></TooltipContent>");
  });
});
