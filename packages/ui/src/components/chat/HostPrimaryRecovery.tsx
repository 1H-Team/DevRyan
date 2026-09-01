import React from 'react';
import { Button } from '@/components/ui/button';
import { requestPrimaryRecovery } from '@/lib/primaryRecoveryApi';
import { usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';
import { createClientMessageId } from '@/sync/client-message-id';

const labels = {
  stopping: 'Stopping a suspected provider stall',
  reconciling: 'Checking stopped state',
  recovery_reserved: 'Recovering — attempt 1 of 1',
  recovering: 'Recovering — attempt 1 of 1',
  completed: 'Recovery completed',
  needs_attention: 'Recovery needs your attention',
  cancelled: 'Stop requested — automatic recovery cancelled',
  superseded: 'Recovery cancelled by new input',
  observing: 'Monitoring provider progress',
};

export const HostPrimaryRecovery = React.memo(({ sessionId, showAvailability = false }: { sessionId: string; showAvailability?: boolean }) => {
  const snapshot = usePrimaryRecoveryStore((state) => state.snapshots[sessionId]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await requestPrimaryRecovery(sessionId); if (active) setError(null); }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Recovery status unavailable'); }
      finally { inFlight = false; }
    };
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 5000);
    const onProjection = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== 'object' || !('properties' in detail)) return;
      const properties = detail.properties;
      if (!properties || typeof properties !== 'object' || !('sessionID' in properties) || properties.sessionID !== sessionId || !('recovery' in properties)) return;
      usePrimaryRecoveryStore.getState().accept(sessionId, properties.recovery);
    };
    window.addEventListener('openchamber:primary-recovery', onProjection);
    window.addEventListener('online', refresh);
    window.addEventListener('openchamber:primary-recovery-reconnect', refresh);
    return () => { active = false; clearInterval(interval); window.removeEventListener('online', refresh);
      window.removeEventListener('openchamber:primary-recovery-reconnect', refresh);
      window.removeEventListener('openchamber:primary-recovery', onProjection); };
  }, [sessionId]);
  const record = snapshot?.record;
  if (showAvailability && !snapshot?.enforced && !record?.readOnly) return <p className="mb-2 text-sm text-muted-foreground">
    {snapshot?.supported ? 'Automatic recovery is in observe mode. Manual recovery remains available.'
      : 'Automatic recovery safeguards are unavailable for this runtime. Manual recovery remains available.'}
  </p>;
  if (!record || (!snapshot.enforced && !record.readOnly)
    || (record.state === 'observing' && record.reason !== 'provider_input_progress_unavailable') || record.state === 'superseded'
    || (record.state === 'completed' && !record.attemptCount)) return null;
  const act = async (action: 'cancel' | 'continue') => {
    setPending(true); setError(null);
    try { await requestPrimaryRecovery(sessionId, action, action === 'continue' ? createClientMessageId('msg') : undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Action not confirmed'); }
    finally { setPending(false); }
  };
  return <div role="status" aria-live="polite" className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
    <p className="font-medium">{record.reason === 'provider_input_progress_unavailable' ? 'Provider argument progress cannot be verified' : labels[record.state]}</p>
    <p className="mt-1 text-muted-foreground">{record.providerID}/{record.modelID} · {record.agent}{record.variant ? ` · ${record.variant}` : ''}</p>
    <p className="mt-1">Completed work and the original error remain in this session. Automatic recovery can only inspect files.</p>
    {record.reason === 'provider_input_progress_unavailable' && <p className="mt-1">This runtime does not report incremental tool arguments. The watchdog will not interrupt this phase automatically. Stop remains available.</p>}
    {record.reason && <p className="mt-1 text-muted-foreground">{record.reason.replaceAll('_', ' ')}</p>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    <div className="mt-2 flex gap-2">
      {record.state !== 'completed' && <Button variant="outline" size="sm" onClick={() => void act('cancel')}>Stop</Button>}
      {['needs_attention', 'cancelled'].includes(record.state) && <Button variant="outline" size="sm" disabled={pending}
        onClick={() => void act('continue')}>Continue with original permissions</Button>}
    </div>
  </div>;
});
HostPrimaryRecovery.displayName = 'HostPrimaryRecovery';
