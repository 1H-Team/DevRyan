import * as React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { describeInvite, requestJson, type InviteRow } from './types';

interface AccessLinksListProps {
  invites: InviteRow[];
  onChanged: () => Promise<void> | void;
  emptyLabel?: string;
  canEdit?: boolean;
}

export const AccessLinksList: React.FC<AccessLinksListProps> = ({ invites, onChanged, emptyLabel, canEdit = true }) => {
  const [busy, setBusy] = React.useState(false);

  const revokeInvite = async (invite: InviteRow) => {
    setBusy(true);
    try {
      await requestJson(`/api/admin/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE' });
      await onChanged();
      toast.success('Invitation revoked');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to revoke invitation');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      {invites.length === 0 && (
        <div className="typography-meta text-muted-foreground">{emptyLabel || 'No access links have been issued.'}</div>
      )}
      {invites.map((invite) => {
        const { active, label } = describeInvite(invite);
        return (
          <div key={invite.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 p-3 typography-meta">
            <span className="font-medium text-foreground">{invite.email}</span>
            <span className="text-muted-foreground">{label}</span>
            {active && canEdit && <Button className="ml-auto" variant="outline" size="xs" onClick={() => void revokeInvite(invite)} disabled={busy}>Revoke</Button>}
          </div>
        );
      })}
    </div>
  );
};

interface AccessLinksSectionProps {
  invites: InviteRow[];
  onChanged: () => Promise<void> | void;
  canEdit?: boolean;
}

export const AccessLinksSection: React.FC<AccessLinksSectionProps> = ({ invites, onChanged, canEdit = true }) => (
  <SettingsSection
    title="Access Links"
    description="Links are targeted, single-use, and still require the matching user's password."
    divider
  >
    <AccessLinksList invites={invites} onChanged={onChanged} canEdit={canEdit} />
  </SettingsSection>
);
