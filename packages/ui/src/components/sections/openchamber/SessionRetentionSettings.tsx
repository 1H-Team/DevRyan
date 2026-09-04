import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiDeleteBinLine, RiDownloadLine, RiInformationLine, RiLoaderLine, RiRestartLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useI18n } from '@/lib/i18n';
import { clearDesktopCache, getDesktopCacheInfo, isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import { formatBytes } from '@/lib/formatBytes';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { DiagnosticsClearRange, DiagnosticsStatus } from '@/lib/api/types';
import { OpenCodeStorageSettings } from './OpenCodeStorageSettings';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_ACTION_OPTIONS = [
  { value: 'archive', labelKey: 'settings.openchamber.sessionRetention.action.archive' },
  { value: 'delete', labelKey: 'settings.openchamber.sessionRetention.action.delete' },
] as const;
const DIAGNOSTIC_CLEAR_RANGE_OPTIONS = [
  { value: '24h', labelKey: 'settings.openchamber.about.diagnostics.clearRange.24h' },
  { value: '7d', labelKey: 'settings.openchamber.about.diagnostics.clearRange.7d' },
  { value: '14d', labelKey: 'settings.openchamber.about.diagnostics.clearRange.14d' },
  { value: 'all', labelKey: 'settings.openchamber.about.diagnostics.clearRange.all' },
] as const satisfies ReadonlyArray<{ value: DiagnosticsClearRange; labelKey: string }>;

type CacheSizeStatus = 'loading' | 'ready' | 'unavailable';

const DiagnosticDataCleanup: React.FC = () => {
  const { t } = useI18n();
  const { diagnostics } = useRuntimeAPIs();
  const hasDesktopCache = isElectronShell() && isDesktopLocalOriginActive();
  const [status, setStatus] = React.useState<DiagnosticsStatus | null>(null);
  const [cacheSizeBytes, setCacheSizeBytes] = React.useState(0);
  const [cacheSizeStatus, setCacheSizeStatus] = React.useState<CacheSizeStatus>('loading');
  const [exporting, setExporting] = React.useState(false);
  const [clearOpen, setClearOpen] = React.useState(false);
  const [clearRange, setClearRange] = React.useState<DiagnosticsClearRange>('24h');
  const [clearing, setClearing] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (!diagnostics) return;
    void diagnostics.getStatus()
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [diagnostics]);

  React.useEffect(() => {
    if (!hasDesktopCache) return;
    let cancelled = false;
    void getDesktopCacheInfo()
      .then((info) => {
        if (cancelled) return;
        if (!info) {
          setCacheSizeStatus('unavailable');
          return;
        }
        setCacheSizeBytes(info.sizeBytes);
        setCacheSizeStatus('ready');
      })
      .catch((error) => {
        console.warn('Failed to load application cache size', error);
        if (!cancelled) setCacheSizeStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [hasDesktopCache]);

  const exportDiagnostics = React.useCallback(async () => {
    if (!diagnostics || exporting) return;
    setExporting(true);
    try {
      const result = await diagnostics.export({ scope: 'runtime' });
      if (!result.cancelled) {
        toast.success(t('settings.openchamber.about.diagnostics.exported', { fileName: result.fileName }));
      }
    } catch (error) {
      toast.error(t('settings.openchamber.about.diagnostics.failed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setExporting(false);
    }
  }, [diagnostics, exporting, t]);

  const clearDiagnosticData = React.useCallback(async () => {
    if (!diagnostics || clearing) return;
    setClearing(true);
    try {
      await diagnostics.clear(clearRange);
      let cacheClearFailed = false;
      const shouldClearDesktopCache = hasDesktopCache && clearRange === 'all';
      if (shouldClearDesktopCache) {
        try {
          const clearedCache = await clearDesktopCache();
          if (!clearedCache) throw new Error('Application cache cleanup is unavailable');
        } catch (error) {
          cacheClearFailed = true;
          console.warn('Failed to clear application cache', error);
        }
      }

      const refreshedStatus = await diagnostics.getStatus();
      setStatus(refreshedStatus);
      if (shouldClearDesktopCache) {
        try {
          const cacheInfo = await getDesktopCacheInfo();
          if (!cacheInfo) throw new Error('Application cache size is unavailable');
          setCacheSizeBytes(cacheInfo.sizeBytes);
          setCacheSizeStatus('ready');
        } catch (error) {
          cacheClearFailed = true;
          setCacheSizeStatus('unavailable');
          console.warn('Failed to refresh application cache size', error);
        }
      }
      setClearOpen(false);
      if (cacheClearFailed) {
        toast.error(t('settings.openchamber.about.diagnostics.clearPartialFailed'));
      } else {
        toast.success(t('settings.openchamber.about.diagnostics.cleared'));
      }
    } catch (error) {
      toast.error(t('settings.openchamber.about.diagnostics.clearFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setClearing(false);
    }
  }, [clearRange, clearing, diagnostics, hasDesktopCache, t]);

  if (!diagnostics) return null;

  let cacheStatusLabel = '';
  if (cacheSizeStatus === 'loading') {
    cacheStatusLabel = t('settings.openchamber.about.diagnostics.cacheLoading');
  } else if (cacheSizeStatus === 'unavailable') {
    cacheStatusLabel = t('settings.openchamber.about.diagnostics.cacheUnavailable');
  } else {
    cacheStatusLabel = t('settings.openchamber.about.diagnostics.cacheLine', {
      size: formatBytes(cacheSizeBytes),
    });
  }

  return (
    <>
      <div className="border-t border-border/40 pt-3 space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <p className="typography-meta text-foreground font-medium">
              {t('settings.openchamber.about.diagnostics.title')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:w-fit">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => { void exportDiagnostics(); }}
              disabled={exporting || clearing}
              className="!font-normal normal-case"
            >
              {exporting
                ? <RiLoaderLine className="mr-1 h-3.5 w-3.5 animate-spin" />
                : <RiDownloadLine className="mr-1 h-3.5 w-3.5" />}
              {t('settings.openchamber.about.diagnostics.export')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setClearOpen(true)}
              disabled={exporting || clearing}
              className="!font-normal normal-case"
            >
              <RiDeleteBinLine className="mr-1 h-3.5 w-3.5" />
              {t('settings.openchamber.about.diagnostics.clearLogs')}
            </Button>
          </div>
        </div>
        <p className="typography-meta text-muted-foreground">
          {status
            ? t('settings.openchamber.about.diagnostics.health', {
                size: formatBytes(status.diskBytes),
                sessions: status.sessionCount,
              })
            : t('settings.openchamber.about.diagnostics.collecting')}
        </p>
        {hasDesktopCache && (
          <p className="typography-meta text-muted-foreground">
            {cacheStatusLabel}
          </p>
        )}
      </div>

      <Dialog open={clearOpen} onOpenChange={(open) => { if (!clearing) setClearOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.openchamber.about.diagnostics.clearDialog.title')}</DialogTitle>
            <DialogDescription>
              {t(hasDesktopCache && clearRange === 'all'
                ? 'settings.openchamber.about.diagnostics.clearDialog.descriptionDesktop'
                : 'settings.openchamber.about.diagnostics.clearDialog.description', {
                  range: t(DIAGNOSTIC_CLEAR_RANGE_OPTIONS.find((option) => option.value === clearRange)?.labelKey
                    ?? 'settings.openchamber.about.diagnostics.clearRange.all'),
                })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <p className="typography-ui-label text-foreground">
              {t('settings.openchamber.about.diagnostics.clearDialog.rangeLabel')}
            </p>
            <Select<DiagnosticsClearRange>
              value={clearRange}
              onValueChange={setClearRange}
              disabled={clearing}
            >
              <SelectTrigger
                className="w-full"
                aria-label={t('settings.openchamber.about.diagnostics.clearDialog.rangeAria')}
              >
                <SelectValue>
                  {t(DIAGNOSTIC_CLEAR_RANGE_OPTIONS.find((option) => option.value === clearRange)?.labelKey
                    ?? 'settings.openchamber.about.diagnostics.clearRange.all')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DIAGNOSTIC_CLEAR_RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)} disabled={clearing}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => { void clearDiagnosticData(); }} disabled={clearing}>
              {clearing
                ? t('settings.openchamber.about.diagnostics.clearing')
                : t('settings.openchamber.about.diagnostics.clearLogs')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const SessionRetentionSettings: React.FC = () => {
  const { t } = useI18n();
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const setAutoDeleteEnabled = useUIStore((state) => state.setAutoDeleteEnabled);
  const setAutoDeleteAfterDays = useUIStore((state) => state.setAutoDeleteAfterDays);
  const setSessionRetentionAction = useUIStore((state) => state.setSessionRetentionAction);

  const { candidates, isRunning, runCleanup, action } = useSessionAutoCleanup({ autoRun: false });
  const pendingCount = candidates.length;

  const handleRunCleanup = React.useCallback(async () => {
    const result = await runCleanup({ force: true });

    if (result.completedIds.length === 0 && result.failedIds.length === 0) {
      toast.message(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.noneEligibleArchive')
          : t('settings.openchamber.sessionRetention.toast.noneEligibleDelete')
      );
      return;
    }
    if (result.completedIds.length > 0) {
      toast.success(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.archivedCount', { count: result.completedIds.length })
          : t('settings.openchamber.sessionRetention.toast.deletedCount', { count: result.completedIds.length })
      );
    }
    if (result.failedIds.length > 0) {
      toast.error(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.failedArchiveCount', { count: result.failedIds.length })
          : t('settings.openchamber.sessionRetention.toast.failedDeleteCount', { count: result.failedIds.length })
      );
    }
  }, [runCleanup, t]);

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">
            {t('settings.openchamber.sessionRetention.title')}
          </h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              {t('settings.openchamber.sessionRetention.tooltip')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0.5">
        <div
          className="group flex cursor-pointer items-center gap-2 py-1.5"
          role="button"
          tabIndex={0}
          aria-pressed={autoDeleteEnabled}
          onClick={() => setAutoDeleteEnabled(!autoDeleteEnabled)}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              setAutoDeleteEnabled(!autoDeleteEnabled);
            }
          }}
        >
          <Checkbox
            checked={autoDeleteEnabled}
            onChange={setAutoDeleteEnabled}
            ariaLabel={t('settings.openchamber.sessionRetention.field.enableAutoCleanupAria')}
          />
          <span className="typography-ui-label text-foreground">{t('settings.openchamber.sessionRetention.field.enableAutoCleanup')}</span>
        </div>

        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.sessionRetention.field.retentionPeriod')}</span>
          </div>
          <div className="flex items-center gap-2 sm:w-fit">
            <NumberInput
              value={autoDeleteAfterDays}
              onValueChange={setAutoDeleteAfterDays}
              min={MIN_DAYS}
              max={MAX_DAYS}
              step={1}
              aria-label={t('settings.openchamber.sessionRetention.field.retentionPeriodAria')}
              className="w-20 tabular-nums"
            />
            <span className="typography-ui-label text-muted-foreground">{t('settings.openchamber.sessionRetention.field.days')}</span>
            <Button size="sm"
              type="button"
              variant="ghost"
              onClick={() => setAutoDeleteAfterDays(DEFAULT_RETENTION_DAYS)}
              disabled={autoDeleteAfterDays === DEFAULT_RETENTION_DAYS}
              className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
              aria-label={t('settings.openchamber.sessionRetention.actions.resetRetentionAria')}
              title={t('settings.common.actions.reset')}
            >
              <RiRestartLine className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.sessionRetention.field.whenSessionsExpire')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1 sm:w-fit">
            {RETENTION_ACTION_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="chip"
                size="xs"
                aria-pressed={sessionRetentionAction === option.value}
                className="!font-normal"
                onClick={() => setSessionRetentionAction(option.value)}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <div className="mt-1 px-2 py-1.5 space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <p className="typography-meta text-foreground font-medium">{t('settings.openchamber.sessionRetention.manualCleanup.title')}</p>
          </div>
          <div className="flex items-center gap-2 sm:w-fit">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleRunCleanup}
              disabled={isRunning}
              className="!font-normal normal-case"
            >
              {isRunning ? t('settings.openchamber.sessionRetention.actions.cleaningUp') : t('settings.openchamber.sessionRetention.actions.runCleanupNow')}
            </Button>
          </div>
        </div>
        <p className="typography-meta text-muted-foreground">
          {action === 'archive'
            ? t('settings.openchamber.sessionRetention.manualCleanup.eligibleArchiveNow', { count: pendingCount })
            : t('settings.openchamber.sessionRetention.manualCleanup.eligibleDeleteNow', { count: pendingCount })}
        </p>
        <DiagnosticDataCleanup />
        <OpenCodeStorageSettings />
      </div>
    </div>
  );
};
