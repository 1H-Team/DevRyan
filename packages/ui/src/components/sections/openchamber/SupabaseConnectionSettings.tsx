import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SupabaseConnectionAPI, SupabaseConnectionStatus } from '@/lib/api/types';
import { isSupabaseConnectionStatus, SupabaseConnectionError } from '@/lib/api/supabaseConnection';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

const labels: Record<SupabaseConnectionStatus['state'], string> = {
  connected: 'Connected', disconnecting: 'Disconnecting', disconnected: 'Disconnected',
  connecting: 'Connecting', connection_failed: 'Connection failed',
};

export function SupabaseConnectionSettings() {
  const { supabaseConnection } = useRuntimeAPIs();
  return <SupabaseConnectionPanel api={supabaseConnection} />;
}

const reloadHost = () => window.location.reload();

export function SupabaseConnectionPanel({ api: supabaseConnection, onModeChanged = reloadHost }: {
  api?: SupabaseConnectionAPI;
  onModeChanged?: () => void;
}) {
  const [status, setStatus] = React.useState<SupabaseConnectionStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [attempt, setAttempt] = React.useState(0);
  const supported = typeof supabaseConnection?.getStatus === 'function' && typeof supabaseConnection?.setEnabled === 'function';
  // Mirrors `busy` for the poll, which closes over the initial render.
  const busyRef = React.useRef(false);
  const changeVersion = React.useRef(0);
  const effectiveMode = React.useRef<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setStatus(null);
    setLoading(supported);
    setError(supported ? null : new SupabaseConnectionError('unsupported').message);
    if (!supported || !supabaseConnection) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      // A poll begun before a change cannot later overwrite its result.
      if (busyRef.current) { timer = setTimeout(refresh, 5_000); return; }
      const version = changeVersion.current;
      try {
        const next = await supabaseConnection.getStatus();
        // Legacy adapters returned null for authorization and missing endpoints.
        // They must render an unavailable control, never an assumed Off state.
        if (next === null) throw new SupabaseConnectionError('unsupported');
        if (!isSupabaseConnectionStatus(next)) throw new SupabaseConnectionError('temporary');
        // A refresh that resolves mid-change would overwrite the PATCH result with stale state.
        if (!disposed && !busyRef.current && version === changeVersion.current) {
          if (effectiveMode.current !== null && effectiveMode.current !== next.effectiveEnabled) {
            onModeChanged();
            return;
          }
          effectiveMode.current = next.effectiveEnabled;
          setStatus(next); setError(null);
        }
      } catch (cause) {
        if (!disposed && !busyRef.current && version === changeVersion.current) setError(cause instanceof SupabaseConnectionError ? cause.message : new SupabaseConnectionError('temporary').message);
      } finally {
        if (!disposed) { setLoading(false); timer = setTimeout(refresh, 5_000); }
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [supabaseConnection, supported, attempt, onModeChanged]);
  const change = async (enabled: boolean) => {
    if (!supabaseConnection || !status?.configured || busyRef.current || loading || error) return;
    changeVersion.current += 1;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const next = await supabaseConnection.setEnabled(enabled);
      if (!isSupabaseConnectionStatus(next)) throw new SupabaseConnectionError('temporary');
      effectiveMode.current = next.effectiveEnabled;
      setStatus(next);
    }
    catch (cause) { setError(cause instanceof SupabaseConnectionError ? cause.message : 'Connection change failed. Refresh the status before retrying.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return (
    <section className="mb-4 space-y-2 rounded-lg border border-border p-3" aria-label="Supabase Connection">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label htmlFor="supabase-connection" className="typography-ui-label">Supabase Connection</label>
          <p role="status" className="typography-meta text-muted-foreground">{loading ? 'Loading connection status…'
            : error ? 'Status unavailable' : status?.configured ? labels[status.state] : 'Not configured'}</p>
        </div>
        <Switch id="supabase-connection" checked={status?.configured ? status.desiredEnabled : false} disabled={busy || loading || Boolean(error) || !status?.configured}
          onCheckedChange={(enabled) => void change(enabled)} />
      </div>
      <p className="typography-meta text-muted-foreground">
        Applies to all windows and this host’s background service.
        Local chats, projects, files and diagnostics stay available when disconnected.
        Bots, Telegram, shared-user access, managed schedules and cloud audit delivery pause.
      </p>
      {!loading && !error && status && !status.configured && <p className="typography-meta text-muted-foreground">
        Supabase is not configured on this host. Complete the host configuration before enabling the connection.
      </p>}
      {status?.restartRequired && <p className="typography-meta text-muted-foreground">
        {status.restartAvailable ? 'DevRyan will restart when active work finishes.' : 'Restart DevRyan when active work finishes to apply this change.'}
        {status.blockers.length > 0 && ` Waiting for: ${status.blockers.map((value) => value.replaceAll('_', ' ')).join(', ')}.`}
      </p>}
      {!error && status?.configured && status.state === 'connection_failed' && <div className="space-y-2">
        <p className="typography-meta text-muted-foreground">{status.errorCode === 'supabase_quota_exceeded'
          ? 'Supabase rejected the connection because of a quota limit. Retry after the limit is resolved.'
          : 'The change could not finish. Check the connection and restart status before retrying.'}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(status.restartRequired ? status.desiredEnabled : true)}>Retry</Button>
      </div>}
      {error && <div className="space-y-2">
        <p role="alert" className="typography-meta text-destructive">{error}</p>
        <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </div>}
    </section>
  );
}
