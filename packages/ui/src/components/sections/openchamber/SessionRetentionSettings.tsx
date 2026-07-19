import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiInformationLine, RiRestartLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useI18n } from '@/lib/i18n';
import { clearDesktopCache, getDesktopCacheInfo, isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import { formatCacheSize } from './applicationCache';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_ACTION_OPTIONS = [
  { value: 'archive', labelKey: 'settings.openchamber.sessionRetention.action.archive' },
  { value: 'delete', labelKey: 'settings.openchamber.sessionRetention.action.delete' },
] as const;

type CacheSizeStatus = 'loading' | 'ready' | 'unavailable';

const ApplicationCacheCleanup: React.FC = () => {
  const { t } = useI18n();
  const isAvailable = isElectronShell() && isDesktopLocalOriginActive();
  const [sizeBytes, setSizeBytes] = React.useState(0);
  const [sizeStatus, setSizeStatus] = React.useState<CacheSizeStatus>('loading');
  const [isClearing, setIsClearing] = React.useState(false);

  React.useEffect(() => {
    if (!isAvailable) return;

    let isActive = true;
    void getDesktopCacheInfo()
      .then((info) => {
        if (!isActive) return;
        if (!info) {
          setSizeStatus('unavailable');
          return;
        }
        setSizeBytes(info.sizeBytes);
        setSizeStatus('ready');
      })
      .catch((error) => {
        console.warn('Failed to load application cache size', error);
        if (isActive) setSizeStatus('unavailable');
      });

    return () => {
      isActive = false;
    };
  }, [isAvailable]);

  const handleClearCache = React.useCallback(async () => {
    setIsClearing(true);
    try {
      const info = await clearDesktopCache();
      if (!info) {
        setSizeStatus('unavailable');
        toast.error(t('settings.openchamber.sessionRetention.applicationCache.toast.clearFailed'));
        return;
      }
      setSizeBytes(info.sizeBytes);
      setSizeStatus('ready');
      toast.success(t('settings.openchamber.sessionRetention.applicationCache.toast.cleared'));
    } catch (error) {
      console.warn('Failed to clear application cache', error);
      setSizeStatus('unavailable');
      toast.error(t('settings.openchamber.sessionRetention.applicationCache.toast.clearFailed'));
    } finally {
      setIsClearing(false);
    }
  }, [t]);

  if (!isAvailable) return null;

  let sizeLabel: string;
  if (sizeStatus === 'loading') {
    sizeLabel = t('settings.openchamber.sessionRetention.applicationCache.state.loadingSize');
  } else if (sizeStatus === 'unavailable') {
    sizeLabel = t('settings.openchamber.sessionRetention.applicationCache.state.sizeUnavailable');
  } else {
    sizeLabel = t('settings.openchamber.sessionRetention.applicationCache.state.size', {
      size: formatCacheSize(sizeBytes),
    });
  }

  return (
    <div className="pt-2 space-y-1">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
        <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
          <p className="typography-meta text-foreground font-medium">
            {t('settings.openchamber.sessionRetention.applicationCache.title')}
          </p>
        </div>
        <div className="flex items-center gap-2 sm:w-fit">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleClearCache}
            disabled={isClearing}
            className="!font-normal normal-case"
          >
            {isClearing
              ? t('settings.openchamber.sessionRetention.applicationCache.actions.clearing')
              : t('settings.openchamber.sessionRetention.applicationCache.actions.clear')}
          </Button>
        </div>
      </div>
      <p className="typography-meta text-muted-foreground">{sizeLabel}</p>
    </div>
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
        <ApplicationCacheCleanup />
      </div>
    </div>
  );
};
