import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(resolve(testDir, 'GitView.tsx'), 'utf8');

describe('GitView revert actions', () => {
  test('does not show a success toast after reverting a single file', () => {
    const code = source();

    expect(code).not.toContain("toast.success(t('gitView.toast.revertedFile'");
  });
});

describe('GitView branch rename access', () => {
  test('withholds the rename callback from managed non-administrators', () => {
    const code = source();

    expect(code).toContain(
      "const canRenameBranch = principal.scope !== 'managed' || principal.role === 'admin';",
    );
    expect(code).toContain(
      'onRenameBranch={canRenameBranch ? handleRenameBranch : undefined}',
    );
  });
});

describe('GitView worktree bootstrap gating', () => {
  test('does not collect repository status until bootstrap is authoritative', () => {
    const code = source();

    expect(code).toContain("const isWorktreeBootstrapReady = worktreeBootstrapStatus === 'ready'");
    expect(code).toContain('if (!isWorktreeBootstrapReady) return;');
    expect(code).toContain('if (!currentDirectory || !isWorktreeBootstrapReady) {');
    expect(code).toContain("worktreeBootstrapStatus === null");
  });
});

describe('GitView staged changes workflow', () => {
  test('does not render the repository state summary', () => {
    const code = source();

    expect(code).not.toContain('RepositoryStateSummary');
  });

  test('does not reference chat-based commit generation', () => {
    const code = source();

    expect(code).not.toContain("toast.success(t('gitView.toast.generateCommitChatStarted')");
    expect(code).not.toContain('buildCommitGenerationChatPromptPayload');
    expect(code).not.toContain('handleStartCommitGenerationChat');
  });

  test('generates a commit message draft without starting a chat session', () => {
    const code = source();

    expect(code).toContain('generateCommitMessageDraft');
    expect(code).toContain('const handleGenerateCommitMessage = React.useCallback(async () => {');
    expect(code).toContain('await generateCommitMessageDraft(currentDirectory, commitScope.files, {');
    expect(code).toContain('commitMessageGuidance');
    expect(code).toContain('setCommitMessage(generatedSubject);');
    expect(code).not.toContain("toast.success(t('gitView.toast.commitMessageGenerated'))");
    expect(code).toContain('commitGenerationRequestRef');
    expect(code).toContain('if (!isCurrentRequest())');
    expect(code).toContain('setIsGeneratingCommitMessage(false);');
    expect(code).not.toContain('buildCommitGenerationChatPromptPayload');
    expect(code).not.toContain('handleStartCommitGenerationChat');
    expect(code).not.toContain('createSession(undefined, currentDirectory, null)');
    expect(code).not.toContain("setActiveMainTab('chat')");
    expect(code).not.toContain('await sendMessage(');
  });

  test('renders staged changes above unstaged changes and derives staged-only commit scope first', () => {
    const code = source();

    expect(code).toContain('stagedEntries');
    expect(code).toContain('unstagedEntries');
    expect(code).toContain("title={t('gitView.changes.stagedTitle')}");
    expect(code).toContain("kind: 'staged'");
    expect(code).toContain('stagedOnly: true');
  });

  test('falls back to all changed files when nothing is staged', () => {
    const code = source();

    expect(code).toContain("kind: 'all'");
    expect(code).toContain('changeEntries.map((entry) => entry.path)');
    expect(code).toContain('stagedOnly: commitScope.stagedOnly');
  });

  test('validates commit messages before creating a commit', () => {
    const code = source();

    expect(code).toContain('const validation = validateCommitMessage(commitMessage);');
    expect(code).toContain('const message = validation.cleaned;');
    expect(code).toContain('if (!validation.valid) {');
    expect(code).toContain("toast.error(validation.errors.join(' • '));");
    expect(code).toContain('if (!message) {');
    expect(code).toContain("toast.error(t('gitView.toast.selectFileToCommit'));");
    expect(code).toContain('await git.createGitCommit(currentDirectory, message, {');
  });

  test('awaits repository and history refreshes after a successful commit', () => {
    const code = source();
    const commitStart = code.indexOf('const handleCommit = async');
    const commitEnd = code.indexOf('const handleCreateBranch = async', commitStart);
    const commitHandler = code.slice(commitStart, commitEnd);

    const createCommit = commitHandler.indexOf('await git.createGitCommit');
    const refreshRepository = commitHandler.indexOf('await refreshStatusAndBranches();', createCommit);
    const refreshHistory = commitHandler.indexOf('await refreshLog();', refreshRepository);

    expect(commitStart).toBeGreaterThan(-1);
    expect(commitEnd).toBeGreaterThan(commitStart);
    expect(createCommit).toBeGreaterThan(-1);
    expect(refreshRepository).toBeGreaterThan(createCommit);
    expect(refreshHistory).toBeGreaterThan(refreshRepository);
  });

  test('wires stage and unstage actions through the runtime git API', () => {
    const code = source();

    expect(code).toContain('handleStageFile');
    expect(code).toContain('handleUnstageFile');
    expect(code).toContain('git.stageGitFile');
    expect(code).toContain('git.unstageGitFile');
  });
});

describe('GitView remote sync state refresh', () => {
  test('resolves the tracked remote before falling back to the first remote', () => {
    const code = source();

    expect(code).toContain('const resolveTrackingRemote =');
    expect(code).toContain('remotes.find((remote) => remote.name === trackingRemoteName) ?? remotes[0] ?? null');
  });

  test('fetches the tracked remote on view load before refreshing sync counts', () => {
    const code = source();

    expect(code).toContain('remoteRefreshTimestampsRef');
    expect(code).toContain('await git.gitFetch(currentDirectory, { remote: trackingRemote.name });');
    expect(code).toContain('fetchStatus(currentDirectory, git, { silent: true })');
    expect(code).toContain('fetchBranches(currentDirectory, git)');
    expect(code).toContain('fetchLog(currentDirectory, git, logMaxCountLocal)');
  });

  test('keeps automatic remote refresh failures non-blocking', () => {
    const code = source();

    expect(code).toContain("console.debug('Git view remote refresh failed:', error);");
    expect(code).not.toContain("toast.error(t('gitView.toast.fetchedFromRemote'");
  });

  test('uses fast-forward pull options unless local commits need a rebase', () => {
    const code = source();

    expect(code).toContain('const shouldRebasePull = (pullStatus?.ahead ?? 0) > 0;');
    expect(code).toContain('branch: trackedBranch || currentBranchName,');
    expect(code).toContain('rebase: shouldRebasePull || undefined,');
  });

  test('forces authoritative status and history reads after remote mutations', () => {
    const code = source();

    expect(code).toContain('const refreshAfterRemoteMutation = React.useCallback(async () => {');
    expect(code).toContain('fetchStatus(currentDirectory, git, { force: true })');
    expect(code).toContain('fetchBranches(currentDirectory, git)');
    expect(code).toContain('fetchLog(currentDirectory, git, logMaxCountLocal)');
  });

  test('uses the authoritative refresh after standalone and commit-plus-push flows', () => {
    const code = source();
    const syncStart = code.indexOf('const handleSyncAction = async');
    const syncEnd = code.indexOf('const handleGenerateCommitMessage', syncStart);
    const commitStart = code.indexOf('const handleCommit = async');
    const commitEnd = code.indexOf('const handleCreateBranch = async', commitStart);
    const syncHandler = code.slice(syncStart, syncEnd);
    const commitHandler = code.slice(commitStart, commitEnd);

    expect(syncHandler).toContain("if (action === 'push' || action === 'sync')");
    expect(syncHandler).toContain('await refreshAfterRemoteMutation();');
    expect(commitHandler.match(/await refreshAfterRemoteMutation\(\);/g)).toHaveLength(2);
  });
});

describe('GitView refresh button state', () => {
  test('sets a local refresh state while the refresh button action is running', () => {
    const code = source();

    expect(code).toContain('const [isRefreshingHistoryControls, setIsRefreshingHistoryControls] = React.useState(false);');
    expect(code).toContain('setIsRefreshingHistoryControls(true);');
    expect(code).toContain('setIsRefreshingHistoryControls(false);');
    expect(code).toContain('isRefreshing={isRefreshingHistoryControls || isLoading || isLogLoading}');
  });
});
