import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';

interface SiwcStatus {
  connected: {
    credentialID: string;
    methodID: string | null;
    email: string | null;
    planUsage: boolean;
    legacy: boolean;
  } | null;
  registrations: Array<{ registrationRef: string; label: string; email: string | null; credentialID: string | null; active: boolean }>;
}
interface PendingEnrollment { enrollmentID: string; url: string }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const endpoint = '/api/provider/openai/siwc';

async function responseData(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  if (!response.ok || !isRecord(data)) {
    if (isRecord(data) && data.code === 'native_chatgpt_siwc_cleanup_failed' && data.remoteRevocation === 'unconfirmed') {
      throw new Error('native_chatgpt_siwc_cleanup_revocation_failed');
    }
    throw new Error(isRecord(data) && typeof data.code === 'string' ? data.code : 'response');
  }
  return data;
}
async function readStatus(scope: string, signal: AbortSignal): Promise<SiwcStatus> {
  const data = await responseData(await fetch(`${endpoint}${scope}`, { signal }));
  let connected: SiwcStatus['connected'] = null;
  if (data.connected != null) {
    const row = data.connected;
    if (!isRecord(row) || typeof row.credentialID !== 'string') throw new Error('response');
    connected = { credentialID: row.credentialID, methodID: typeof row.methodID === 'string' ? row.methodID : null,
      email: typeof row.email === 'string' ? row.email : null, planUsage: row.planUsage === true, legacy: row.legacy === true };
  }
  if (!Array.isArray(data.registrations)) throw new Error('response');
  const registrations = data.registrations.map((row: unknown) => {
    if (!isRecord(row) || !id(row.registrationRef) || typeof row.label !== 'string'
      || !(row.credentialID === null || typeof row.credentialID === 'string')) throw new Error('response');
    return { registrationRef: row.registrationRef, label: row.label, email: typeof row.email === 'string' ? row.email : null,
      credentialID: row.credentialID, active: row.active === true };
  });
  return { connected, registrations };
}
const errorKey = (error: unknown) => {
  switch (error instanceof Error ? error.message : '') {
    case 'native_chatgpt_siwc_update_required': return 'settings.providers.siwc.updateRequired';
    case 'native_chatgpt_siwc_access_denied': return 'settings.providers.siwc.denied';
    case 'native_chatgpt_siwc_plan_usage_required': return 'settings.providers.siwc.planRequired';
    case 'native_chatgpt_siwc_selection_changed':
    case 'native_credential_conflict': return 'settings.providers.siwc.selectionChanged';
    case 'native_chatgpt_siwc_cleanup_revocation_failed': return 'settings.providers.siwc.cleanupRevocationFailed';
    case 'native_chatgpt_siwc_cleanup_failed':
    case 'native_chatgpt_siwc_local_cleanup_failed': return 'settings.providers.siwc.cleanupFailed';
    default: return 'settings.providers.siwc.failed';
  }
};

export function ChatgptSiwcEnrollment({ administrator, principalID, directory, refreshRevision = 0, onSelected }: {
  administrator: boolean;
  principalID: string;
  directory?: string | null;
  refreshRevision?: number;
  onSelected: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<SiwcStatus | null>(null);
  const [pending, setPending] = React.useState<PendingEnrollment | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ReturnType<typeof errorKey> | null>(null);
  const [revocationUnconfirmed, setRevocationUnconfirmed] = React.useState(false);
  const active = React.useRef<AbortController | null>(null);
  const operation = React.useRef(0);
  const pendingAttempt = React.useRef<PendingEnrollment | null>(null);
  const scope = directory?.trim() ? `?directory=${encodeURIComponent(directory.trim())}` : '';

  React.useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    operation.current++;
    setPending(null); setError(null); setStatus(null); setBusy(false); setRevocationUnconfirmed(false);
    if (administrator) void readStatus(scope, controller.signal).then(data => {
      if (!controller.signal.aborted) setStatus(data);
    }).catch(error => { if (!controller.signal.aborted) setError(errorKey(error)); });
    return () => {
      controller.abort();
      if (active.current === controller) active.current = null;
      const attempt = pendingAttempt.current;
      pendingAttempt.current = null;
      if (attempt) void fetch(`${endpoint}/${attempt.enrollmentID}${scope}`, {
        method: 'DELETE', headers: { 'x-devryan-csrf': '1' }, keepalive: true,
      }).catch(() => {});
    };
  }, [administrator, principalID, scope, refreshRevision]);

  const current = (controller: AbortController | null, revision: number) => controller !== null
    && active.current === controller && !controller.signal.aborted && operation.current === revision;
  const mutate = async (path: string, body: object | undefined, method = 'POST') => {
    const signal = active.current?.signal;
    if (!signal || signal.aborted) throw new Error('scope');
    return responseData(await fetch(`${endpoint}${path}${scope}`, { method,
      headers: { 'Content-Type': 'application/json', 'x-devryan-csrf': '1' },
      body: body === undefined ? undefined : JSON.stringify(body), signal }));
  };
  const refresh = async (controller: AbortController | null, revision: number) => {
    if (!current(controller, revision) || !controller) return;
    const data = await readStatus(scope, controller.signal);
    if (current(controller, revision)) setStatus(data);
  };
  const changed = async (controller: AbortController | null, revision: number) => {
    await refresh(controller, revision);
    if (current(controller, revision)) await onSelected();
  };

  const start = async (registrationRef?: string) => {
    const controller = active.current, revision = ++operation.current;
    setBusy(true); setError(null); setRevocationUnconfirmed(false);
    try {
      const data = await mutate('', registrationRef ? { registrationRef, expectedActiveCredentialID: status?.connected?.credentialID ?? null } : {});
      if (!id(data.enrollmentID) || data.status !== 'pending' || typeof data.url !== 'string') throw new Error('response');
      const url = new URL(data.url);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password) throw new Error('response');
      if (!current(controller, revision)) return;
      pendingAttempt.current = { enrollmentID: data.enrollmentID, url: url.toString() };
      setPending(pendingAttempt.current);
      await openExternalUrl(url.toString());
      if (!current(controller, revision)) return;
      const completed = await mutate(`/${data.enrollmentID}/complete`, {});
      if (completed.status !== 'enrolled' || completed.enrollmentID !== data.enrollmentID) throw new Error('response');
      if (!current(controller, revision)) return;
      pendingAttempt.current = null; setPending(null);
      await changed(controller, revision);
    } catch (error) {
      if (current(controller, revision)) {
        setError(errorKey(error));
        const attempt = pendingAttempt.current;
        pendingAttempt.current = null; setPending(null);
        if (attempt) await mutate(`/${attempt.enrollmentID}`, undefined, 'DELETE').catch(() => {});
        await refresh(controller, revision).catch(() => {});
      }
    } finally { if (current(controller, revision)) setBusy(false); }
  };
  const cancel = async () => {
    if (!pending) return;
    const controller = active.current, revision = ++operation.current;
    try {
      await mutate(`/${pending.enrollmentID}`, undefined, 'DELETE');
      if (current(controller, revision)) { pendingAttempt.current = null; setPending(null); }
    } catch (error) { if (current(controller, revision)) setError(errorKey(error)); }
    finally { if (current(controller, revision)) setBusy(false); }
  };
  const select = async (registrationRef: string) => {
    const controller = active.current, revision = ++operation.current;
    setBusy(true); setError(null); setRevocationUnconfirmed(false);
    try {
      await mutate(`/${registrationRef}/select`, { expectedActiveCredentialID: status?.connected?.credentialID ?? null });
      await changed(controller, revision);
    } catch (error) { if (current(controller, revision)) { setError(errorKey(error)); await refresh(controller, revision).catch(() => {}); } }
    finally { if (current(controller, revision)) setBusy(false); }
  };
  const disconnect = async () => {
    const controller = active.current, revision = ++operation.current;
    setBusy(true); setError(null); setRevocationUnconfirmed(false);
    try {
      const result = await mutate('', { expectedActiveCredentialID: status?.connected?.credentialID ?? null }, 'DELETE');
      if (result.localCleanup !== 'complete') throw new Error('native_chatgpt_siwc_local_cleanup_failed');
      if (current(controller, revision)) setRevocationUnconfirmed(result.remoteRevocation !== 'confirmed' && result.remoteRevocation !== 'not_applicable');
      await changed(controller, revision);
    } catch (error) { if (current(controller, revision)) { setError(errorKey(error)); await refresh(controller, revision).catch(() => {}); } }
    finally { if (current(controller, revision)) setBusy(false); }
  };

  if (!administrator) return null;
  const connected = status?.connected?.methodID === 'chatgpt-siwc' || status?.connected?.legacy ? status.connected : null;
  const activeRegistration = status?.registrations.find(row => row.active);
  return (
    <section className="space-y-2 py-2">
      <p className="typography-ui-label">{t('settings.providers.siwc.title')}</p>
      <p className="typography-meta text-muted-foreground">{t('settings.providers.siwc.description')}</p>
      {connected?.legacy ? <p role="alert" className="typography-meta text-[var(--status-error)]">{t('settings.providers.siwc.legacyReconnect')}</p> : null}
      {connected && !connected.legacy ? <div className="space-y-2">
        <p className="typography-meta text-muted-foreground">{connected.email ? t('settings.providers.siwc.connectedEmail', { email: connected.email }) : t('settings.providers.siwc.connected')}</p>
        <p className="typography-meta text-muted-foreground">{t(connected.planUsage ? 'settings.providers.siwc.planEnabled' : 'settings.providers.siwc.planDisabled')}</p>
        {!connected.planUsage && activeRegistration ? <Button size="xs" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void start(activeRegistration.registrationRef)}>{t('settings.providers.siwc.reauthorize')}</Button> : null}
      </div> : null}
      {connected ? <Button size="xs" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void disconnect()}>{t('settings.providers.siwc.disconnect')}</Button> : null}
      <Button size="xs" variant="outline" disabled={busy || Boolean(pending) || !status} onClick={() => void start()}>{t(connected ? 'settings.providers.siwc.addAccount' : 'settings.providers.siwc.start')}</Button>
      {status?.registrations.map(row => <div key={row.registrationRef} className="flex flex-wrap items-center gap-2">
        <span className="typography-meta">{row.label}{row.active ? ` · ${t('settings.providers.siwc.selected')}` : ''}</span>
        {!row.active ? <Button size="xs" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void (row.credentialID ? select(row.registrationRef) : start(row.registrationRef))}>
          {t(row.credentialID ? 'settings.providers.siwc.select' : 'settings.providers.siwc.signInAgain')}
        </Button> : null}
      </div>)}
      {pending ? <div className="flex gap-2">
        <Button size="xs" variant="ghost" onClick={() => void openExternalUrl(pending.url)}>{t('settings.providers.siwc.open')}</Button>
        <Button size="xs" variant="outline" onClick={() => void cancel()}>{t('settings.providers.siwc.cancel')}</Button>
      </div> : null}
      {revocationUnconfirmed ? <p role="status" className="typography-meta text-muted-foreground">{t('settings.providers.siwc.revocationUnconfirmed')}</p> : null}
      {error ? <p role="alert" className="typography-meta text-[var(--status-error)]">{t(error)}</p> : null}
      {!status && error ? <Button size="xs" variant="outline" onClick={() => void refresh(active.current, operation.current).catch(error => setError(errorKey(error)))}>{t('settings.providers.siwc.retry')}</Button> : null}
    </section>
  );
}
