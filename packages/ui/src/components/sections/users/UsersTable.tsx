import * as React from 'react';
import { RiAddLine, RiLink } from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { requestJson, roleLabel, type UserRow } from './types';
import { copyTextToClipboard } from '@/lib/clipboard';

interface UsersTableProps {
  users: UserRow[];
  isAdmin: boolean;
  onSelectUser: (userId: string) => void;
  onCreateUser: () => void;
  onInviteCreated: (url: string) => Promise<void> | void;
}

const statusTone: Record<UserRow['status'], string> = {
  active: 'text-[var(--status-success)]',
  suspended: 'text-[var(--status-warning)]',
  archived: 'text-muted-foreground',
};

export const UsersTable: React.FC<UsersTableProps> = ({
  users,
  isAdmin,
  onSelectUser,
  onCreateUser,
  onInviteCreated,
}) => {
  const [busy, setBusy] = React.useState(false);

  const createInvite = async (user: UserRow) => {
    setBusy(true);
    try {
      const payload = await requestJson<{ invite: { url: string } }>('/api/admin/invites', {
        method: 'POST', body: JSON.stringify({ email: user.email, expiresInDays: 2 }),
      });
      const url = new URL(payload.invite.url, window.location.origin).toString();
      await copyTextToClipboard(url, { sourceSurface: 'settings', copyKind: 'text' });
      await onInviteCreated(url);
      toast.success('Single-use invitation copied');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create invitation');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="typography-meta text-muted-foreground">
          {isAdmin
            ? 'Click a user to manage their role, policy, projects, and access.'
            : 'Click a user to review their profile, effective policy, projects, and access.'}
        </p>
        {isAdmin && (
          <Button size="sm" onClick={onCreateUser}>
            <RiAddLine className="h-4 w-4" /> Create User
          </Button>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Access Link</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">No users found.</TableCell>
            </TableRow>
          )}
          {users.map((user) => (
            <TableRow
              key={user.id}
              data-clickable="true"
              onClick={() => onSelectUser(user.id)}
              aria-label={`Open ${user.email}`}
            >
              <TableCell>
                <div className="min-w-0">
                  <div className="font-medium truncate">{user.display_name}</div>
                  <div className="typography-meta text-muted-foreground truncate">{user.email}</div>
                </div>
              </TableCell>
              <TableCell className="capitalize">{roleLabel(user.role)}</TableCell>
              <TableCell className={`capitalize ${statusTone[user.status]}`}>{user.status}</TableCell>
              <TableCell className="text-right">
                {isAdmin && user.role !== 'admin' && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={(event) => { event.stopPropagation(); void createInvite(user); }}
                    disabled={busy || user.status === 'archived'}
                  >
                    <RiLink className="h-4 w-4" /> Invite
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
