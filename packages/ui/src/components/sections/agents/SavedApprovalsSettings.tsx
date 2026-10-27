import React from 'react';
import { RiDeleteBinLine, RiEditLine, RiLoaderLine } from '@remixicon/react';
import { SettingsBadge, SettingsDetailSection } from '@/components/sections/shared';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAuthPrincipal } from '@/lib/authSession';
import { useI18n } from '@/lib/i18n';
import {
  canEditSavedApprovals,
  fetchSavedApprovals,
  removeSavedApproval,
  SavedApprovalsApiError,
  updateSavedApproval,
  type SavedApproval,
} from '@/lib/savedApprovalsApi';
import { usePermissionStore } from '@/stores/permissionStore';
import { sortProjectsAlphabetically, useProjectsStore } from '@/stores/useProjectsStore';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; approvals: SavedApproval[] }
  | { kind: 'unavailable' }
  | { kind: 'error'; message?: string };

const formatTime =(value: number) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : undefined);

/**
 * Approvals: the device-local auto-accept default for new sessions, then the
 * saved "Always allow" approvals of one project: list, edit the input pattern,
 * revoke. Native saved approvals are allow rules only; revoking one makes the
 * agent ask again.
 */
export const SavedApprovalsSettings: React.FC = () => {
  const { t } = useI18n();
  const defaultAutoAccept = usePermissionStore((state) => state.defaultAutoAccept);
  const setDefaultAutoAccept = usePermissionStore((state) => state.setDefaultAutoAccept);
  const canEdit = canEditSavedApprovals(useAuthPrincipal());
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const sortedProjects = React.useMemo(() => sortProjectsAlphabetically(projects), [projects]);
  const [chosenProjectId, setChosenProjectId] = React.useState<string | null>(null);
  const project = sortedProjects.find((entry) => entry.id === chosenProjectId)
    ?? sortedProjects.find((entry) => entry.id === activeProjectId)
    ?? sortedProjects[0]
    ?? null;
  const directory = project?.path ?? null;

  const [state, setState] = React.useState<LoadState>({ kind: 'loading' });
  const [editing, setEditing] = React.useState<{ id: string; resource: string } | null>(null);
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<SavedApproval | null>(null);
  const [revokeBusy, setRevokeBusy] = React.useState(false);

  React.useEffect(() => {
    if (!directory) return undefined;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    setEditing(null);
    fetchSavedApprovals(directory, controller.signal)
      .then((result) => setState({ kind: 'ready', approvals: result.approvals }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof SavedApprovalsApiError && error.code === 'capability_unavailable') {
          setState({ kind: 'unavailable' });
          return;
        }
        setState({ kind: 'error', message: errorMessage(error) });
      });
    return () => controller.abort();
  }, [directory]);

  const replaceApproval = React.useCallback((next: SavedApproval) => {
    setState((current) => current.kind === 'ready'
      ? { kind: 'ready', approvals: current.approvals.map((entry) => (entry.id === next.id ? next : entry)) }
      : current);
  }, []);

  const saveResource = React.useCallback(async () => {
    if (!directory || !editing || savingId) return;
    const resource = editing.resource.trim();
    if (!resource) {
      toast.error(t('settings.savedApprovals.edit.empty'));
      return;
    }
    setSavingId(editing.id);
    try {
      replaceApproval(await updateSavedApproval(directory, editing.id, { resource }));
      setEditing(null);
    } catch (error) {
      toast.error(t('settings.savedApprovals.edit.failed'), { description: errorMessage(error) });
    } finally {
      setSavingId(null);
    }
  }, [directory, editing, replaceApproval, savingId, t]);

  const confirmRevoke = React.useCallback(async () => {
    if (!directory || !revoking || revokeBusy) return;
    setRevokeBusy(true);
    try {
      await removeSavedApproval(directory, revoking.id);
      setState((current) => current.kind === 'ready'
        ? { kind: 'ready', approvals: current.approvals.filter((entry) => entry.id !== revoking.id) }
        : current);
      toast.success(t('settings.savedApprovals.revoke.done', { tool: revoking.action }));
      setRevoking(null);
    } catch (error) {
      toast.error(t('settings.savedApprovals.revoke.failed'), { description: errorMessage(error) });
    } finally {
      setRevokeBusy(false);
    }
  }, [directory, revokeBusy, revoking, t]);

  const approvals = state.kind === 'ready' ? state.approvals : [];

  const renderResource = (approval: SavedApproval) => {
    if (editing?.id === approval.id) {
      return (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            autoFocus
            value={editing.resource}
            onChange={(event) => setEditing({ id: approval.id, resource: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void saveResource(); }
              if (event.key === 'Escape') setEditing(null);
            }}
            aria-label={t('settings.savedApprovals.edit.inputAria', { tool: approval.action })}
            className="h-7 min-w-0 flex-1 typography-code"
            disabled={savingId === approval.id}
          />
          <Button type="button" size="xs" onClick={() => { void saveResource(); }} disabled={savingId === approval.id}>
            {t('settings.savedApprovals.edit.save')}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setEditing(null)} disabled={savingId === approval.id}>
            {t('settings.common.actions.cancel')}
          </Button>
        </div>
      );
    }
    return approval.anyInput ? (
      <SettingsBadge tone="warning" title={t('settings.savedApprovals.anyInputHint')}>
        {t('settings.savedApprovals.anyInput')}
      </SettingsBadge>
    ) : (
      <code className="min-w-0 truncate typography-code text-foreground" title={approval.resource}>{approval.resource}</code>
    );
  };

  const renderRow = (approval: SavedApproval) => (
    <li key={approval.id} data-saved-approval={approval.id} className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate typography-ui-label text-foreground" title={approval.action}>{approval.action}</span>
        <SettingsBadge tone="success">{t('settings.savedApprovals.allow')}</SettingsBadge>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {!canEdit || editing?.id === approval.id ? null : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setEditing({ id: approval.id, resource: approval.resource })}
              aria-label={t('settings.savedApprovals.edit.aria', { tool: approval.action })}
            >
              <RiEditLine className="h-3.5 w-3.5" />
              {t('settings.savedApprovals.edit.action')}
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setRevoking(approval)}
            aria-label={t('settings.savedApprovals.revoke.aria', { tool: approval.action })}
          >
            <RiDeleteBinLine className="h-3.5 w-3.5" />
            {t('settings.savedApprovals.revoke.action')}
          </Button>
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 typography-meta text-muted-foreground">{t('settings.savedApprovals.input')}</span>
        {renderResource(approval)}
      </div>
      <span className="typography-micro text-muted-foreground">
        {approval.time.updated > approval.time.created
          ? t('settings.savedApprovals.savedEdited', { saved: formatTime(approval.time.created), edited: formatTime(approval.time.updated) })
          : t('settings.savedApprovals.saved', { saved: formatTime(approval.time.created) })}
      </span>
    </li>
  );

  const renderBody = () => {
    switch (state.kind) {
      case 'loading':
        return (
          <div className="flex items-center gap-2 px-3 py-3 typography-meta text-muted-foreground" aria-busy="true">
            <RiLoaderLine className="h-4 w-4 animate-spin" />
            {t('settings.savedApprovals.loading')}
          </div>
        );
      case 'unavailable':
        return <p className="px-3 py-3 typography-meta text-muted-foreground">{t('settings.savedApprovals.unavailable')}</p>;
      case 'error':
        return <p className="px-3 py-3 typography-meta text-[var(--status-error)]">{state.message ?? t('settings.savedApprovals.loadFailed')}</p>;
      case 'ready':
        return approvals.length === 0
          ? <p className="px-3 py-3 typography-meta text-muted-foreground">{t('settings.savedApprovals.empty')}</p>
          : <ul className="divide-y divide-[var(--interactive-border)]/60">{approvals.map(renderRow)}</ul>;
    }
  };

  return (
    <>
      <SettingsDetailSection title={t('settings.approvals.title')}>
        <div className="flex items-start justify-between gap-6 py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="typography-ui-label text-foreground">{t('settings.approvals.autoAccept.label')}</span>
            <span className="typography-meta text-muted-foreground">{t('settings.approvals.autoAccept.description')}</span>
          </div>
          <Switch
            className="mt-0.5 shrink-0"
            checked={defaultAutoAccept}
            onCheckedChange={setDefaultAutoAccept}
            aria-label={t('settings.approvals.autoAccept.aria')}
          />
        </div>

        {project ? (
          <div data-saved-approvals="true" className="flex flex-col gap-1.5 border-t border-[var(--interactive-border)]/60 pt-3">
            <div className="flex min-h-7 items-center justify-between gap-2">
              <span className="typography-ui-label text-foreground">
                {t('settings.savedApprovals.title')}
                {state.kind === 'ready' ? (
                  <span className="ml-1.5 typography-micro font-normal text-muted-foreground">({approvals.length})</span>
                ) : null}
              </span>
              {sortedProjects.length > 1 ? (
                <SettingsProjectSelector className="w-48" projectId={project.id} onProjectChange={setChosenProjectId} />
              ) : null}
            </div>
            <p className="typography-meta text-muted-foreground">
              {canEdit
                ? t('settings.savedApprovals.description')
                : `${t('settings.savedApprovals.description')} ${t('settings.savedApprovals.editRestricted')}`}
            </p>
            <div className="rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] py-1">
              {renderBody()}
            </div>
          </div>
        ) : null}
      </SettingsDetailSection>

      <Dialog open={revoking !== null} onOpenChange={(open) => { if (!open && !revokeBusy) setRevoking(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.savedApprovals.revoke.title')}</DialogTitle>
            <DialogDescription>
              {revoking?.anyInput
                ? t('settings.savedApprovals.revoke.descriptionAny', { tool: revoking.action })
                : t('settings.savedApprovals.revoke.description', { tool: revoking?.action ?? '', input: revoking?.resource ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)} disabled={revokeBusy}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => { void confirmRevoke(); }} disabled={revokeBusy}>
              {revokeBusy ? t('settings.savedApprovals.revoke.busy') : t('settings.savedApprovals.revoke.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
