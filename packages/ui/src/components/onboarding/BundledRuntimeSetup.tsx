import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { useUpdateStore } from '@/stores/useUpdateStore';

/** Existing native readiness and DevRyan updater; no independent runtime installer. */
export function BundledRuntimeSetup({ onAvailable }: { onAvailable?: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [checking, setChecking] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const retryActive = React.useRef(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const [failure, setFailure] = React.useState(false);
  const [updateOpen, setUpdateOpen] = React.useState(false);
  const updates = useUpdateStore(useShallow(s => ({ checking: s.checking, available: s.available, info: s.info, downloading: s.downloading, downloaded: s.downloaded, progress: s.progress, error: s.error, runtimeType: s.runtimeType, check: s.checkForUpdates, download: s.downloadUpdate, restart: s.restartToUpdate })));
  const mounted = React.useRef(true);
  const completed = React.useRef(false);
  const pending = React.useRef<Promise<void> | null>(null);
  const check = React.useCallback(() => {
    if (pending.current) return pending.current;
    const work = (async () => {
      if (mounted.current) {
        setChecking(true);
        setFailure(false);
      }
      try {
        const ready = await opencodeClient.checkHealth();
        if (!mounted.current) return;
        setUnavailable(!ready);
        if (ready && !completed.current) {
          completed.current = true;
          await onAvailable?.();
        }
      } catch {
        completed.current = false;
        if (mounted.current) setFailure(true);
      } finally {
        if (mounted.current) setChecking(false);
      }
    })();
    pending.current = work;
    void work.finally(() => { if (pending.current === work) pending.current = null; }).catch(() => {});
    return work;
  }, [onAvailable]);
  React.useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const tick = async () => {
      await check().catch(() => {});
      if (!cancelled && !completed.current) timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      cancelled = true;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [check]);
  return <div className="space-y-3">
    <p className="typography-body text-muted-foreground">{t('onboarding.localSetup.description')}</p>
    <p className="typography-meta text-muted-foreground" role="status">{t(unavailable ? 'onboarding.localSetup.errors.cliNotReady' : 'onboarding.localSetup.status.watching')}</p>
    {failure && <p role="alert" className="typography-meta text-[var(--status-error)]">{t('onboarding.localSetup.errors.selectionFailed')}</p>}
    <Button disabled={checking || retrying} onClick={() => {
      if (retryActive.current) return;
      retryActive.current = true;
      setRetrying(true);
      void (async () => {
        setChecking(true);
        try {
          const response = await fetch('/api/config/reload', { method: 'POST', signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new Error('reload_failed');
          await check();
        } catch {
          if (mounted.current) { setFailure(true); setChecking(false); }
        } finally {
          retryActive.current = false;
          if (mounted.current) setRetrying(false);
        }
      })();
    }}>{t(checking ? 'onboarding.localSetup.actions.checking' : 'onboarding.localSetup.actions.checkAndContinue')}</Button>
    <p className="typography-micro text-muted-foreground">{t('settings.openchamber.about.opencode.bundledUpdates')}</p>
    <Button variant="outline" disabled={updates.checking} onClick={() => {
      if (updates.available) setUpdateOpen(true);
      else void updates.check().then(() => { if (mounted.current) setUpdateOpen(true); }).catch(() => {});
    }}>{t(updates.available ? 'settings.openchamber.about.actions.update' : 'settings.openchamber.about.actions.checkUpdates')}</Button>
    {updates.error && <p role="alert" className="typography-meta text-[var(--status-error)]">{updates.error}</p>}
    <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} info={updates.info} downloading={updates.downloading} downloaded={updates.downloaded} progress={updates.progress} error={updates.error} onDownload={updates.download} onRestart={updates.restart} runtimeType={updates.runtimeType} />
  </div>;
}
