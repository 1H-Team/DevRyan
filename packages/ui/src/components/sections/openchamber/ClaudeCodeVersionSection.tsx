import React from 'react';
import { RiLoaderLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useAuthPrincipal } from '@/lib/authSession';
import { BundledRuntimeUpdate } from '../providers/BundledRuntimeUpdate';
import { compareUpstreamVersion } from './openCodeVersionState';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const version = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

export function ClaudeCodeVersionSection({ compact = false, onCheckAppUpdates }: { compact?: boolean; onCheckAppUpdates: () => Promise<void> }) {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const administrator = principal.role === 'admin' && principal.scope !== 'tunnel-bot';
  const [installed, setInstalled] = React.useState<string | null>(null);
  const [latest, setLatest] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [appChecking, setAppChecking] = React.useState(false);
  const [bundleBusy, setBundleBusy] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const request = React.useRef<AbortController | null>(null);
  const loadVersion = async (signal: AbortSignal) => {
    const response = await fetch('/api/config/claude-resolution', { signal });
    if (!response.ok) throw new Error('resolution');
    const data: unknown = await response.json();
    if (!signal.aborted) setInstalled(record(data) && data.source === 'verified-native-bundle' && version(data.version) ? data.version : null);
  };
  React.useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    setInstalled(null); setLatest(null); setFailed(false); setChecking(false); setAppChecking(false); setBundleBusy(false);
    void loadVersion(controller.signal).catch(() => { if (!controller.signal.aborted) setInstalled(null); });
    return () => { controller.abort(); request.current?.abort(); request.current = null; };
  }, [principal.id, principal.role, principal.scope]);
  const check = async () => {
    if (checking || bundleBusy || appChecking) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setChecking(true); setFailed(false); setLatest(null);
    try {
      await loadVersion(controller.signal);
      const response = await fetch('/api/config/claude-update-check', { signal: controller.signal });
      const data: unknown = response.ok ? await response.json() : null;
      if (!record(data) || !version(data.latestVersion)) throw new Error('metadata');
      if (!controller.signal.aborted) setLatest(data.latestVersion);
    } catch { if (!controller.signal.aborted) setFailed(true); }
    finally {
      if (!controller.signal.aborted) { setChecking(false); setRefreshKey(key => key + 1); }
    }
  };
  const checkApp = async () => {
    if (appChecking || checking || bundleBusy) return;
    const signal = request.current?.signal;
    if (!signal || signal.aborted) return;
    setAppChecking(true); setFailed(false);
    try { await onCheckAppUpdates(); }
    catch { if (!signal.aborted) setFailed(true); }
    finally { if (!signal.aborted) setAppChecking(false); }
  };
  const comparison = compareUpstreamVersion(installed, latest);
  const message = comparison === 'update-available' ? 'settings.openchamber.about.claude.newer'
    : comparison === 'up-to-date' ? 'settings.openchamber.about.claude.current' : 'settings.openchamber.about.claude.latest';
  return <section className={cn('border-t border-[var(--surface-subtle)]', compact ? 'mt-3 pt-3' : 'px-4 py-4')} aria-labelledby="about-claude-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h4 id="about-claude-title" className={compact ? 'typography-meta font-medium' : 'typography-ui-label'}>{t('settings.openchamber.about.claude.title')}</h4>
      <Button size="xs" variant="outline" disabled={checking || appChecking || bundleBusy} aria-label={t('settings.openchamber.about.claude.checkLabel')} onClick={() => void check()}>
        {checking ? <RiLoaderLine className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
        {t(checking ? 'settings.openchamber.about.opencode.actions.checkingUpdates' : 'settings.openchamber.about.opencode.actions.checkUpdates')}
      </Button>
    </div>
    <p className="mt-2 font-mono typography-meta">{installed ?? t('settings.openchamber.about.opencode.state.unknown')}</p>
    <p className="mt-1 typography-micro text-muted-foreground">{t(installed ? 'settings.openchamber.about.claude.bundled' : 'settings.openchamber.about.claude.unavailable')}</p>
    <div role="status" aria-live="polite">
      {latest ? <p className="mt-2 typography-meta">{t(message, { version: latest })}</p> : null}
      {failed ? <p className="mt-2 typography-meta text-[var(--status-error)]">{t('settings.openchamber.about.opencode.upstream.failed')}</p> : null}
    </div>
    {administrator && latest && comparison !== 'up-to-date' ? <Button className="mt-2" size="xs" variant="outline" disabled={appChecking || checking || bundleBusy} onClick={() => void checkApp()}>{t('settings.openchamber.about.claude.checkApp')}</Button> : null}
    {installed ? <BundledRuntimeUpdate disabled={checking || appChecking} refreshKey={refreshKey} onBusyChange={setBundleBusy} /> : null}
  </section>;
}
