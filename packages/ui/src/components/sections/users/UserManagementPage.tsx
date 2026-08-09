import * as React from 'react';
import { RiFileCopyLine, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { GitHubSettings } from '@/components/sections/openchamber/GitHubSettings';
import { retryAuthSession, useAuthOfflineGrace, useAuthPrincipal } from '@/lib/authSession';
import { isVSCodeRuntime } from '@/lib/desktop';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useSettingsPagePermission } from '@/lib/settings/permission-state';
import { AccessLinksSection } from './AccessLinksSection';
import { ActivitySection } from './ActivitySection';
import { CreateUserDialog } from './CreateUserDialog';
import { GitHubAccountsSection } from './GitHubAccountsSection';
import { ProjectsSection } from './ProjectsSection';
import { RolePoliciesSection } from './RolePoliciesSection';
import { UserDetail } from './UserDetail';
import { UsersTable } from './UsersTable';
import { useAdminUsersData } from './useAdminUsersData';

const LocalUserManagementPage: React.FC = () => (
  <SettingsPageLayout>
    <div>
      <h1 className="typography-ui-header font-semibold text-foreground">User Management</h1>
      <p className="typography-ui text-muted-foreground">Manage the GitHub accounts available to this DevRyan installation.</p>
    </div>

    {isVSCodeRuntime() ? (
      <SettingsSection
        title="Local Account Management"
        description="GitHub account management is available in the DevRyan web and desktop apps."
      >
        <p className="typography-ui text-muted-foreground">Open User Management in a supported runtime to connect or switch accounts.</p>
      </SettingsSection>
    ) : (
      <GitHubSettings />
    )}
  </SettingsPageLayout>
);

const ManagedUserManagementPage: React.FC = () => {
  const { canEdit } = useSettingsPagePermission();
  const principal = useAuthPrincipal();
  const offlineGrace = useAuthOfflineGrace();
  const canManageGitHubAccounts = canEdit && principal?.role === 'admin';
  const data = useAdminUsersData(canEdit, canManageGitHubAccounts, !offlineGrace);
  const [retrying, setRetrying] = React.useState(false);

  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [temporaryPassword, setTemporaryPassword] = React.useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = React.useState<string | null>(null);

  const selectedUser = React.useMemo(
    () => (selectedUserId ? data.users.find((user) => user.id === selectedUserId) || null : null),
    [data.users, selectedUserId],
  );

  if (offlineGrace) {
    return (
      <SettingsPageLayout className="max-w-4xl">
        <div>
          <h1 className="typography-ui-header font-semibold text-foreground">User Management</h1>
          <p className="typography-ui text-muted-foreground">Manage roles, projects, branch grants, GitHub identity, and audit activity.</p>
        </div>
        <SettingsSection
          title="Identity Service Temporarily Unavailable"
          description="DevRyan is keeping your local administrator session active, but account and host management stay locked until the identity service can verify current access."
        >
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 typography-ui text-muted-foreground">
              This page will recover automatically when the connection returns.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                void retryAuthSession().finally(() => setRetrying(false));
              }}
            >
              <RiRefreshLine className={retrying ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              {retrying ? 'Checking…' : 'Retry Now'}
            </Button>
          </div>
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  if (data.loading) {
    return <div className="flex h-full items-center justify-center typography-ui text-muted-foreground">Loading user management…</div>;
  }

  const banners = (
    <>
      {temporaryPassword && (
        <div className="rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 p-3">
          <div className="typography-ui-label font-medium">Temporary Password — Shown Once</div>
          <code className="mt-1 block break-all typography-code text-foreground">{temporaryPassword}</code>
          <Button variant="ghost" size="xs" className="mt-2" onClick={() => void copyTextToClipboard(temporaryPassword, { sourceSurface: 'settings', copyKind: 'text' })}>Copy Password</Button>
        </div>
      )}
      {inviteUrl && (
        <div className="rounded-lg border border-[var(--status-success)]/30 bg-[var(--status-success)]/10 p-3">
          <div className="typography-ui-label font-medium">Single-Use Invitation — Shown Once</div>
          <code className="mt-1 block break-all typography-code text-foreground">{inviteUrl}</code>
          <Button variant="ghost" size="xs" className="mt-2" onClick={() => void copyTextToClipboard(inviteUrl, { sourceSurface: 'settings', copyKind: 'text' })}>
            <RiFileCopyLine className="h-4 w-4" /> Copy Invitation
          </Button>
        </div>
      )}
    </>
  );

  if (selectedUser) {
    return (
      <SettingsPageLayout className="max-w-6xl">
        {banners}
        <UserDetail
          user={selectedUser}
          isAdmin={canEdit}
          canViewDetailedAnalytics={principal.role === 'admin'}
          projects={data.projects}
          githubAccounts={data.githubAccounts}
          invites={data.invites}
          activity={data.activity}
          onBack={() => setSelectedUserId(null)}
          onUsersChanged={async () => { await Promise.all([data.reloadUsers(), data.reloadGithubAccounts(), data.reloadActivity()]); }}
          onInvitesChanged={async () => { await Promise.all([data.reloadInvites(), data.reloadActivity()]); }}
          onTemporaryPassword={setTemporaryPassword}
        />
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout className="max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="typography-ui-header font-semibold text-foreground">User Management</h1>
          <p className="typography-ui text-muted-foreground">Manage roles, projects, branch grants, GitHub identity, and audit activity.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void data.reloadAll()} disabled={data.loading}>
          <RiRefreshLine className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {banners}

      <SettingsSection title="Users">
        <UsersTable
          users={data.users}
          isAdmin={canEdit}
          onSelectUser={setSelectedUserId}
          onCreateUser={() => setCreateOpen(true)}
          onInviteCreated={async (url) => {
            setInviteUrl(url);
            await Promise.all([data.reloadInvites(), data.reloadActivity()]);
          }}
        />
      </SettingsSection>

      {canManageGitHubAccounts && (
        <GitHubAccountsSection
          accounts={data.githubAccounts}
          users={data.users}
          currentAdmin={{
            id: principal.id,
            email: principal.email || principal.displayName,
            display_name: principal.displayName,
          }}
          onChanged={async () => {
            await Promise.all([data.reloadGithubAccounts(), data.reloadUsers(), data.reloadActivity()]);
          }}
        />
      )}

      {canEdit && <ProjectsSection projects={data.projects} onChanged={async () => { await Promise.all([data.reloadProjects(), data.reloadActivity()]); }} />}
      {canEdit && <RolePoliciesSection roles={data.roles} onSaved={async () => { await Promise.all([data.reloadRoles(), data.reloadActivity()]); }} />}
      <AccessLinksSection invites={data.invites} canEdit={canEdit} onChanged={async () => { await Promise.all([data.reloadInvites(), data.reloadActivity()]); }} />
      <ActivitySection
        activity={data.activity}
        auditStatus={data.auditStatus}
        isAdmin={canEdit}
        onChanged={() => data.reloadActivity()}
      />

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={data.projects}
        githubAccounts={data.githubAccounts}
        onCreated={async (password) => {
          setTemporaryPassword(password);
          await Promise.all([data.reloadUsers(), data.reloadGithubAccounts(), data.reloadActivity()]);
        }}
      />
    </SettingsPageLayout>
  );
};

export const UserManagementPage: React.FC = () => {
  const principal = useAuthPrincipal();

  if (principal.scope === 'local-admin') {
    return <LocalUserManagementPage />;
  }

  return <ManagedUserManagementPage />;
};
