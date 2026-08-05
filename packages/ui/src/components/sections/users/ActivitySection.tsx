import * as React from 'react';
import { RiDeleteBinLine, RiDownloadLine, RiUserSettingsLine } from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { requestJson, type ActivityRow, type AuditStatus } from './types';

export const ActivityList: React.FC<{ activity: ActivityRow[]; emptyLabel?: string }> = ({ activity, emptyLabel }) => (
  <div className="space-y-1">
    {activity.length === 0 && (
      <div className="typography-meta text-muted-foreground">{emptyLabel || 'No recent activity.'}</div>
    )}
    {activity.map((row) => (
      <div key={row.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 typography-meta hover:bg-interactive-hover">
        <RiUserSettingsLine className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium text-foreground">{row.action}</span>
        <span className="text-muted-foreground">{row.actor_role || 'system'}</span>
        <span className="ml-auto text-muted-foreground">{new Date(row.created_at).toLocaleString()}</span>
      </div>
    ))}
  </div>
);

interface ActivitySectionProps {
  activity: ActivityRow[];
  auditStatus: AuditStatus | null;
  isAdmin: boolean;
  onChanged: () => Promise<void> | void;
}

export const ActivitySection: React.FC<ActivitySectionProps> = ({ activity, auditStatus, isAdmin, onChanged }) => {
  const [busy, setBusy] = React.useState(false);
  const [purgeOpen, setPurgeOpen] = React.useState(false);

  const exportActivity = async () => {
    try {
      const response = await fetch('/api/admin/activity/export', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to export activity');
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `DevRyan-activity-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      toast.success('Activity exported');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export activity');
    }
  };

  const purgeActivity = async () => {
    setBusy(true);
    try {
      await requestJson('/api/admin/activity', { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
      await onChanged();
      setPurgeOpen(false);
      toast.success('Activity log purged');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to purge activity');
    } finally { setBusy(false); }
  };

  return (
    <SettingsSection
      title="Recent Activity"
      description="Actor-attributed administrative and session events from the durable audit trail."
      divider
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void exportActivity()} disabled={busy}>
            <RiDownloadLine className="h-4 w-4" /> Export Activity
          </Button>
          {isAdmin && (
            <>
            <Button variant="outline" size="sm" onClick={() => setPurgeOpen(true)} disabled={busy}>
              <RiDeleteBinLine className="h-4 w-4" /> Purge Activity
            </Button>
            {auditStatus && (
              <span className={`typography-meta ${auditStatus.backlog > 0 ? 'text-[var(--status-warning)]' : 'text-muted-foreground'}`}>
                Outbox: {auditStatus.backlog} pending · {auditStatus.deliveryFailures} delivery failures
              </span>
            )}
            </>
          )}
        </div>
        <ActivityList activity={activity} />
      </div>
      <ConfirmActionDialog
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        title="Purge Activity Log"
        description="Permanently purge the shared activity log? The purge event itself is retained."
        confirmLabel="Purge Activity"
        destructive
        busy={busy}
        onConfirm={() => void purgeActivity()}
      />
    </SettingsSection>
  );
};
