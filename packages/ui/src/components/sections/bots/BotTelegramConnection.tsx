import React from 'react';
import { RiTelegramLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthPrincipal } from '@/lib/authSession';
import { botsApi, BotsApiError, type BotsApi, type BotTelegramStatus } from '@/lib/botsApi';
import { BotSpeechSettings } from './BotSpeechSettings';

type Props = { botId: string; canManage: boolean; active: boolean; api?: BotsApi };
const failureText = (error: unknown) => error instanceof BotsApiError
  ? `${error.message} (${error.code})` : 'Could not update Telegram. Please retry.';

export function BotTelegramConnection(props: Props) {
  const principal = useAuthPrincipal();
  // Account changes discard all pairing URLs, drafts and in-flight display state.
  return <TelegramConnection key={`${principal.id}:${props.botId}`} {...props} />;
}

function TelegramConnection({ botId, canManage, active, api = botsApi }: Props) {
  const [status, setStatus] = React.useState<BotTelegramStatus | null>(null);
  const [token, setToken] = React.useState('');
  const [enabled, setEnabled] = React.useState(false);
  const [pairingLink, setPairingLink] = React.useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const version = React.useRef(0);
  const alive = React.useRef(true);
  const pending = React.useRef(false);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => { if (!canManage) setToken(''); }, [canManage]);
  const refresh = React.useCallback(async () => {
    if (pending.current || !activeRef.current) return;
    const request = ++version.current;
    try {
      const result = await api.getTelegramStatus(botId);
      if (!alive.current || !activeRef.current || version.current !== request) return;
      setStatus(result); setError(null);
    } catch (failure) {
      if (alive.current && activeRef.current && version.current === request) setError(failureText(failure));
    }
  }, [api, botId]);
  React.useEffect(() => {
    if (!active) { setToken(''); setPairingLink(null); version.current += 1; return; }
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [active, refresh]);
  const savedEnabled = status?.enabled;
  React.useEffect(() => { if (savedEnabled !== undefined) setEnabled(savedEnabled); }, [savedEnabled]);
  const mutate = async (operation: (isCurrent: () => boolean) => Promise<BotTelegramStatus | void>) => {
    if (pending.current || !activeRef.current) return;
    pending.current = true;
    const request = ++version.current;
    const isCurrent = () => alive.current && activeRef.current && version.current === request;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await operation(isCurrent);
      if (isCurrent() && result) setStatus(result);
    } catch (failure) {
      if (isCurrent()) setError(failureText(failure));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
      if (alive.current && activeRef.current) void refresh();
    }
  };
  const pairing = status?.pairing;
  const paired = pairing?.state === 'confirmed';
  return (
    <section className="rounded-xl border border-border/70 bg-[var(--surface-subtle)]/25 p-4" aria-label="Telegram Connection">
      <div className="flex flex-wrap items-center gap-2">
        <RiTelegramLine className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h3 className="flex-1 typography-ui-label font-semibold">Telegram</h3>
        <span role="status" className="typography-micro text-muted-foreground">{status?.state.replaceAll('_', ' ') || 'Loading connection…'}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh</Button>
      </div>
      <p className="mt-2 typography-ui text-muted-foreground">Use this Bot in a private Telegram chat. Only linked DevRyan members can send requests. Unrelated desktop messages are not forwarded.</p>
      <p className="mt-2 typography-micro text-muted-foreground">Messages and attachments are processed by Telegram. This uses your existing private conversation, the Bot’s shared memory, and its shared computer with saved logins and files. Approvals and computer takeover stay in authenticated DevRyan.</p>
      <p className="mt-2 typography-micro text-muted-foreground">Keep the runtime host running to receive and send messages. Telegram attachments, including voice, are limited to 10 MiB. Telegram retains updates for at most 24 hours; requests not admitted within 15 minutes expire and must be resent.</p>
      {status && (status.hostOnline !== undefined || status.executionReady !== undefined) ? <p className="mt-2 typography-micro text-muted-foreground">Host: {status.hostOnline ? 'online' : 'offline'}. Bot execution: {status.executionReady ? 'ready' : 'waiting for runtime'}. Requests waiting for startup keep their original 15-minute expiry.</p> : null}
      {error ? <p role="alert" className="mt-3 typography-ui text-[var(--status-error)]">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 typography-ui">{notice}</p> : null}
      {status?.errorCode ? <p className="mt-2 typography-micro text-[var(--status-error)]">Connection needs attention: {status.errorCode}. A webhook or competing consumer must be removed by its owner; DevRyan will not take it over.</p> : null}
      {status?.state === 'migration_required' ? <p className="mt-3 typography-ui">Telegram database setup is required on this host. Existing Bot chat remains available.</p> : null}
      {canManage ? (
        <form className="mt-4 space-y-3" onSubmit={(event) => {
          event.preventDefault();
          void mutate(async (isCurrent) => {
            const result = await api.configureTelegram(botId, { enabled, ...(token ? { token } : {}) });
            if (isCurrent()) { setToken(''); setPairingLink(null); }
            return result;
          });
        }}>
          <label className="flex items-center gap-2 typography-ui"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />Enable Telegram for This Bot</label>
          <p className="typography-micro text-muted-foreground">Create a separate bot with <a className="underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a> using /newbot, then paste its token. Tokens stay encrypted on this host and are never given to the agent. Saving connection changes invalidates pending work; members must pair again.</p>
          <label className="block space-y-1 typography-ui"><span>{status?.configured ? 'Replace Telegram Token (Optional)' : 'Telegram Bot Token'}</span>
            <Input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} disabled={busy} placeholder={status?.configured ? 'Leave empty to keep the saved token' : 'Token from BotFather'} />
          </label>
          <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={busy || !status || status.state === 'migration_required' || (!status.configured && !token)}>Save Telegram</Button>
            {status?.configured ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void mutate(async (isCurrent) => { const result = await api.disconnectTelegram(botId); if (isCurrent()) { setToken(''); setPairingLink(null); } return result; })}>Disconnect Telegram</Button> : null}
          </div>
        </form>
      ) : null}
      {status?.canPair === false ? <p className="mt-4 typography-ui text-muted-foreground">You can manage this connection. Active Bot membership is required to pair your own Telegram account or view personal deliveries.</p> : null}
      {status?.enabled && status.canPair !== false ? <div className="mt-5 space-y-3 border-t border-border/60 pt-4">
        <h4 className="typography-ui-label font-medium">Your Telegram account</h4>
        {paired ? <p className="typography-ui">Linked numeric Telegram ID: {pairing.telegramUserId}</p> : <p className="typography-ui text-muted-foreground">Open a one-use pairing link, press Start in Telegram, then confirm the numeric account ID here. Never share the link.</p>}
        {pairing?.state === 'claimed' ? <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="typography-ui">Confirm this is your account: {pairing.displayName || 'Telegram user'} · numeric ID {pairing.telegramUserId}</p>
          <Button size="sm" disabled={busy} onClick={() => void mutate(() => api.confirmTelegramPairing(botId, pairing.id))}>Confirm My Account</Button>
        </div> : null}
        {!paired ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void mutate(async (isCurrent) => {
          const link = await api.createTelegramPairing(botId);
          if (isCurrent()) setPairingLink(link);
        })}>Create Pairing Link</Button> : null}
        {pairingLink && !paired ? <p className="typography-ui"><a href={pairingLink.url} target="_blank" rel="noreferrer" className="underline">Open pairing in Telegram</a> · expires {new Date(pairingLink.expiresAt).toLocaleTimeString()}</p> : null}
        {pairing ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate(async (isCurrent) => { const result = await api.revokeTelegramPairing(botId); if (isCurrent()) setPairingLink(null); return result; })}>Revoke My Pairing</Button> : null}
        {paired ? <div className="space-y-2">
          <label className="flex items-center gap-2 typography-ui"><input type="checkbox" checked={status.preferences.routineDelivery} disabled={busy} onChange={(e) => void mutate(() => api.setTelegramPreferences(botId, { ...status.preferences, routineDelivery: e.target.checked }))} />Send My Future Routine Results to Telegram</label>
          <label className="flex items-center gap-2 typography-ui"><input type="checkbox" checked={status.preferences.voiceReplies} disabled={busy} onChange={(e) => void mutate(() => api.setTelegramPreferences(botId, { ...status.preferences, voiceReplies: e.target.checked }))} />Speak Replies to My Voice Messages After Delivering Text</label>
        </div> : null}
        <p className="typography-micro text-muted-foreground">Commands: /help, /status and /cancel. Screens are never sent to Telegram.</p>
      </div> : null}
      {status?.deliveries.some((item) => ['failed', 'uncertain', 'rejected', 'admission_uncertain'].includes(item.state)) ? <div className="mt-4 space-y-2 border-t border-border pt-3">
        <h4 className="typography-ui-label">Delivery needs attention</h4>
        <p className="typography-micro text-muted-foreground">Retrying delivery never reruns the Bot. An uncertain send may have arrived; retrying it can duplicate the last part. Expired incoming requests must be resent from Telegram.</p>
        {status.deliveries.filter((item) => ['failed', 'uncertain', 'rejected', 'admission_uncertain'].includes(item.state)).map((item) => <div key={item.id} className="flex flex-wrap items-center gap-2 typography-micro">
          <span className="min-w-0 flex-1">{item.kind}: {item.state.replaceAll('_', ' ')}{item.errorCode ? ` · ${item.errorCode}` : ''}</span>
          {item.kind !== 'incoming' && ['failed', 'uncertain'].includes(item.state) ? <Button variant="outline" size="xs" disabled={busy} onClick={() => void mutate(async (isCurrent) => { const result = await api.retryTelegramDelivery(botId, item.id); if (isCurrent()) setNotice(result.mayDuplicateLastPart ? 'Delivery retry queued; the last part may appear twice.' : 'Delivery retry queued.'); })}>{item.state === 'uncertain' ? 'Retry (May Duplicate)' : 'Retry Delivery'}</Button> : null}
        </div>)}
      </div> : null}
      {canManage ? <BotSpeechSettings botId={botId} active={active} api={api} /> : null}
    </section>
  );
}
