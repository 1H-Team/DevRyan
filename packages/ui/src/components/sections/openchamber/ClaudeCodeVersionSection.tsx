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
const phases = ['idle', 'downloading', 'checking', 'waiting-for-idle', 'activating', 'restarting', 'failed'] as const;
type Phase = typeof phases[number];
interface UpdateStatus { supported: boolean; phase: Phase; revision: number; busy: boolean; held: boolean; rollbackAvailable: boolean; restartRequired: boolean }
function parseStatus(value: unknown): UpdateStatus {
  if (!record(value) || typeof value.supported !== 'boolean' || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)
    || value.revision < 1 || typeof value.busy !== 'boolean' || typeof value.held !== 'boolean'
    || typeof value.rollbackAvailable !== 'boolean' || typeof value.restartRequired !== 'boolean') throw new Error('status');
  const phase = phases.find(phase => phase === value.phase);
  if (!phase) throw new Error('status');
  return { supported: value.supported, phase, revision: value.revision, busy: value.busy, held: value.held,
    rollbackAvailable: value.rollbackAvailable, restartRequired: value.restartRequired };
}
const phaseMessages = {
  idle: 'settings.openchamber.about.claude.managed',
  downloading: 'settings.openchamber.about.claude.downloading',
  checking: 'settings.openchamber.about.claude.checking',
  'waiting-for-idle': 'settings.openchamber.about.claude.waiting',
  activating: 'settings.openchamber.about.claude.activating',
  restarting: 'settings.openchamber.about.claude.restarting',
  failed: 'settings.openchamber.about.claude.failed',
} as const;

export function ClaudeCodeVersionSection({ compact = false, onCheckAppUpdates }: { compact?: boolean; onCheckAppUpdates: () => Promise<void> }) {
  const { t } = useI18n(), principal = useAuthPrincipal();
  const administrator = principal.role === 'admin' && principal.scope !== 'tunnel-bot';
  const [installed, setInstalled] = React.useState<string | null>(null), [latest, setLatest] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<UpdateStatus | null>(null);
  const [checking, setChecking] = React.useState(false), [failed, setFailed] = React.useState(false);
  const [mutating, setMutating] = React.useState(false), [updated, setUpdated] = React.useState(false);
  const active = React.useRef<AbortController | null>(null);
  const pending = React.useRef(false);
  const loadVersion = React.useCallback(async (signal: AbortSignal) => {
    const response = await fetch('/api/config/claude-resolution', { signal });
    if (!response.ok) throw new Error('resolution');
    const data: unknown = await response.json();
    if (!signal.aborted) setInstalled(record(data) && ['verified-native-bundle', 'verified-managed-installation'].includes(String(data.source)) && version(data.version) ? data.version : null);
  }, []);
  const loadStatus = React.useCallback(async (signal: AbortSignal) => {
    if (!administrator) return;
    const response = await fetch('/api/config/claude-update', { signal });
    if (!response.ok) throw new Error('status');
    const next = parseStatus(await response.json());
    if (signal.aborted) return;
    setStatus(next);
    if (next.busy || next.phase === 'restarting') pending.current = true;
    if (pending.current && !next.busy && next.phase === 'idle') {
      await loadVersion(signal);
      if (!signal.aborted) { pending.current = false; setUpdated(true); }
    }
  }, [administrator, loadVersion]);
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller; pending.current = false;
    setInstalled(null); setLatest(null); setStatus(null); setFailed(false); setUpdated(false); setChecking(false); setMutating(false);
    void loadVersion(controller.signal).catch(() => {});
    void loadStatus(controller.signal).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (active.current === controller) active.current = null; };
  }, [principal.id, principal.role, principal.scope, loadVersion, loadStatus]);
  React.useEffect(() => {
    if (!status?.busy && status?.phase !== 'restarting') return;
    const controller = active.current;
    let reading = false;
    const timer = setInterval(() => {
      if (!controller || controller.signal.aborted || reading) return;
      reading = true;
      void loadStatus(controller.signal).catch(() => {}).finally(() => { reading = false; });
    }, 1500);
    return () => clearInterval(timer);
  }, [status?.busy, status?.phase, loadStatus]);
  const busy = checking || mutating || status?.busy === true || status?.restartRequired === true;
  const check = async () => {
    const signal = active.current?.signal; if (!signal || signal.aborted || busy) return;
    setChecking(true); setFailed(false); setLatest(null);
    try {
      await Promise.all([loadVersion(signal), loadStatus(signal)]);
      const response = await fetch('/api/config/claude-update-check', { signal });
      const data: unknown = response.ok ? await response.json() : null;
      if (!record(data) || !version(data.latestVersion)) throw new Error('metadata');
      if (!signal.aborted) setLatest(data.latestVersion);
    } catch { if (!signal.aborted) setFailed(true); }
    finally { if (!signal.aborted) setChecking(false); }
  };
  const transition = async (action: 'install' | 'rollback') => {
    const signal = active.current?.signal;
    if (!signal || signal.aborted || busy || !status?.supported || !administrator) return;
    setMutating(true); setFailed(false); setUpdated(false); pending.current = true;
    try {
      const response = await fetch(`/api/config/claude-update/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-devryan-csrf': '1' },
        body: JSON.stringify({ expectedRevision: status.revision }), signal });
      if (!response.ok) throw new Error('update');
      const next = parseStatus(await response.json()); if (!signal.aborted) setStatus(next);
    } catch {
      if (!signal.aborted) { pending.current = false; setFailed(true); setStatus(null); }
    } finally { if (!signal.aborted) setMutating(false); }
  };
  const comparison = compareUpstreamVersion(installed, latest);
  const message = comparison === 'update-available' ? 'settings.openchamber.about.claude.newer'
    : comparison === 'up-to-date' ? 'settings.openchamber.about.claude.current' : 'settings.openchamber.about.claude.latest';
  return <section className={cn('border-t border-[var(--surface-subtle)]', compact ? 'mt-3 pt-3' : 'px-4 py-4')} aria-labelledby="about-claude-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h4 id="about-claude-title" className={compact ? 'typography-meta font-medium' : 'typography-ui-label'}>{t('settings.openchamber.about.claude.title')}</h4>
      <Button size="xs" variant="outline" disabled={busy} aria-label={t('settings.openchamber.about.claude.checkLabel')} onClick={() => void check()}>
        {checking ? <RiLoaderLine className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
        {t(checking ? 'settings.openchamber.about.opencode.actions.checkingUpdates' : 'settings.openchamber.about.opencode.actions.checkUpdates')}
      </Button>
    </div>
    <p className="mt-2 font-mono typography-meta">{installed ?? t('settings.openchamber.about.opencode.state.unknown')}</p>
    <p className="mt-1 typography-micro text-muted-foreground">{t(installed ? 'settings.openchamber.about.claude.managed' : 'settings.openchamber.about.claude.unavailable')}</p>
    <div role="status" aria-live="polite">
      {latest ? <p className="mt-2 typography-meta">{t(message, { version: latest })}</p> : null}
      {status && status.phase !== 'idle' ? <p className="mt-2 typography-meta">{t(phaseMessages[status.phase])}</p> : null}
      {updated ? <p className="mt-2 typography-meta">{t('settings.openchamber.about.claude.updated')}</p> : null}
      {failed ? <p className="mt-2 typography-meta text-[var(--status-error)]">{t('settings.openchamber.about.opencode.upstream.failed')}</p> : null}
    </div>
    {administrator && status?.supported && !status.held && comparison === 'update-available' ? <Button className="mt-2" size="xs" variant="outline" disabled={busy} onClick={() => void transition('install')}>{t('settings.openchamber.about.claude.update')}</Button> : null}
    {administrator && status?.rollbackAvailable ? <Button className="mt-2" size="xs" variant="outline" disabled={busy} onClick={() => void transition('rollback')}>{t('settings.openchamber.about.claude.rollback')}</Button> : null}
    {status?.restartRequired ? <Button className="mt-2" size="xs" variant="outline" onClick={() => window.location.reload()}>{t('settings.providers.runtimeUpdate.reload')}</Button> : null}
    {administrator && (status?.held || failed && !status) ? <BundledRuntimeUpdate disabled={busy} /> : null}
    {administrator && status?.supported === false ? <>
      <Button className="mt-2" size="xs" variant="outline" onClick={() => void onCheckAppUpdates().catch(() => setFailed(true))}>{t('settings.openchamber.about.claude.checkApp')}</Button>
      <BundledRuntimeUpdate disabled={checking} />
    </> : null}
  </section>;
}
