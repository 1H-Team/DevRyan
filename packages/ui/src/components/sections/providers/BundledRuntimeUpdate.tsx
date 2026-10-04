import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useAuthPrincipal } from '@/lib/authSession';

interface BundleStatus { revision: number; state: string; restartRequired: boolean; updateAvailable: boolean }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function parseStatus(value: unknown): BundleStatus {
  if (!record(value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.state !== 'string'
    || typeof value.selectedManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.selectedManifestSha256)
    || value.availableManifestSha256 !== undefined && (typeof value.availableManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.availableManifestSha256))) throw new Error('status');
  return { revision: value.revision, state: value.state, restartRequired: value.restartRequired === true,
    updateAvailable: value.state === 'upgrade_available' && typeof value.availableManifestSha256 === 'string' && value.availableManifestSha256 !== value.selectedManifestSha256 };
}

/** Shared setup control: reading availability never selects a runtime. */
export function BundledRuntimeUpdate() {
  const { t } = useI18n(), principal = useAuthPrincipal();
  const administrator = principal.role === 'admin' && principal.scope !== 'tunnel-bot';
  const [status, setStatus] = React.useState<BundleStatus | null>(null);
  const [busy, setBusy] = React.useState(false), [failed, setFailed] = React.useState(false);
  const active = React.useRef<AbortController | null>(null);
  const refresh = async () => {
    const controller = active.current; if (!controller || controller.signal.aborted || busy) return;
    setBusy(true); setFailed(false);
    try {
      const response = await fetch('/api/runtime/bundle', { signal: controller.signal });
      if (!response.ok) throw new Error('status');
      const data = parseStatus(await response.json()); if (active.current === controller && !controller.signal.aborted) setStatus(data);
    } catch { if (active.current === controller && !controller.signal.aborted) setFailed(true); }
    finally { if (active.current === controller && !controller.signal.aborted) setBusy(false); }
  };
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    setStatus(null); setFailed(false); setBusy(false);
    if (administrator) void fetch('/api/runtime/bundle', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('status');
      const data = parseStatus(await response.json()); if (!controller.signal.aborted) setStatus(data);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (active.current === controller) active.current = null; };
  }, [administrator, principal.id]);
  const apply = async () => {
    if (!status?.updateAvailable || busy) return;
    const signal = active.current?.signal; if (!signal || signal.aborted) return;
    setBusy(true); setFailed(false);
    try {
      const response = await fetch('/api/runtime/bundle/upgrade', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-devryan-csrf': '1' }, body: JSON.stringify({ expectedRevision: status.revision }), signal });
      if (!response.ok) throw new Error('apply');
      const data = parseStatus(await response.json()); if (!signal.aborted) setStatus(data);
    } catch { if (!signal.aborted) setFailed(true); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  if (!administrator || !status?.updateAvailable && !status?.restartRequired && !failed) return null;
  return <section className="mx-3 my-2 space-y-2 rounded-md border p-3 sm:mx-6">
    <p className="typography-ui-label">{t('settings.providers.runtimeUpdate.title')}</p>
    <p className="typography-meta text-muted-foreground">{t(status?.restartRequired ? 'settings.providers.runtimeUpdate.restarting' : 'settings.providers.runtimeUpdate.description')}</p>
    {status?.updateAvailable ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void apply()}>{t('settings.providers.runtimeUpdate.apply')}</Button> : null}
    {status?.restartRequired ? <Button size="xs" variant="outline" onClick={() => window.location.reload()}>{t('settings.providers.runtimeUpdate.reload')}</Button> : null}
    {failed ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('settings.providers.page.actions.refresh')}</Button> : null}
    {failed ? <p role="alert" className="typography-meta text-[var(--status-error)]">{t('settings.providers.runtimeUpdate.failed')}</p> : null}
  </section>;
}
