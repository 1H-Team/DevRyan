import React from 'react';
import { RiLoaderLine, RiSearchLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { formatBytes } from '@/lib/formatBytes';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { OpenCodeStorageRunSummary, OpenCodeStorageStatus } from '@/lib/api/types';
import { describeDryRun, describeLastRun, formatCount } from './openCodeStorageCopy';

type OpenCodeStorageBusy = 'idle' | 'dryRun';

interface OpenCodeStorageSettingsViewProps {
  status: OpenCodeStorageStatus | null;
  loading: boolean;
  error: string | null;
  dryRun: OpenCodeStorageRunSummary | null;
  busy: OpenCodeStorageBusy;
  onDryRun: () => void;
}

/**
 * Presentational half; the container below owns fetching and the dry run.
 * Read-only: DevRyan runs native OpenCode 2, and the OpenCode 1 cleanup only
 * reports what it would remove (`db-maintenance-routes.js`).
 */
export const OpenCodeStorageSettingsView: React.FC<OpenCodeStorageSettingsViewProps> = ({
  status,
  loading,
  error,
  dryRun,
  busy,
  onDryRun,
}) => {
  const { t } = useI18n();
  const usable = Boolean(status?.exists && status.schema === 'ok');
  // The server recognised a native OpenCode 2 database: nothing to maintain.
  const nativeV2 = Boolean(status?.exists && status.generation === 2 && status.error === 'v2_database');

  let summary: string;
  if (!status) {
    summary = loading || !error
      ? t('settings.openchamber.storage.loading')
      : t('settings.openchamber.storage.unavailable', { error });
  } else if (!status.exists) {
    summary = t('settings.openchamber.storage.missing');
  } else if (nativeV2) {
    summary = t('settings.openchamber.storage.v2.summary', {
      size: formatBytes(status.dbBytes),
      wal: formatBytes(status.walBytes),
    });
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
        </div>
      </div>
      <p className="typography-meta text-muted-foreground">{summary}</p>
      {nativeV2 && (
        <p className="typography-meta text-muted-foreground">{t('settings.openchamber.storage.v2.notNeeded')}</p>
      )}
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
      {status && error && (
        <p className="typography-meta text-destructive">{error}</p>
      )}
    </div>
  );
};

/**
 * Settings → Data Retention → OpenCode Storage. Rendered only when the
 * runtime's diagnostics API exposes the storage members (web/Electron).
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

  if (!available) return null;

  return (
    <OpenCodeStorageSettingsView
      status={status}
      loading={loading}
      error={error}
      dryRun={dryRun}
      busy={busy}
      onDryRun={() => { void runDryRun(); }}
    />
  );
};
