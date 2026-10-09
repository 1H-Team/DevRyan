import * as React from 'react';
import { RiArrowUpCircleLine, RiLoaderLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { compareUpstreamVersion, parseBundledRuntimeVersion, parseLatestUpstreamVersion, type BundledRuntimeVersion } from './openCodeVersionState';

type UpstreamCheck = { phase: 'idle' } | { phase: 'checking' } | { phase: 'failed' } | { phase: 'done'; latestVersion: string };

export const OpenCodeVersionSection: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useI18n();
  const [runtime, setRuntime] = React.useState<BundledRuntimeVersion | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [upstream, setUpstream] = React.useState<UpstreamCheck>({ phase: 'idle' });
  const current = React.useRef<AbortController | null>(null);
  const upstreamRequest = React.useRef<AbortController | null>(null);
  const refresh = React.useCallback(async () => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setChecking(true); setError(false);
    try {
      const response = await fetch('/api/config/opencode-resolution', { headers: { Accept: 'application/json' }, signal: controller.signal });
      const value = response.ok ? parseBundledRuntimeVersion(await response.json()) : null;
      if (controller.signal.aborted) return;
      setRuntime(value); setError(!value);
    } catch { if (!controller.signal.aborted) { setRuntime(null); setError(true); } }
    finally { if (!controller.signal.aborted) setChecking(false); }
  }, []);
  // Upstream release metadata is fetched only on an explicit click.
  const checkForUpdates = React.useCallback(async () => {
    upstreamRequest.current?.abort();
    const controller = new AbortController(); upstreamRequest.current = controller;
    setUpstream({ phase: 'checking' });
    try {
      const response = await fetch('/api/config/opencode-update-check', { headers: { Accept: 'application/json' }, signal: controller.signal });
      const latestVersion = response.ok ? parseLatestUpstreamVersion(await response.json()) : null;
      if (controller.signal.aborted) return;
      setUpstream(latestVersion ? { phase: 'done', latestVersion } : { phase: 'failed' });
    } catch { if (!controller.signal.aborted) setUpstream({ phase: 'failed' }); }
  }, []);
  React.useEffect(() => { void refresh(); return () => current.current?.abort(); }, [refresh]);
  React.useEffect(() => () => upstreamRequest.current?.abort(), []);
  const upstreamChecking = upstream.phase === 'checking';
  let upstreamMessage: string | null = null;
  if (upstream.phase === 'failed') upstreamMessage = t('settings.openchamber.about.opencode.upstream.failed');
  if (upstream.phase === 'done') {
    const comparison = compareUpstreamVersion(runtime?.version, upstream.latestVersion);
    upstreamMessage = comparison === 'update-available'
      ? t('settings.openchamber.about.opencode.upstream.updateAvailable', { version: upstream.latestVersion })
      : comparison === 'up-to-date'
        ? t('settings.openchamber.about.opencode.upstream.upToDate', { version: upstream.latestVersion })
        : t('settings.openchamber.about.opencode.upstream.latest', { version: upstream.latestVersion });
  }
  return (
    <section className={cn('border-t border-[var(--surface-subtle)]', compact ? 'mt-3 pt-3' : 'px-4 py-4')} aria-labelledby="about-opencode-version-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 id="about-opencode-version-title" className={compact ? 'typography-meta font-medium' : 'typography-ui-label'}>{t('settings.openchamber.about.opencode.title')}</h4>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="xs" disabled={checking} onClick={() => { void refresh(); }}>
            <RiRefreshLine className={cn('mr-1 h-3.5 w-3.5', checking && 'animate-spin')} aria-hidden="true" />{t('settings.openchamber.about.opencode.actions.retry')}
          </Button>
          <Button type="button" variant="outline" size="xs" disabled={upstreamChecking} aria-label={t('settings.openchamber.about.opencode.actions.checkUpdatesLabel')} onClick={() => { void checkForUpdates(); }}>
            {upstreamChecking
              ? <RiLoaderLine className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              : <RiArrowUpCircleLine className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
            {t(upstreamChecking ? 'settings.openchamber.about.opencode.actions.checkingUpdates' : 'settings.openchamber.about.opencode.actions.checkUpdates')}
          </Button>
        </div>
      </div>
      <p className="mt-2 font-mono typography-meta">{runtime?.version ?? t('settings.openchamber.about.opencode.state.unknown')}</p>
      <p className="mt-1 typography-micro text-muted-foreground" role="status">{error ? t('settings.openchamber.about.opencode.error.loadFailed') : runtime?.ready ? t('settings.openchamber.about.opencode.state.ready') : t('settings.openchamber.about.opencode.state.unavailable')}</p>
      <div role="status" aria-live="polite">
        {upstreamMessage ? (
          <p className={cn('mt-2 typography-meta', upstream.phase === 'failed' ? 'text-[var(--status-error)]' : 'text-foreground')}>{upstreamMessage}</p>
        ) : null}
        {upstream.phase === 'done' ? <p className="mt-1 typography-micro text-muted-foreground">{t('settings.openchamber.about.opencode.upstream.note')}</p> : null}
      </div>
      <p className="mt-1 typography-micro text-muted-foreground">{t('settings.openchamber.about.opencode.bundledUpdates')}</p>
    </section>
  );
};
