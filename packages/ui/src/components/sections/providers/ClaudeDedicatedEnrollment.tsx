import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';

interface Enrollment { enrollmentID: string; profileID: string; status: 'enrolled' | 'incomplete' | 'unavailable' }
interface PendingEnrollment { enrollmentID: string; url: string; state: string }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const endpoint = '/api/provider/anthropic/enrollment';

// The original manual flow accepts a callback URL or code#state. A plain code
// is bound to the pending request's original state, never to another account.
function parseClaudeEnrollmentCode(input: string, expectedState: string): { code: string; state: string } {
  let code = input.trim(), state = expectedState;
  if (code.startsWith('https://')) {
    const url = new URL(code);
    if (url.origin !== 'https://platform.claude.com' || url.pathname !== '/oauth/code/callback') throw new Error('callback');
    const params = new URLSearchParams(url.search || url.hash.slice(1));
    code = params.get('code') ?? ''; state = params.get('state') ?? '';
  } else if (code.includes('#')) {
    const pieces = code.split('#');
    if (pieces.length !== 2) throw new Error('callback');
    [code, state] = pieces;
  }
  if (!code || code.length > 8192 || state !== expectedState) throw new Error('callback');
  return { code, state };
}

export function ClaudeDedicatedEnrollment({ administrator, principalID, directory, onSelected }: {
  administrator: boolean; principalID: string; directory?: string | null; onSelected: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = React.useState<Enrollment[]>([]);
  const [pending, setPending] = React.useState<PendingEnrollment | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<'failed' | 'update' | 'callback' | 'capacity' | null>(null);
  const active = React.useRef<AbortController | null>(null);
  const scope = directory?.trim() ? `?directory=${encodeURIComponent(directory.trim())}` : '';

  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    setPending(null); setCode(''); setError(null); setAccounts([]); setBusy(false);
    if (administrator) void (async () => {
      try {
        const response = await fetch(`${endpoint}${scope}`, { signal: controller.signal });
        const data: unknown = await response.json();
        if (!response.ok || !isRecord(data) || !Array.isArray(data.accounts) || data.accounts.length > 64) {
          if (isRecord(data) && data.code === 'native_claude_enrollment_update_required' && !controller.signal.aborted) setError('update');
          throw new Error('response');
        }
        const rows: Enrollment[] = [];
        for (const row of data.accounts) {
          if (!isRecord(row) || !id(row.enrollmentID) || row.profileID !== `devryan-${row.enrollmentID}`
            || (row.status !== 'enrolled' && row.status !== 'incomplete' && row.status !== 'unavailable')) throw new Error('response');
          rows.push({ enrollmentID: row.enrollmentID, profileID: row.profileID, status: row.status });
        }
        if (new Set(rows.map(row => row.enrollmentID)).size !== rows.length) throw new Error('response');
        if (!controller.signal.aborted) setAccounts(rows);
      } catch { if (!controller.signal.aborted) setError(value => value ?? 'failed'); }
    })();
    return () => { controller.abort(); if (active.current === controller) active.current = null; };
  }, [administrator, principalID, scope]);
  const current = (controller: AbortController | null) => controller !== null && active.current === controller && !controller.signal.aborted;

  const mutate = async (path: string, body: object): Promise<Record<string, unknown>> => {
    const signal = active.current?.signal;
    if (!signal || signal.aborted) throw new Error('scope');
    const response = await fetch(`${endpoint}${path}${scope}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-devryan-csrf': '1' }, body: JSON.stringify(body), signal });
    const data: unknown = await response.json();
    if (signal.aborted) throw new Error('scope');
    if (!response.ok || !isRecord(data)) {
      if (isRecord(data) && data.code === 'native_claude_enrollment_update_required') setError('update');
      if (isRecord(data) && data.code === 'native_claude_enrollment_capacity') setError('capacity');
      throw new Error('response');
    }
    return data;
  };
  const start = async () => {
    const controller = active.current;
    setBusy(true); setError(null); setCode('');
    try {
      const data = await mutate('', {});
      if (!id(data.enrollmentID) || data.status !== 'pending' || typeof data.url !== 'string') throw new Error('response');
      const url = new URL(data.url), state = url.searchParams.get('state');
      if (url.origin !== 'https://claude.com' || url.pathname !== '/cai/oauth/authorize' || !state) throw new Error('response');
      if (!current(controller)) return;
      setPending({ enrollmentID: data.enrollmentID, url: url.toString(), state });
      await openExternalUrl(url.toString());
    } catch { if (current(controller)) setError(value => value ?? 'failed'); }
    finally { if (current(controller)) setBusy(false); }
  };
  const complete = async () => {
    const controller = active.current;
    if (!pending) return;
    let input: { code: string; state: string };
    try { input = parseClaudeEnrollmentCode(code, pending.state); } catch { setError('callback'); return; }
    setBusy(true); setError(null); setCode('');
    try {
      const data = await mutate(`/${pending.enrollmentID}/complete`, input);
      if (data.enrollmentID !== pending.enrollmentID || data.status !== 'enrolled' || data.profileID !== `devryan-${pending.enrollmentID}`) throw new Error('response');
      if (!current(controller)) return;
      setAccounts(rows => [...rows.filter(row => row.enrollmentID !== pending.enrollmentID), { enrollmentID: pending.enrollmentID, profileID: String(data.profileID), status: 'enrolled' }]);
      setPending(null);
    } catch { if (current(controller)) setError(value => value ?? 'failed'); }
    finally { if (current(controller)) setBusy(false); }
  };
  const select = async (row: Enrollment) => {
    if (row.status === 'unavailable') return;
    const controller = active.current;
    setBusy(true); setError(null);
    try {
      const data = await mutate(`/${row.enrollmentID}/select`, {});
      if (data.status !== 'selected' || data.enrollmentID !== row.enrollmentID || data.profileID !== row.profileID) throw new Error('response');
      if (current(controller)) {
        setAccounts(rows => rows.map(account => account.enrollmentID === row.enrollmentID ? { ...account, status: 'enrolled' } : account));
        await onSelected();
      }
    } catch { if (current(controller)) setError(value => value ?? 'failed'); }
    finally { if (current(controller)) setBusy(false); }
  };
  if (!administrator) return null;
  return <section className="space-y-2 py-2">
    <p className="typography-ui-label">{t('settings.providers.enrollment.title')}</p>
    <p className="typography-meta text-muted-foreground">{t('settings.providers.enrollment.description')}</p>
    <Button size="xs" variant="outline" disabled={busy} onClick={() => void start()}>{t('settings.providers.enrollment.start')}</Button>
    {pending ? <div className="space-y-2">
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void openExternalUrl(pending.url)}>{t('settings.providers.enrollment.open')}</Button>
      <Input aria-label={t('settings.providers.enrollment.code')} value={code} autoComplete="off" spellCheck={false} disabled={busy} onChange={event => setCode(event.target.value)} />
      <Button size="xs" disabled={busy || !code.trim()} onClick={() => void complete()}>{t('settings.providers.enrollment.complete')}</Button>
    </div> : null}
    {accounts.map(row => <div key={row.enrollmentID} className="flex flex-wrap items-center gap-2">
      <span className="typography-meta break-all">{row.profileID}</span>
      {row.status === 'unavailable' ? <span className="typography-meta text-muted-foreground">{t('settings.providers.enrollment.unavailable')}</span> :
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void select(row)}>{t(row.status === 'incomplete' ? 'settings.providers.enrollment.recover' : 'settings.providers.enrollment.select')}</Button>}
    </div>)}
    {error ? <p role="alert" className="typography-meta text-[var(--status-error)]">{t(error === 'callback' ? 'settings.providers.enrollment.callbackInvalid' : error === 'update' ? 'settings.providers.enrollment.updateRequired' : error === 'capacity' ? 'settings.providers.enrollment.capacity' : 'settings.providers.enrollment.failed')}</p> : null}
  </section>;
}
