import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SupabaseConnectionStatus } from '@/lib/api/types';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

const labels: Record<SupabaseConnectionStatus['state'], string> = {
  connected: 'Connected', disconnecting: 'Disconnecting', disconnected: 'Disconnected',
  connecting: 'Connecting', connection_failed: 'Connection failed',
};

export function SupabaseConnectionSettings() {
  const { supabaseConnection } = useRuntimeAPIs();
  const [status, setStatus] = React.useState<SupabaseConnectionStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const effectiveMode = React.useRef<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!supabaseConnection) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await supabaseConnection.getStatus();
        if (!disposed) {
          if (next && effectiveMode.current !== null && effectiveMode.current !== next.effectiveEnabled) {
            window.location.reload();
            return;
          }
          if (next) effectiveMode.current = next.effectiveEnabled;
          setStatus(next); setError(null);
        }
      } catch { /* Keep the last known state while the host restarts. */ }
      finally { if (!disposed) timer = setTimeout(refresh, 5_000); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [supabaseConnection]);
  if (!status?.configured || !supabaseConnection) return null;
  const change = async (enabled: boolean) => {
    setBusy(true); setError(null);
    try { setStatus(await supabaseConnection.setEnabled(enabled)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Connection change failed'); }
    finally { setBusy(false); }
  };
  return (
    <section className="mb-4 space-y-2 rounded-lg border border-border p-3" aria-label="Supabase Connection">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label htmlFor="supabase-connection" className="typography-ui-label">Supabase Connection</label>
          <p role="status" className="typography-meta text-muted-foreground">{labels[status.state]}</p>
        </div>
        <Switch id="supabase-connection" checked={status.desiredEnabled} disabled={busy}
          onCheckedChange={(enabled) => void change(enabled)} />
      </div>
      <p className="typography-meta text-muted-foreground">
        Applies to all windows and this host’s background service.
        Local chats, projects, files and diagnostics stay available when disconnected.
        Bots, Telegram, shared-user access, managed schedules and cloud audit delivery pause.
      </p>
      {status.restartRequired && <p className="typography-meta text-muted-foreground">
        {status.restartAvailable ? 'DevRyan will restart when active work finishes.' : 'Restart DevRyan when active work finishes to apply this change.'}
        {status.blockers.length > 0 && ` Waiting for: ${status.blockers.map((value) => value.replaceAll('_', ' ')).join(', ')}.`}
      </p>}
      {status.state === 'connection_failed' && <div className="space-y-2">
        <p className="typography-meta text-muted-foreground">{status.errorCode === 'supabase_quota_exceeded'
          ? 'Supabase rejected the connection because of a quota limit. Retry after the limit is resolved.'
          : 'The change could not finish. Check the connection and restart status before retrying.'}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(status.restartRequired ? status.desiredEnabled : true)}>Retry</Button>
      </div>}
      {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
    </section>
  );
}
