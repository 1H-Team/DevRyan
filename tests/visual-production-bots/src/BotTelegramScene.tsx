import React from 'react';
import { BotTelegramConnection } from '@/components/sections/bots/BotTelegramConnection';
import { createBotsApi, type BotTelegramStatus, type BotSpeechStatus } from '@/lib/botsApi';
import { Button } from '@/components/ui/button';

const botId = 'b0000000-0000-4000-8000-000000000001';
const initial = (): BotTelegramStatus => ({ enabled: false, configured: false, state: 'disabled', pairing: null,
  preferences: { routineDelivery: false, voiceReplies: true }, deliveries: [] });

export function BotTelegramScene() {
  const [generation, setGeneration] = React.useState(0);
  const backend = React.useRef(initial());
  const speech = React.useRef<BotSpeechStatus>({ botId, enabled: false, generation: 'fixture', stt: null, tts: null,
    limits: { maximumInputSeconds: 300, maximumInputBytes: 20971520, maximumReplyCharacters: 4000 } });
  const api = React.useMemo(() => createBotsApi({ fetchImpl: async (input, init) => {
    const url = String(input); const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    let result: unknown = backend.current;
    if (url.endsWith('/speech/check')) result = { stt: { ready: true, code: null }, tts: { ready: false, code: 'model_not_found' } };
    else if (url.endsWith('/speech')) {
      if (method === 'PUT') speech.current = { ...speech.current, enabled: body.enabled,
        stt: body.stt ? { baseUrl: body.stt.baseUrl, model: body.stt.model, ready: true, hasApiKey: true } : null,
        tts: body.tts ? { baseUrl: body.tts.baseUrl, model: body.tts.model, voice: body.tts.voice, ready: true, hasApiKey: true } : null };
      result = speech.current;
    } else if (url.endsWith('/pairing/confirm')) {
      backend.current = { ...backend.current, pairing: backend.current.pairing ? { ...backend.current.pairing, state: 'confirmed' } : null };
      result = backend.current;
    } else if (url.endsWith('/pairing') && method === 'POST') {
      backend.current = { ...backend.current, pairing: { id: 'fixture-pairing', state: 'claimed', telegramUserId: '987654321', displayName: 'Disposable fixture member', expiresAt: new Date(Date.now() + 600000).toISOString(), confirmedAt: null } };
      result = { pairingId: 'fixture-pairing', url: 'https://t.me/DevRyanFixtureBot?start=fixture-only', expiresAt: backend.current.pairing?.expiresAt };
    } else if (url.endsWith('/pairing') && method === 'DELETE') { backend.current = { ...backend.current, pairing: null }; result = backend.current; }
    else if (url.endsWith('/preferences')) { backend.current = { ...backend.current, preferences: body }; result = backend.current; }
    else if (url.endsWith('/deliveries/retry')) { backend.current = { ...backend.current, deliveries: [] }; result = { retryQueued: true, mayDuplicateLastPart: true }; }
    else if (method === 'PUT') { backend.current = { ...backend.current, enabled: body.enabled, configured: true, state: body.enabled ? 'connected' : 'disabled', username: 'DevRyanFixtureBot', botIdentity: '123456', pairing: null }; result = backend.current; }
    else if (method === 'DELETE') { backend.current = initial(); result = backend.current; }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  } }), []);
  return <div className="mx-auto max-w-3xl space-y-4 p-4">
    <p className="typography-ui">Telegram settings fixture. All requests are synthetic and stay in this page. Use only invented credentials.</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => { backend.current = initial(); setGeneration((v) => v + 1); }}>Reset fixture</Button>
      <Button variant="outline" onClick={() => { backend.current = { ...backend.current, enabled: true, configured: true, state: 'conflict', errorCode: 'telegram_consumer_conflict' }; setGeneration((v) => v + 1); }}>Simulate consumer conflict</Button>
      <Button variant="outline" onClick={() => { backend.current = { ...backend.current, deliveries: [{ id: 'fixture-delivery', kind: 'response', state: 'uncertain', errorCode: 'telegram_delivery_uncertain', partIndex: 1, createdAt: '', updatedAt: '' }] }; setGeneration((v) => v + 1); }}>Simulate uncertain delivery</Button>
    </div>
    <BotTelegramConnection key={generation} botId={botId} canManage active api={api} />
  </div>;
}
