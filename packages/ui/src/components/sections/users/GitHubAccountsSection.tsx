import * as React from 'react';
import { RiGithubFill } from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  GitHubDeviceFlowPanel,
} from '@/components/sections/openchamber/GitHubDeviceFlow';
import { useGitHubDeviceFlow } from '@/components/sections/openchamber/useGitHubDeviceFlow';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import {
  requestJson,
  selectClassName,
  type GitHubAccountRow,
  type UserRow,
} from './types';

interface GitHubAccountsSectionProps {
  accounts: GitHubAccountRow[];
  users: UserRow[];
  currentAdmin: Pick<UserRow, 'id' | 'email' | 'display_name'>;
  onChanged: () => Promise<void> | void;
}

export const GitHubAccountsSection: React.FC<GitHubAccountsSectionProps> = ({
  accounts,
  users,
  currentAdmin,
  onChanged,
}) => {
  const [disconnectAccount, setDisconnectAccount] = React.useState<GitHubAccountRow | null>(null);
  const [assignmentAccount, setAssignmentAccount] = React.useState<GitHubAccountRow | null>(null);
  const [assignmentDrafts, setAssignmentDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const { flow, isStarting, start, cancel } = useGitHubDeviceFlow({ onConnected: onChanged });

  React.useEffect(() => {
    setAssignmentDrafts(Object.fromEntries(
      accounts.map((account) => [account.id, account.assignedUser?.id || '']),
    ));
  }, [accounts]);

  const assignableUsers = React.useMemo(() => {
    const byId = new Map<string, Pick<UserRow, 'id' | 'email' | 'display_name' | 'status'>>();
    for (const user of users) byId.set(user.id, user);
    if (!byId.has(currentAdmin.id)) {
      byId.set(currentAdmin.id, { ...currentAdmin, status: 'active' });
    }
    return [...byId.values()];
  }, [currentAdmin, users]);

  const accountByOwnerId = React.useMemo(() => new Map(
    accounts.flatMap((account) => account.assignedUser
      ? [[account.assignedUser.id, account] as const]
      : []),
  ), [accounts]);

  const saveAssignment = async () => {
    if (!assignmentAccount) return;
    const userId = assignmentDrafts[assignmentAccount.id] || null;
    setBusy(true);
    try {
      await requestJson(`/api/admin/github-accounts/${encodeURIComponent(assignmentAccount.id)}/assignment`, {
        method: 'PUT',
        body: JSON.stringify({ userId }),
      });
      setAssignmentAccount(null);
      await onChanged();
      toast.success(userId ? 'GitHub account reassigned' : 'GitHub account unassigned');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update GitHub account assignment');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!disconnectAccount || disconnectAccount.assignedUser) return;
    setBusy(true);
    try {
      await requestJson(`/api/admin/github-accounts/${encodeURIComponent(disconnectAccount.id)}`, {
        method: 'DELETE',
      });
      setDisconnectAccount(null);
      await onChanged();
      toast.success('GitHub account disconnected');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to disconnect GitHub account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="GitHub Accounts"
      description="Connect host credentials, then assign each account to exactly one DevRyan user."
      divider
    >
      <div className="space-y-3">
        {accounts.length === 0 ? (
          <div className="rounded-lg border border-border/60 p-4 typography-meta text-muted-foreground">
            No GitHub accounts are connected to this host.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/60 bg-[var(--surface-elevated)]/70">
            {accounts.map((account, index) => {
              const user = account.user;
              const owner = account.assignedUser;
              const draftUserId = assignmentDrafts[account.id] ?? owner?.id ?? '';
              const hiddenCurrentOwner = owner
                && !assignableUsers.some((candidate) => candidate.id === owner.id)
                ? owner
                : null;
              return (
                <div
                  key={account.id}
                  className={`space-y-3 px-4 py-3 ${index > 0 ? 'border-t border-border/50' : ''}`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    {user?.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt={user.login ? `${user.login} GitHub avatar` : 'GitHub avatar'}
                        className="h-9 w-9 shrink-0 rounded-full border border-border/60 object-cover"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted">
                        <RiGithubFill className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate typography-ui-label text-foreground">
                        {user?.name?.trim() || user?.login || account.id}
                      </div>
                      <div className="truncate typography-micro text-muted-foreground">
                        {user?.login ? `@${user.login}` : account.id}
                        {account.scope ? ` · ${account.scope}` : ''}
                      </div>
                    </div>
                    <div className="typography-meta text-muted-foreground">
                      {owner ? `Assigned to ${owner.displayName}` : 'Unassigned'}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[var(--status-error)] hover:text-[var(--status-error)]"
                      disabled={busy || isStarting || Boolean(owner)}
                      title={owner ? `Unassign this account from ${owner.displayName} before disconnecting it` : undefined}
                      onClick={() => setDisconnectAccount(account)}
                    >
                      Disconnect
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-end gap-2 pl-0 sm:pl-12">
                    <label className="min-w-56 flex-1 space-y-1 typography-meta text-foreground">
                      <span>Assigned DevRyan User</span>
                      <select
                        aria-label={`Assigned DevRyan user for ${user?.login || account.id}`}
                        className={selectClassName}
                        value={draftUserId}
                        disabled={busy || isStarting}
                        onChange={(event) => setAssignmentDrafts((current) => ({
                          ...current,
                          [account.id]: event.target.value,
                        }))}
                      >
                        <option value="">Unassigned</option>
                        {hiddenCurrentOwner && (
                          <option value={hiddenCurrentOwner.id} disabled>
                            {hiddenCurrentOwner.displayName} — current hidden test owner
                          </option>
                        )}
                        {assignableUsers.map((candidate) => {
                          const otherAccount = accountByOwnerId.get(candidate.id);
                          const assignedElsewhere = Boolean(otherAccount && otherAccount.id !== account.id);
                          return (
                            <option key={candidate.id} value={candidate.id} disabled={assignedElsewhere}>
                              {candidate.display_name} ({candidate.email})
                              {assignedElsewhere ? ` — already assigned @${otherAccount?.user?.login || otherAccount?.id}` : ''}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || isStarting || draftUserId === (owner?.id || '')}
                      onClick={() => setAssignmentAccount(account)}
                    >
                      Save Assignment
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <Button size="sm" onClick={() => void start()} disabled={busy || isStarting || Boolean(flow)}>
          {accounts.length > 0 ? 'Add or Reconnect Account' : 'Connect GitHub Account'}
        </Button>
        {flow && <GitHubDeviceFlowPanel flow={flow} onCancel={cancel} />}
      </div>

      <ConfirmActionDialog
        open={assignmentAccount !== null}
        onOpenChange={(open) => { if (!open && !busy) setAssignmentAccount(null); }}
        title={assignmentDrafts[assignmentAccount?.id || ''] ? 'Reassign GitHub Account' : 'Unassign GitHub Account'}
        description={(() => {
          if (!assignmentAccount) return '';
          const login = assignmentAccount.user?.login || assignmentAccount.id;
          const nextUserId = assignmentDrafts[assignmentAccount.id] || '';
          const nextUser = assignableUsers.find((candidate) => candidate.id === nextUserId);
          if (!nextUser) {
            return `Unassign @${login} from ${assignmentAccount.assignedUser?.displayName || 'its current user'}? The credential will stay connected to this host.`;
          }
          return `Move @${login} from ${assignmentAccount.assignedUser?.displayName || 'Unassigned'} to ${nextUser.display_name}?`;
        })()}
        confirmLabel={assignmentDrafts[assignmentAccount?.id || ''] ? 'Reassign' : 'Unassign'}
        busy={busy}
        onConfirm={() => void saveAssignment()}
      />

      <ConfirmActionDialog
        open={disconnectAccount !== null}
        onOpenChange={(open) => { if (!open && !busy) setDisconnectAccount(null); }}
        title="Disconnect GitHub Account"
        description={`Remove ${disconnectAccount?.user?.login || disconnectAccount?.id || 'this account'} from this DevRyan host?`}
        confirmLabel="Disconnect"
        destructive
        busy={busy}
        onConfirm={() => void disconnect()}
      />
    </SettingsSection>
  );
};
