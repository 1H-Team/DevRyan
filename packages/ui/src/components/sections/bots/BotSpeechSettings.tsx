import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type BotsApi, type BotSpeechConfiguration, type BotSpeechStatus } from '@/lib/botsApi';

type SpeechDraft = { enabled: boolean; stt: NonNullable<BotSpeechConfiguration['stt']>; tts: NonNullable<BotSpeechConfiguration['tts']> };
const empty: SpeechDraft = { enabled: false, stt: { baseUrl: '', model: '' }, tts: { baseUrl: '', model: '', voice: '' } };
export function BotSpeechSettings({ botId, active, api }: { botId: string; active: boolean; api: BotsApi }) {
  const [status, setStatus] = React.useState<BotSpeechStatus | null>(null);
  const [draft, setDraft] = React.useState(empty);
  const [error, setError] = React.useState<string | null>(null);
  const [check, setCheck] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const generation = React.useRef(0);
  const alive = React.useRef(true);
  const pending = React.useRef(false);
  const visible = React.useRef(active && open);
  visible.current = active && open;
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const apply = (result: BotSpeechStatus) => {
    setStatus(result); setDraft({ enabled: result.enabled,
      stt: { baseUrl: result.stt?.baseUrl ?? '', model: result.stt?.model ?? '' },
      tts: { baseUrl: result.tts?.baseUrl ?? '', model: result.tts?.model ?? '', voice: result.tts?.voice ?? '' } });
  };
  React.useEffect(() => {
    const request = ++generation.current;
    if (!active || !open) { setLoading(false); setDraft((previous) => ({ ...previous, stt: { ...previous.stt, apiKey: undefined }, tts: { ...previous.tts, apiKey: undefined } })); return; }
    setLoading(true); setError(null); setCheck(null);
    void api.getSpeechStatus(botId).then((result) => { if (alive.current && request === generation.current) apply(result); })
      .catch(() => { if (alive.current && request === generation.current) setError('Speech settings are unavailable on this host. Reopen to retry.'); })
      .finally(() => { if (alive.current && request === generation.current) setLoading(false); });
  }, [active, open, api, botId, reload]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (pending.current || !active || !open || loading) return;
    pending.current = true;
    const request = ++generation.current; setBusy(true); setError(null); setCheck(null);
    try {
      const result = await api.configureSpeech(botId, { enabled: draft.enabled,
        stt: draft.stt.baseUrl || draft.stt.model ? draft.stt : null,
        tts: draft.tts.baseUrl || draft.tts.model ? draft.tts : null });
      if (alive.current && request === generation.current) apply(result);
    } catch { if (alive.current && request === generation.current) setError('Speech configuration could not be saved. Check the endpoint, model and credentials, then retry.'); }
    finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        if (visible.current && request !== generation.current) setReload((value) => value + 1);
      }
    }
  };
  return <details className="mt-5 border-t border-border/60 pt-3" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer typography-ui-label">Voice processing</summary>
    <p className="mt-2 typography-micro text-muted-foreground">Explicit server-owned, OpenAI-compatible speech endpoints. Audio and reply text are sent to these services. Browser settings, chat OAuth and host-wide API keys are never reused. Text arrives first; speech failure does not rerun the Bot.</p>
    <p className="mt-2 typography-micro text-muted-foreground">Limits: 5 minutes and 20 MiB incoming audio; one transcription and one synthesis at a time per Bot; 4,000 characters for automatic spoken replies. Longer answers remain complete in text.</p>
    {error ? <p role="alert" className="mt-2 typography-ui text-[var(--status-error)]">{error}</p> : null}
    {check ? <p role="status" className="mt-2 typography-ui">{check}</p> : null}
    <form onSubmit={(event) => void save(event)} className="mt-3 space-y-3">
      <fieldset disabled={busy || loading || !active || !open || !status} className="space-y-3">
        <label className="flex items-center gap-2 typography-ui"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((previous) => ({ ...previous, enabled: event.target.checked }))} />Enable External Speech Processing</label>
        {(['stt', 'tts'] as const).map((kind) => <div key={kind} className="space-y-2 rounded-lg border border-border/60 p-3">
          <h4 className="typography-ui-label">{kind === 'stt' ? 'Incoming transcription' : 'Spoken replies'} · {status?.[kind]?.ready ? 'Configured' : 'Not ready'}</h4>
          <label className="block typography-micro">Endpoint Base URL<Input type="url" placeholder="https://speech.example/v1" value={draft[kind].baseUrl} onChange={(event) => setDraft((previous) => ({ ...previous, [kind]: { ...previous[kind], baseUrl: event.target.value } }))} /></label>
          <label className="block typography-micro">Model<Input value={draft[kind].model} onChange={(event) => setDraft((previous) => ({ ...previous, [kind]: { ...previous[kind], model: event.target.value } }))} /></label>
          {kind === 'tts' ? <label className="block typography-micro">Voice<Input value={draft.tts.voice} onChange={(event) => setDraft((previous) => ({ ...previous, tts: { ...previous.tts, voice: event.target.value } }))} /></label> : null}
          <label className="block typography-micro">API Key{status?.[kind]?.hasApiKey ? ' (Saved; Leave Unchanged to Retain)' : ''}<Input type="password" autoComplete="new-password" value={draft[kind].apiKey ?? ''} onChange={(event) => setDraft((previous) => ({ ...previous, [kind]: { ...previous[kind], apiKey: event.target.value } }))} /></label>
        </div>)}
        <Button type="submit" size="sm">Save Speech Settings</Button>
        <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => {
          if (pending.current || !active || !open || loading) return;
          pending.current = true;
          const request = ++generation.current; setBusy(true); setCheck(null);
          void api.checkSpeech(botId).then((result) => {
            if (alive.current && generation.current === request) setCheck(`Transcription: ${result.stt.ready ? 'ready' : result.stt.code || 'unavailable'}. Spoken replies: ${result.tts.ready ? 'ready' : result.tts.code || 'unavailable'}.`);
          }).catch(() => { if (alive.current && generation.current === request) setError('Could not verify the saved speech provider.'); })
            .finally(() => { pending.current = false; if (alive.current) setBusy(false); });
        }}>Check Saved Providers</Button>
      </fieldset>
    </form>
  </details>;
}
