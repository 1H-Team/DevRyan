import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const userManagementSource = readFileSync(new URL('./UserManagementPage.tsx', import.meta.url), 'utf8');
const userManagementDataSource = readFileSync(new URL('./useAdminUsersData.ts', import.meta.url), 'utf8');
const createUserSource = readFileSync(new URL('./CreateUserDialog.tsx', import.meta.url), 'utf8');
const userDetailSource = readFileSync(new URL('./UserDetail.tsx', import.meta.url), 'utf8');
const githubAccountsSource = readFileSync(new URL('./GitHubAccountsSection.tsx', import.meta.url), 'utf8');
const gitPageSource = readFileSync(new URL('../git-identities/GitPage.tsx', import.meta.url), 'utf8');
const githubPrPickerSource = readFileSync(new URL('../../session/GitHubPrPickerDialog.tsx', import.meta.url), 'utf8');
const githubIssuePickerSource = readFileSync(new URL('../../session/GitHubIssuePickerDialog.tsx', import.meta.url), 'utf8');
const githubIntegrationSource = readFileSync(new URL('../../session/GitHubIntegrationDialog.tsx', import.meta.url), 'utf8');
const pullRequestSectionSource = readFileSync(new URL('../../views/git/PullRequestSection.tsx', import.meta.url), 'utf8');

describe('managed GitHub settings source contract', () => {
  test('places the admin account inventory immediately after Users and before Projects', () => {
    const usersIndex = userManagementSource.indexOf('title="Users"');
    const githubIndex = userManagementSource.indexOf('<GitHubAccountsSection');
    const projectsIndex = userManagementSource.indexOf('<ProjectsSection');

    expect(usersIndex).toBeGreaterThan(-1);
    expect(githubIndex).toBeGreaterThan(usersIndex);
    expect(projectsIndex).toBeGreaterThan(githubIndex);
    expect(userManagementSource).toContain("canEdit && principal?.role === 'admin'");
    expect(userManagementSource).toContain('{canManageGitHubAccounts && (');
  });

  test('moves local GitHub settings from Git to User Management', () => {
    expect(userManagementSource).toContain("principal.scope === 'local-admin'");
    expect(userManagementSource).toContain('<GitHubSettings />');
    expect(gitPageSource).not.toContain('GitHubSettings');
    expect(gitPageSource).not.toContain('useAuthPrincipal');
  });

  test('routes every GitHub connection shortcut to User Management', () => {
    for (const source of [githubPrPickerSource, githubIssuePickerSource, githubIntegrationSource, pullRequestSectionSource]) {
      expect(source).toContain("setSettingsPage('users')");
      expect(source).not.toContain("setSettingsPage('github')");
      expect(source).toContain('settings.github.accountManagement.adminRequired');
    }
  });

  test('prevents selectors from offering accounts assigned to another user', () => {
    expect(createUserSource).toContain('disabled={Boolean(account.assignedUser)}');
    expect(userDetailSource).toContain('account.assignedUser.id !== user.id');
    expect(userDetailSource).toContain('disabled={assignedElsewhere}');
  });

  test('offers atomic admin reassignment without exposing other hidden fixtures', () => {
    expect(userManagementSource).toContain('users={data.users}');
    expect(userManagementSource).toContain('id: principal.id');
    expect(githubAccountsSource).toContain("method: 'PUT'");
    expect(githubAccountsSource).toContain('/assignment`');
    expect(githubAccountsSource).toContain('current hidden test owner');
    expect(githubAccountsSource).toContain('assignableUsers');
    expect(githubAccountsSource).toContain('Save Assignment');
    expect(githubAccountsSource).toContain('already assigned @');
    expect(githubAccountsSource).toContain('The credential will stay connected to this host.');
  });

  test('blocks managed datasets and exposes explicit offline-grace recovery controls', () => {
    expect(userManagementSource).toContain('useAuthOfflineGrace()');
    expect(userManagementSource).toContain('useAdminUsersData(canEdit, canManageGitHubAccounts, !offlineGrace)');
    expect(userManagementSource).toContain('Identity Service Temporarily Unavailable');
    expect(userManagementSource).toContain('retryAuthSession()');
    expect(userManagementDataSource).toContain('if (!enabled)');
  });
});
