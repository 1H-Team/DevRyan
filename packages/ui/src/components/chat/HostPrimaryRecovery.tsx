import React from 'react';
import { Button } from '@/components/ui/button';
import { actOnRecoveredInput, readRecoveredInput, requestPrimaryRecovery, type RecoveredInputDetails } from '@/lib/primaryRecoveryApi';
import { usePrimaryRecoveryStore, type RecoveredInputDescriptor } from '@/stores/usePrimaryRecoveryStore';
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

type RecoveryProps = { sessionId: string; showAvailability?: boolean };

const RecoveredInputRow = ({ sessionId, revision, input, disabled, fallback, onAction }: {
  sessionId: string; revision: string; input: RecoveredInputDescriptor; disabled: boolean; fallback: boolean;
  onAction: (action: 'resume' | 'discard', input: RecoveredInputDescriptor) => void;
}) => {
  const [details, setDetails] = React.useState<RecoveredInputDetails | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const request = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => request.current?.abort(), []);
  const toggle = (event: React.ToggleEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) {
      request.current?.abort(); request.current = null;
      setDetails(null); setLoading(false); setError(null);
      return;
    }
    if (request.current || details) return;
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(null);
    void readRecoveredInput(sessionId, { revision, messageID: input.messageID, payloadHash: input.payloadHash }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetails(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'This input could not be loaded.'); })
      .finally(() => { if (!controller.signal.aborted) { request.current = null; setLoading(false); } });
  };
  return <li className="rounded-md border border-border p-3">
    <p className="whitespace-pre-wrap break-words">{input.preview || 'Retained input'}</p>
    {input.attachmentCount > 0 && <p className="mt-1 text-muted-foreground">{input.attachmentCount} attachment{input.attachmentCount === 1 ? '' : 's'}</p>}
    <details className="mt-2" onToggle={toggle}>
      <summary className="cursor-pointer font-medium">Review input</summary>
      <div className="mt-2 space-y-2">
        <p className="break-all text-muted-foreground">Message: {input.messageID}</p>
        {loading && <p role="status">Loading input…</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {details && <>
          <pre className="whitespace-pre-wrap break-words font-sans typography-meta">{details.text || 'No text in this input.'}</pre>
          {details.files.length > 0 && <ul aria-label="Attachments" className="space-y-1">
            {details.files.map((file, index) => <li key={index} className="break-all">{file.name || (file.uri.startsWith('data:') ? 'Attached file' : file.uri)}{file.mime ? ` (${file.mime})` : ''}</li>)}
          </ul>}
          {details.agents?.length ? <p>Agents: {details.agents.map(agent => agent.name).join(', ')}</p> : null}
          {details.skills?.length ? <p>Skills: {details.skills.join(', ')}</p> : null}
        </>}
      </div>
    </details>
    {fallback && input.canResume && <p className="mt-2 text-muted-foreground">Resuming this recovery keeps its read-only permissions.</p>}
    {!input.canResume && <p className="mt-2 text-muted-foreground">{input.location === 'promoted' && !input.canDiscard
      ? 'This input already started. Its interrupted work must settle. Resume and Discard are unavailable while its outcome is uncertain.'
      : input.reason === 'competing_input' ? 'Review the other retained inputs before resuming.'
      : 'This input cannot resume automatically. Review its details and the available recovery actions.'}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      {input.canResume && <Button variant="outline" size="sm" disabled={disabled} onClick={() => onAction('resume', input)}>Resume Input</Button>}
      {input.canDiscard && <Button variant="outline" size="sm" disabled={disabled} onClick={() => onAction('discard', input)}>Discard Input</Button>}
    </div>
  </li>;
};

const HostPrimaryRecoverySession = ({ sessionId, showAvailability = false }: RecoveryProps) => {
  const snapshot = usePrimaryRecoveryStore((state) => state.snapshots[sessionId]);
  const [error, setError] = React.useState<string | null>(null);
  // Status polling clears only its own error, never an action's outcome.
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const actionPending = React.useRef(false);
  const refreshStatus = React.useRef<() => void>(() => {});
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
    let active = true;
    let inFlight = false;
    let refreshQueued = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (!active || refreshTimer !== null) return;
      refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 200);
    };
    const refresh = async () => {
      if (inFlight || actionPending.current) { refreshQueued = true; return; }
      inFlight = true; refreshQueued = false;
      try { await requestPrimaryRecovery(sessionId); if (active) setError(null); }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Recovery status unavailable'); }
      finally { inFlight = false; if (refreshQueued && !actionPending.current) scheduleRefresh(); }
    };
    refreshStatus.current = scheduleRefresh;
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 5000);
    const onProjection = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== 'object' || !('properties' in detail)) return;
      const properties = detail.properties;
      if (!properties || typeof properties !== 'object' || !('sessionID' in properties) || properties.sessionID !== sessionId || !('recovery' in properties)) return;
      usePrimaryRecoveryStore.getState().accept(sessionId, properties.recovery);
      const current = usePrimaryRecoveryStore.getState().snapshots[sessionId];
      if (current?.recoveredInputPartial && (current.recoveredInput || actionPending.current)) scheduleRefresh();
    };
    window.addEventListener('openchamber:primary-recovery', onProjection);
    window.addEventListener('online', refresh);
    window.addEventListener('openchamber:primary-recovery-reconnect', refresh);
    return () => { active = false; clearInterval(interval); if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshStatus.current = () => {}; window.removeEventListener('online', refresh);
      window.removeEventListener('openchamber:primary-recovery-reconnect', refresh);
      window.removeEventListener('openchamber:primary-recovery', onProjection); };
  }, [sessionId]);
  const record = snapshot?.record;
  const repeatedInput = record?.reason === 'managed_repeated_preexecution_rejection';
  const collectionIssue = record?.collectionIssue;
  const act = async (action: 'cancel' | 'continue') => {
    actionPending.current = true;
    setPending(true); setActionError(null);
    try { await requestPrimaryRecovery(sessionId, action, action === 'continue' ? createClientMessageId('msg') : undefined); }
    catch (cause) { if (mounted.current) setActionError(cause instanceof Error ? cause.message : 'Action not confirmed'); }
    finally { actionPending.current = false; if (mounted.current) {
      setPending(false); if (usePrimaryRecoveryStore.getState().snapshots[sessionId]?.recoveredInputPartial) refreshStatus.current();
    } }
  };
  const recovered = snapshot?.recoveredInput;
  const actOnInput = async (action: 'resume' | 'discard', input: RecoveredInputDescriptor) => {
    if (!recovered || pending || recovered.state !== 'paused') return;
    actionPending.current = true;
    setPending(true); setActionError(null);
    try { await actOnRecoveredInput(sessionId, action, { revision: recovered.revision, messageID: input.messageID, payloadHash: input.payloadHash }); }
    catch (cause) { if (mounted.current) setActionError(cause instanceof Error ? cause.message : 'Action not confirmed'); }
    finally { actionPending.current = false; if (mounted.current) {
      setPending(false); if (usePrimaryRecoveryStore.getState().snapshots[sessionId]?.recoveredInputPartial) refreshStatus.current();
    } }
  };
  if (recovered) return <div className="chat-message-column px-4 pb-2 pt-3"><div role="status" aria-live="polite" className="rounded-lg border border-border bg-muted/30 p-3 typography-meta">
    <p className="font-medium">Input retained after interruption</p>
    <p className="mt-1">Review the saved input and the available recovery actions. Sending new messages is paused while this input needs attention.</p>
    {recovered.state === 'resuming' && <p className="mt-2">Resuming the retained input…</p>}
    {recovered.state === 'discarding' && <p className="mt-2">Confirming the discarded input…</p>}
    {(actionError ?? error) && <p role="alert" className="mt-2 text-destructive">{actionError ?? error}</p>}
    <ul aria-label="Retained Inputs" className="mt-3 space-y-2">
      {recovered.inputs.map(input => <RecoveredInputRow key={`${sessionId}:${recovered.revision}:${input.messageID}:${input.payloadHash}`}
        sessionId={sessionId} revision={recovered.revision} input={input} fallback={record?.recoveryID === input.messageID}
        disabled={pending || recovered.state !== 'paused'} onAction={(action, item) => { void actOnInput(action, item); }} />)}
    </ul>
    {record && record.state !== 'completed' && <div className="mt-3">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void act('cancel')}>Stop</Button>
    </div>}
  </div></div>;
  if (record?.state === 'cancelled' && record.reason === 'recovered_input_discarded') return <div className="chat-message-column px-4 pb-2 pt-3">
    <div role="status" aria-live="polite" className="rounded-lg border border-border bg-muted/30 p-3 typography-meta">
      <p className="font-medium">Input discarded</p>
      <p className="mt-1">Send a new message to continue.</p>
    </div>
  </div>;
  // A completed sub-agent whose automatic delivery to this parent was refused
  // stays pending until an explicit collection; never leave the parent silent.
  if (collectionIssue) return <div className="chat-message-column px-4 pb-2 pt-3"><div role="status" aria-live="polite" className="rounded-lg border border-border bg-muted/30 p-3 typography-meta">
    <p className="font-medium">Sub-agent result ready — parent paused</p>
    <p className="mt-1">A sub-agent finished, but this session did not resume automatically. Collect the result to continue the task with its original permissions.</p>
    {(actionError ?? error) && <p role="alert" className="mt-2 text-destructive">{actionError ?? error}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void act('continue')}>Collect Result</Button>
    </div>
  </div></div>;
  if (showAvailability && !snapshot?.enforced && !record?.readOnly && !repeatedInput) return <div className="chat-message-column px-4 pb-2 pt-3"><p className="typography-meta text-muted-foreground">
    {snapshot?.supported ? 'Automatic recovery is in observe mode. Manual recovery remains available.'
      : 'Automatic recovery safeguards are unavailable for this runtime. Manual recovery remains available.'}
  </p></div>;
  if (!record || (!snapshot.enforced && !record.readOnly && !repeatedInput)
    || (record.state === 'observing' && record.reason !== 'provider_input_progress_unavailable') || record.state === 'superseded'
    || (record.state === 'completed' && !record.attemptCount)) return null;
  return <div className="chat-message-column px-4 pb-2 pt-3"><div role="status" aria-live="polite" className="rounded-lg border border-border bg-muted/30 p-3 typography-meta">
    <p className="font-medium">{repeatedInput ? 'Paused after repeated invalid tool input'
      : record.reason === 'provider_input_progress_unavailable' ? 'Provider argument progress cannot be verified' : labels[record.state]}</p>
    <p className="mt-1">{repeatedInput ? 'The same input was rejected before execution three times. Review the input or send a corrected instruction to continue.'
      : 'Completed work and the original error remain in this session. Automatic recovery can only inspect files.'}</p>
    {record.reason === 'provider_input_progress_unavailable' && <p className="mt-1">This runtime does not report incremental tool arguments. The watchdog will not interrupt this phase automatically. Stop remains available.</p>}
    {record.reason && !repeatedInput && <p className="mt-1 text-muted-foreground">{record.failureKind === 'provider_authentication'
      ? 'Provider sign-in failed. Reconnect the provider before continuing.'
      : record.reason === 'recovery_tool_outcome_unknown'
      ? 'A tool may have changed files before the timeout. Automatic retry is paused; review the outcome before continuing.'
      : record.providerID === 'anthropic' && record.reason === 'chunk_timeout' ? 'Claude stopped sending data.'
      : record.reason.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())}</p>}
    {(actionError ?? error) && <p role="alert" className="mt-2 text-destructive">{actionError ?? error}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      {record.state !== 'completed' && <Button variant="outline" size="sm" onClick={() => void act('cancel')}>Stop</Button>}
      {['needs_attention', 'cancelled'].includes(record.state) && <Button className="h-auto max-w-full whitespace-normal" variant="outline" size="sm" disabled={pending}
        onClick={() => void act('continue')}>Continue with Original Permissions</Button>}
    </div>
  </div></div>;
};

export const HostPrimaryRecovery = React.memo((props: RecoveryProps) => <HostPrimaryRecoverySession key={props.sessionId} {...props} />);
HostPrimaryRecovery.displayName = 'HostPrimaryRecovery';
