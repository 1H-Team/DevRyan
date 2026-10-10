import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { openExternalUrl } from '@/lib/url';
import { quotaRefreshCoordinator, useQuotaStore } from '@/stores/useQuotaStore';
import { UsageSourceDetails } from '@/components/layout/usage/UsageSourceDetails';

interface ConnectionStatus {
  available: boolean;
  configured: boolean;
  source: 'codex-app-server';
  connectionId: string | null;
  account: { email: string | null; planType: string | null } | null;
  login: { flowId: string; status: 'pending' | 'approved' | 'failed' | 'expired' | 'cancelled'; expiresAt: number;
    verificationUrl?: string; userCode?: string; authUrl?: string } | null;
  error?: string;
}
const endpoint = '/api/quota/codex/connection';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const localOrigin = () => {
  if (isDesktopLocalOriginActive()) return true;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(window.location.origin).hostname); }
  catch { return false; }
};
const signInUrl = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (!text(value)) throw new Error('response');
  const url = new URL(value);
  if (!['https://auth.openai.com', 'https://chatgpt.com', 'https://auth0.openai.com'].includes(url.origin) || url.username || url.password) throw new Error('response');
  return url.toString();
};
async function readStatus(path: string, init: RequestInit): Promise<ConnectionStatus> {
  const response = await fetch(`${endpoint}${path}`, init);
  const data: unknown = await response.json();
  if (!response.ok || !record(data) || typeof data.available !== 'boolean' || typeof data.configured !== 'boolean'
    || data.source !== 'codex-app-server' || !nullableText(data.connectionId)) throw new Error('response');
  let account: ConnectionStatus['account'] = null, login: ConnectionStatus['login'] = null;
  if (data.account !== null) {
    if (!record(data.account) || !nullableText(data.account.email) || !nullableText(data.account.planType)) throw new Error('response');
    account = { email: data.account.email, planType: data.account.planType };
  }
  if (data.login !== null) {
    const row = data.login;
    if (!record(row) || !text(row.flowId) || !['pending', 'approved', 'failed', 'expired', 'cancelled'].includes(String(row.status))
      || typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)
      || row.userCode !== undefined && !text(row.userCode)) throw new Error('response');
    const status = row.status;
    if (status !== 'pending' && status !== 'approved' && status !== 'failed' && status !== 'expired' && status !== 'cancelled') throw new Error('response');
    login = { flowId: row.flowId, status, expiresAt: row.expiresAt, verificationUrl: signInUrl(row.verificationUrl),
      authUrl: signInUrl(row.authUrl), userCode: typeof row.userCode === 'string' ? row.userCode : undefined };
  }
  if (data.configured && !data.connectionId) throw new Error('response');
  return { available: data.available, configured: data.configured, source: data.source, connectionId: data.connectionId, account, login,
    error: typeof data.error === 'string' ? data.error : undefined };
}

export function CodexUsageConnection({ administrator, principalID }: { administrator: boolean; principalID: string }) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<ConnectionStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const active = React.useRef<AbortController | null>(null);
  const pending = React.useRef<string | null>(null);
  const operation = React.useRef(0);
  const isLocal = localOrigin();
  const applyStatus = React.useCallback((next: ConnectionStatus) => {
    const quota = useQuotaStore.getState().results.find(result => result.providerId === 'codex');
    const changed = Boolean(quota && ((next.configured && (quota.source !== next.source || quota.connectionId !== next.connectionId || quota.account?.email !== next.account?.email))
      || (!next.configured && quota.source === next.source)));
    if (changed) useQuotaStore.getState().invalidateProviderQuota('codex');
    pending.current = next.login?.status === 'pending' ? next.login.flowId : null;
    setFailed(false);
    setStatus(next);
    return changed;
  }, []);
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    const revision = ++operation.current;
    setStatus(null); setBusy(false); setFailed(false);
    if (administrator && isLocal) void readStatus('', { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted && operation.current === revision && applyStatus(next)) void quotaRefreshCoordinator.refreshNow({ forceRefresh: true, rediscover: true }).catch(() => {});
    }).catch(() => { if (!controller.signal.aborted && operation.current === revision) setFailed(true); });
    return () => {
      controller.abort(); if (active.current === controller) active.current = null;
      const flowId = pending.current; pending.current = null;
      if (flowId) void fetch(`${endpoint}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-devryan-csrf': '1' },
        body: JSON.stringify({ flowId }), keepalive: true }).catch(() => {});
    };
  }, [administrator, principalID, isLocal, applyStatus]);
  React.useEffect(() => {
    if (status?.login?.status !== 'pending') return;
    const controller = active.current;
    if (!controller) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const revision = operation.current;
      try {
        const next = await readStatus('', { signal: controller.signal });
        if (stopped || controller.signal.aborted) return;
        if (operation.current !== revision) { timer = setTimeout(() => void poll(), 2000); return; }
        const changed = applyStatus(next);
        if (next.login?.status === 'approved' || changed) {
          useQuotaStore.getState().invalidateProviderQuota('codex');
          await quotaRefreshCoordinator.refreshNow({ forceRefresh: true, rediscover: true }).catch(() => {});
        }
        if (next.login?.status === 'pending') timer = setTimeout(() => void poll(), 2000);
      } catch { if (!stopped && !controller.signal.aborted) { setFailed(true); timer = setTimeout(() => void poll(), 2000); } }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [status?.login?.flowId, status?.login?.status, applyStatus]);
  const mutate = async (path: string, body?: object, method = 'POST') => {
    const controller = active.current, revision = ++operation.current;
    if (!controller || controller.signal.aborted) return;
    setBusy(true); setFailed(false);
    try {
      const next = await readStatus(path, { method, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-devryan-csrf': '1' }, body: body ? JSON.stringify(body) : undefined });
      if (active.current !== controller || controller.signal.aborted || operation.current !== revision) return;
      const changed = applyStatus(next);
      if (path === '/start' && next.login?.status === 'pending') {
        const url = next.login.verificationUrl ?? next.login.authUrl;
        if (url) await openExternalUrl(url);
      }
      if (changed || method === 'DELETE' || next.configured && (next.connectionId !== status?.connectionId || next.account?.email !== status?.account?.email)) {
        useQuotaStore.getState().invalidateProviderQuota('codex');
        await quotaRefreshCoordinator.refreshNow({ forceRefresh: true, rediscover: true }).catch(() => {});
      }
    } catch { if (active.current === controller && !controller.signal.aborted && operation.current === revision) setFailed(true); }
    finally { if (active.current === controller && !controller.signal.aborted && operation.current === revision) setBusy(false); }
  };
  if (!administrator) return null;
  const login = status?.login?.status === 'pending' ? status.login : null;
  const url = login?.verificationUrl ?? login?.authUrl;
  const loginFailed = status?.login && ['failed', 'expired'].includes(status.login.status);
  return <section className="space-y-2 py-2">
    <p className="typography-ui-label">{t('settings.providers.codexUsage.title')}</p>
    <p className="typography-meta text-muted-foreground">{t('settings.providers.codexUsage.description')}</p>
    {!isLocal ? <p className="typography-meta text-muted-foreground">{t('settings.providers.codexUsage.localRequired')}</p> : <>
      {status?.configured ? <UsageSourceDetails source={status.source} account={status.account} /> : null}
      {status?.available === false ? <p className="typography-meta text-muted-foreground">{t('settings.providers.codexUsage.unavailable')}</p> : null}
      {login ? <div className="space-y-2">
        <p role="status" className="typography-meta">{t('settings.providers.codexUsage.pending')}</p>
        {login.userCode ? <p className="typography-ui-label font-mono">{t('settings.providers.codexUsage.code', { code: login.userCode })}</p> : null}
        {url ? <Button size="xs" variant="ghost" onClick={() => void openExternalUrl(url)}>{t('settings.providers.codexUsage.open')}</Button> : null}
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void mutate('/cancel', { flowId: login.flowId })}>{t('settings.providers.codexUsage.cancel')}</Button>
      </div> : <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={busy || !status?.available} onClick={() => void mutate('/start', { method: 'device' })}>{t(status?.configured ? 'settings.providers.codexUsage.reconnect' : 'settings.providers.codexUsage.connect')}</Button>
        {status?.configured ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void mutate('', undefined, 'DELETE')}>{t('settings.providers.codexUsage.disconnect')}</Button> : null}
      </div>}
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void mutate('', undefined, 'GET')}>{t('settings.providers.codexUsage.refresh')}</Button>
      {failed || loginFailed || status?.error ? <p role="alert" className="typography-meta text-[var(--status-error)]">{status?.error ?? t('settings.providers.codexUsage.failed')}</p> : null}
    </>}
  </section>;
}
