import React from 'react';
import { RiDatabase2Line, RiLoaderLine, RiSearchLine } from '@remixicon/react';
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
import { useI18n } from '@/lib/i18n';
import { formatBytes } from '@/lib/formatBytes';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { OpenCodeStorageRunSummary, OpenCodeStorageStatus } from '@/lib/api/types';
import { describeDryRun, describeLastRun, describeRunFailure, formatCount } from './openCodeStorageCopy';

// A forced compaction restarts OpenCode and can VACUUM a multi-GB file; poll
// the status for a bounded time so the panel refreshes when it lands.
const COMPACTION_POLL_INTERVAL_MS = 5_000;
const COMPACTION_POLL_ATTEMPTS = 36;

type OpenCodeStorageBusy = 'idle' | 'dryRun' | 'scheduling' | 'compacting';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

interface OpenCodeStorageSettingsViewProps {
  status: OpenCodeStorageStatus | null;
  loading: boolean;
  error: string | null;
  dryRun: OpenCodeStorageRunSummary | null;
  busy: OpenCodeStorageBusy;
  onDryRun: () => void;
  onCompact: () => void;
}

/** Presentational half; the container below owns fetching, polling and the confirm dialog. */
export const OpenCodeStorageSettingsView: React.FC<OpenCodeStorageSettingsViewProps> = ({
  status,
  loading,
  error,
  dryRun,
  busy,
  onDryRun,
  onCompact,
}) => {
  const { t } = useI18n();
  const usable = Boolean(status?.exists && status.schema === 'ok');
  const canCompact = usable && Boolean(status?.managedRuntime) && !status?.compactionPending && !status?.running;

  let summary: string;
  if (!status) {
    summary = loading || !error
      ? t('settings.openchamber.storage.loading')
      : t('settings.openchamber.storage.unavailable', { error });
  } else if (!status.exists) {
    summary = t('settings.openchamber.storage.missing');
  } else if (status.schema !== 'ok') {
    summary = t('settings.openchamber.storage.schemaMismatch');
  } else {
    summary = t('settings.openchamber.storage.summary', {
      size: formatBytes(status.dbBytes),
      wal: formatBytes(status.walBytes),
      events: formatCount(status.eventRows),
      reclaimable: formatBytes(status.reclaimableBytes),
    });
  }

  return (
    <div className="border-t border-border/40 pt-3 space-y-1" data-opencode-storage-settings="">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
        <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
          <p className="typography-meta text-foreground font-medium">
            {t('settings.openchamber.storage.title')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:w-fit">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onDryRun}
            disabled={busy !== 'idle' || !usable || Boolean(status?.running)}
            className="!font-normal normal-case"
          >
            {busy === 'dryRun'
              ? <RiLoaderLine className="mr-1 h-3.5 w-3.5 animate-spin" />
              : <RiSearchLine className="mr-1 h-3.5 w-3.5" />}
            {t('settings.openchamber.storage.actions.dryRun')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onCompact}
            disabled={busy !== 'idle' || !canCompact}
            className="!font-normal normal-case"
          >
            {busy === 'scheduling' || busy === 'compacting'
              ? <RiLoaderLine className="mr-1 h-3.5 w-3.5 animate-spin" />
              : <RiDatabase2Line className="mr-1 h-3.5 w-3.5" />}
            {busy === 'compacting'
              ? t('settings.openchamber.storage.actions.compacting')
              : t('settings.openchamber.storage.actions.compact')}
          </Button>
        </div>
      </div>
      <p className="typography-meta text-muted-foreground">{summary}</p>
      {usable && status && status.orphanEventRows > 0 && (
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.storage.orphans', { count: formatCount(status.orphanEventRows) })}
        </p>
      )}
      {usable && (
        <p className="typography-meta text-muted-foreground">{describeLastRun(t, status?.lastRun ?? null)}</p>
      )}
      {dryRun && (
        <p className="typography-meta text-muted-foreground">{describeDryRun(t, dryRun)}</p>
      )}
      {status?.running && (
        <p className="typography-meta text-muted-foreground">{t('settings.openchamber.storage.running')}</p>
      )}
      {status?.compactionPending && (
        <p className="typography-meta text-muted-foreground">{t('settings.openchamber.storage.pending')}</p>
      )}
      {status && status.maintenance?.enabled === false && (
        <p className="typography-meta text-muted-foreground">{t('settings.openchamber.storage.autoDisabled')}</p>
      )}
      {status && !status.managedRuntime && (
        <p className="typography-meta text-muted-foreground">{t('settings.openchamber.storage.external')}</p>
      )}
      {status && error && (
        <p className="typography-meta text-destructive">{error}</p>
      )}
    </div>
  );
};

/**
 * Settings → Data Retention → OpenCode Storage. Rendered only when the
 * runtime's diagnostics API exposes the storage members (web/Electron); the
 */
export const OpenCodeStorageSettings: React.FC = () => {
  const { t } = useI18n();
  const { diagnostics } = useRuntimeAPIs();
  const available = Boolean(diagnostics?.getOpenCodeStorage && diagnostics?.compactOpenCodeStorage);
  const [status, setStatus] = React.useState<OpenCodeStorageStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [dryRun, setDryRun] = React.useState<OpenCodeStorageRunSummary | null>(null);
  const [busy, setBusy] = React.useState<OpenCodeStorageBusy>('idle');
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = React.useCallback(async (): Promise<OpenCodeStorageStatus | null> => {
    if (!diagnostics?.getOpenCodeStorage) return null;
    setLoading(true);
    try {
      const next = await diagnostics.getOpenCodeStorage();
      if (mountedRef.current) {
        setStatus(next);
        setError(null);
      }
      return next;
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [diagnostics]);

  React.useEffect(() => {
    if (!available) return;
    void refresh();
  }, [available, refresh]);

  const runDryRun = React.useCallback(async () => {
    if (!diagnostics?.compactOpenCodeStorage || busy !== 'idle') return;
    setBusy('dryRun');
    try {
      const result = await diagnostics.compactOpenCodeStorage({ dryRun: true });
      if (mountedRef.current) setDryRun(result.run ?? null);
    } catch (cause) {
      toast.error(t('settings.openchamber.storage.toast.dryRunFailed'), {
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      if (mountedRef.current) setBusy('idle');
    }
  }, [busy, diagnostics, t]);

  const compact = React.useCallback(async () => {
    if (!diagnostics?.compactOpenCodeStorage || busy !== 'idle') return;
    setBusy('scheduling');
    const previousRunAt = status?.lastRun?.at ?? null;
    try {
      const result = await diagnostics.compactOpenCodeStorage({});
      setConfirmOpen(false);
      if (!result.scheduled) {
        throw new Error(t('settings.openchamber.storage.toast.compactFailed'));
      }
      toast.message(t('settings.openchamber.storage.toast.scheduled'));
      if (mountedRef.current) {
        setBusy('compacting');
        setDryRun(null);
      }
      for (let attempt = 0; attempt < COMPACTION_POLL_ATTEMPTS && mountedRef.current; attempt += 1) {
        await sleep(COMPACTION_POLL_INTERVAL_MS);
        const next = await refresh();
        const landed = Boolean(
          next
          && !next.compactionPending
          && !next.running
          && next.lastRun
          && !next.lastRun.dryRun
          && next.lastRun.at !== previousRunAt,
        );
        if (landed && next?.lastRun) {
          if (next.lastRun.status === 'ok') {
            toast.success(t('settings.openchamber.storage.toast.completed'), {
              description: t('settings.openchamber.storage.toast.completedDescription', {
                events: formatCount(next.lastRun.deletedEvents),
                before: formatBytes(next.lastRun.before?.dbBytes ?? 0),
                after: formatBytes(next.lastRun.after?.dbBytes ?? 0),
              }),
            });
          } else {
            toast.error(t('settings.openchamber.storage.toast.compactFailed'), {
              description: describeRunFailure(t, next.lastRun.error),
            });
          }
          break;
        }
      }
    } catch (cause) {
      toast.error(t('settings.openchamber.storage.toast.compactFailed'), {
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      if (mountedRef.current) setBusy('idle');
    }
  }, [busy, diagnostics, refresh, status, t]);

  if (!available) return null;

  return (
    <>
      <OpenCodeStorageSettingsView
        status={status}
        loading={loading}
        error={error}
        dryRun={dryRun}
        busy={busy}
        onDryRun={() => { void runDryRun(); }}
        onCompact={() => setConfirmOpen(true)}
      />
      <Dialog open={confirmOpen} onOpenChange={(open) => { if (busy === 'idle') setConfirmOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.openchamber.storage.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.openchamber.storage.dialog.description', {
                hours: formatCount(status?.maintenance?.idleHours ?? 24),
                keep: formatCount(status?.maintenance?.keepSeqPerAggregate ?? 64),
                reclaimable: formatBytes(status?.reclaimableBytes ?? 0),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy !== 'idle'}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => { void compact(); }} disabled={busy !== 'idle'}>
              {busy === 'scheduling'
                ? t('settings.openchamber.storage.actions.compacting')
                : t('settings.openchamber.storage.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
