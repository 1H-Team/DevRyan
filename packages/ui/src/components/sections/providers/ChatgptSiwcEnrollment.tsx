import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { useQuotaStore } from '@/stores/useQuotaStore';

interface SiwcStatus {
  connected: {
    credentialID: string;
    methodID: string | null;
    email: string | null;
    planUsage: boolean;
    legacy: boolean;
  } | null;
  registrations: Array<{ registrationRef: string; label: string; email: string | null; credentialID: string | null; active: boolean; cleanupRequired: boolean }>;
}
interface PendingEnrollment { enrollmentID: string; url: string }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const endpoint = '/api/provider/openai/siwc';
const isLocalOrigin = () => {
  if (isDesktopLocalOriginActive()) return true;
  try {
    const origin = new URL(window.location.origin);
    return ['http:', 'https:'].includes(origin.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  } catch { return false; }
};

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
      credentialID: row.credentialID, active: row.active === true, cleanupRequired: row.cleanupRequired === true };
  });
  return { connected, registrations };
}
const errorKey = (error: unknown, action: 'connection' | 'disconnect' = 'connection') => {
  switch (error instanceof Error ? error.message : '') {
    case 'native_chatgpt_siwc_local_required': return 'settings.providers.siwc.localRequired';
    case 'native_chatgpt_siwc_registration_cleanup_required': return 'settings.providers.siwc.registrationCleanupRequired';
    case 'native_chatgpt_siwc_reauthorization_required':
    case 'native_chatgpt_siwc_registration_changed': return 'settings.providers.siwc.reauthorizationRequired';
    case 'native_chatgpt_siwc_update_required': return 'settings.providers.siwc.updateRequired';
    case 'native_chatgpt_siwc_access_denied': return 'settings.providers.siwc.denied';
    case 'native_chatgpt_siwc_plan_usage_required': return 'settings.providers.siwc.planRequired';
    case 'native_chatgpt_siwc_selection_changed':
    case 'native_credential_conflict': return 'settings.providers.siwc.selectionChanged';
    case 'native_chatgpt_siwc_cleanup_revocation_failed': return 'settings.providers.siwc.cleanupRevocationFailed';
    case 'native_chatgpt_siwc_cleanup_failed':
    case 'native_chatgpt_siwc_local_cleanup_failed': return action === 'disconnect' ? 'settings.providers.siwc.cleanupFailed' : 'settings.providers.siwc.failed';
    default: return 'settings.providers.siwc.failed';
  }
};

export function ChatgptSiwcEnrollment({ administrator, principalID, directory, refreshRevision = 0, catalogReady, onSelected }: {
  administrator: boolean;
  principalID: string;
  directory?: string | null;
  refreshRevision?: number;
  catalogReady?: boolean;
  onSelected: (connection: { planUsage: boolean } | null | undefined, signal: AbortSignal) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<SiwcStatus | null>(null);
  const [pending, setPending] = React.useState<PendingEnrollment | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ReturnType<typeof errorKey> | null>(null);
  const [revocationUnconfirmed, setRevocationUnconfirmed] = React.useState(false);
  const [catalog, setCatalog] = React.useState<'loading' | 'pending' | null>(null);
  const [statusUnavailable, setStatusUnavailable] = React.useState(false);
  const [reconnectRef, setReconnectRef] = React.useState<string | null>(null);
  const active = React.useRef<AbortController | null>(null);
  const operation = React.useRef(0);
  const pendingAttempt = React.useRef<PendingEnrollment | null>(null);
  const scope = directory?.trim() ? `?directory=${encodeURIComponent(directory.trim())}` : '';
  const localOrigin = isLocalOrigin();

  React.useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    operation.current++;
    setPending(null); setError(null); setStatus(null); setBusy(false); setRevocationUnconfirmed(false); setCatalog(null); setStatusUnavailable(false); setReconnectRef(null);
    if (administrator && localOrigin) void readStatus(scope, controller.signal).then(data => {
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
  }, [administrator, principalID, scope, refreshRevision, localOrigin]);

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
    if (current(controller, revision)) { setStatus(data); setStatusUnavailable(false); }
  };
  const changed = async (controller: AbortController | null, revision: number, connection?: { planUsage: boolean } | null) => {
    // Mutation already succeeded. Discovery/status failures must not imply lost credentials.
    if (!current(controller, revision) || !controller) return;
    useQuotaStore.getState().invalidateProviderQuota('codex');
    setCatalog(connection === null ? null : 'loading');
    try {
      const data = await readStatus(scope, controller.signal);
      if (!current(controller, revision)) return;
      setStatus(data); setStatusUnavailable(false);
      connection = data.connected;
    } catch { if (current(controller, revision)) setStatusUnavailable(true); }
    if (!current(controller, revision)) return;
    let ready = false;
    try { ready = await onSelected(connection, controller.signal); } catch { /* Saved auth remains valid. */ }
    if (current(controller, revision)) setCatalog(ready || connection === null ? null : 'pending');
  };
  const start = async (registrationRef?: string, expectedActiveCredentialID = status?.connected?.credentialID ?? null) => {
    const controller = active.current, revision = ++operation.current;
    setBusy(true); setError(null); setRevocationUnconfirmed(false); setCatalog(null); setReconnectRef(registrationRef ?? null);
    try {
      const data = await mutate('', registrationRef ? { registrationRef, expectedActiveCredentialID } : {});
      if (!id(data.enrollmentID) || data.status !== 'pending' || typeof data.url !== 'string') throw new Error('response');
      const url = new URL(data.url);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password) throw new Error('response');
      if (!current(controller, revision)) return;
      if (id(data.registrationRef)) setReconnectRef(data.registrationRef);
      pendingAttempt.current = { enrollmentID: data.enrollmentID, url: url.toString() };
      setPending(pendingAttempt.current);
      await openExternalUrl(url.toString());
      if (!current(controller, revision)) return;
      const completed = await mutate(`/${data.enrollmentID}/complete`, {});
      if (completed.status !== 'enrolled' || completed.enrollmentID !== data.enrollmentID) throw new Error('response');
      if (!current(controller, revision)) return;
      pendingAttempt.current = null; setPending(null);
      await changed(controller, revision, { planUsage: completed.planUsage === true });
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
  const select = async (registrationRef: string, expectedActiveCredentialID = status?.connected?.credentialID ?? null) => {
    const controller = active.current, revision = ++operation.current;
    setBusy(true); setError(null); setRevocationUnconfirmed(false); setCatalog(null); setReconnectRef(registrationRef);
    try {
      await mutate(`/${registrationRef}/select`, { expectedActiveCredentialID });
      await changed(controller, revision);
    } catch (error) { if (current(controller, revision)) { setError(errorKey(error)); await refresh(controller, revision).catch(() => {}); } }
    finally { if (current(controller, revision)) setBusy(false); }
  };
  const disconnect = async () => {
    const controller = active.current, revision = ++operation.current;
    setBusy(true); setError(null); setRevocationUnconfirmed(false); setCatalog(null);
    try {
      const result = await mutate('', { expectedActiveCredentialID: status?.connected?.credentialID ?? null }, 'DELETE');
      if (result.localCleanup !== 'complete') throw new Error('native_chatgpt_siwc_local_cleanup_failed');
      if (current(controller, revision)) setRevocationUnconfirmed(result.remoteRevocation !== 'confirmed' && result.remoteRevocation !== 'not_applicable');
      await changed(controller, revision, null);
    } catch (error) { if (current(controller, revision)) { setError(errorKey(error, 'disconnect')); await refresh(controller, revision).catch(() => {}); } }
    finally { if (current(controller, revision)) setBusy(false); }
  };
  const reconnect = async () => {
    const controller = active.current, revision = ++operation.current;
    if (!controller || !current(controller, revision)) return;
    setBusy(true);
    try {
      const latest = await readStatus(scope, controller.signal);
      if (!current(controller, revision)) return;
      setStatus(latest); setStatusUnavailable(false);
      const registration = latest.registrations.find(row => row.cleanupRequired && row.registrationRef === reconnectRef)
        ?? latest.registrations.find(row => row.cleanupRequired)
        ?? latest.registrations.find(row => row.registrationRef === reconnectRef)
        ?? latest.registrations.find(row => row.active);
      if (error !== 'settings.providers.siwc.reauthorizationRequired'
        && registration?.cleanupRequired && registration.active && registration.credentialID) {
        await select(registration.registrationRef, latest.connected?.credentialID ?? null);
        return;
      }
      const connection = latest.connected;
      if (!error && !revocationUnconfirmed && (statusUnavailable || catalog === 'pending' || catalogReady === false)
        && connection?.methodID === 'chatgpt-siwc' && connection.planUsage && !connection.legacy
        && !registration?.cleanupRequired) {
        await changed(controller, revision, connection);
        return;
      }
      await start(registration?.registrationRef, latest.connected?.credentialID ?? null);
    } catch (error) { if (current(controller, revision)) setError(errorKey(error)); }
    finally { if (current(controller, revision)) setBusy(false); }
  };

  if (!administrator) return null;
  if (!localOrigin) return <section className="space-y-2 py-2">
    <p className="typography-ui-label">{t('settings.providers.siwc.title')}</p>
    <p className="typography-meta text-muted-foreground">{t('settings.providers.siwc.localRequired')}</p>
  </section>;
  const connected = status?.connected?.methodID === 'chatgpt-siwc' || status?.connected?.legacy ? status.connected : null;
  const catalogPhase = catalog === 'loading' ? catalog : catalogReady === true ? null
    : catalog ?? (connected?.planUsage && catalogReady === false ? 'pending' : null);
  const issue = error ?? (revocationUnconfirmed ? 'settings.providers.siwc.revocationUnconfirmed'
    : statusUnavailable ? 'settings.providers.siwc.statusUnavailable'
    : status?.registrations.some(row => row.cleanupRequired) ? 'settings.providers.siwc.registrationCleanupRequired'
    : connected?.legacy ? 'settings.providers.siwc.legacyReconnect'
    : connected && !connected.planUsage ? 'settings.providers.siwc.planRequired'
    : catalogPhase === 'pending' ? 'settings.providers.siwc.catalogPending' : null);
  const selectedRegistration = status?.registrations.some(row => row.credentialID === connected?.credentialID);
  return (
    <section className="space-y-2 py-2">
      <p className="typography-ui-label">{t('settings.providers.siwc.title')}</p>
      {connected && !selectedRegistration ? <div className="flex flex-wrap items-center gap-2">
        <span className="typography-meta">{connected.email || t('settings.providers.siwc.account')}</span>
        <Button size="xs" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void disconnect()}>{t('settings.providers.siwc.disconnect')}</Button>
      </div> : null}
      {status?.registrations.map(row => <div key={row.registrationRef} aria-current={row.active ? true : undefined} className="flex flex-wrap items-center gap-2">
        <span className="typography-meta">{row.email || t('settings.providers.siwc.account')}</span>
        {!row.active && !row.cleanupRequired && row.credentialID ? <Button size="xs" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void select(row.registrationRef)}>
          {t('settings.providers.siwc.select')}
        </Button> : null}
        {!issue && !row.cleanupRequired && !row.credentialID ? <Button size="xs" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void start(row.registrationRef)}>{t('settings.providers.siwc.reconnect')}</Button> : null}
        {row.active && connected ? <Button size="xs" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void disconnect()}>{t('settings.providers.siwc.disconnect')}</Button> : null}
      </div>)}
      {!issue ? <Button size="xs" variant="outline" disabled={busy || Boolean(pending) || !status} onClick={() => void start()}>{t(connected || status?.registrations.some(row => row.credentialID) ? 'settings.providers.siwc.addAccount' : 'settings.providers.siwc.start')}</Button> : null}
      {pending ? <div className="flex gap-2">
        <Button size="xs" variant="ghost" onClick={() => void openExternalUrl(pending.url)}>{t('settings.providers.siwc.open')}</Button>
        <Button size="xs" variant="outline" onClick={() => void cancel()}>{t('settings.providers.siwc.cancel')}</Button>
      </div> : null}
      {issue ? <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="typography-meta text-[var(--status-error)]">{t(issue)}</p>
        <Button size="xs" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void reconnect()}>{t('settings.providers.siwc.reconnect')}</Button>
      </div> : null}
    </section>
  );
}
