import React from 'react';
import { Button } from '@/components/ui/button';
import { BotMemoryConsole } from '@/components/sections/bots/BotMemoryConsole';
import { createBotsApi, type BotMemory, type BotMemoryExtractionJob, type BotMemoryExtractionSummary } from '@/lib/botsApi';

const FIRST_BOT = 'b0000000-0000-4000-8000-000000000001';
const SECOND_BOT = 'b0000000-0000-4000-8000-000000000002';
const timestamp = '2026-09-08T18:00:00.000Z';
const fact = (botId: string): BotMemory => ({
  id: `memory-${botId}`, botId, scope: 'shared', subjectUserId: null,
  logicalKey: 'preference.reports', content: { text: botId === FIRST_BOT ? 'Weekly reports should use concise bullet points.' : 'Second bot reports should include a table.' },
  sensitivity: 'normal', confidence: 0.9, activeVersionId: 'version-1', activeCreatorKind: 'classifier',
  createdAt: timestamp, updatedAt: timestamp, tombstonedAt: null,
});

export function BotMemoryScene({ initialState }: { initialState: string }) {
  const [botId, setBotId] = React.useState(FIRST_BOT);
  const backend = React.useRef({ state: initialState.replace('memory_', ''), saved: false });
  const api = React.useMemo(() => createBotsApi({ fetchImpl: async (input) => {
    const url = new URL(String(input), window.location.origin);
    const currentBot = url.pathname.includes(SECOND_BOT) ? SECOND_BOT : FIRST_BOT;
    if (backend.current.state === 'unavailable') return new Response('Unavailable', { status: 503 });
    if (url.pathname.endsWith('/extractions')) {
      const offset = Number(url.searchParams.get('cursor') || 0);
      const limit = Number(url.searchParams.get('limit') || 25);
      const jobs: BotMemoryExtractionJob[] = Array.from({ length: Math.min(limit, 135 - offset) }, (_, index) => ({
        runId: `activity-${offset + index}`, channelId: 'fixture-channel',
        state: backend.current.saved ? 'succeeded' : (offset + index === 30 ? 'terminal' : 'queued'),
        phase: backend.current.state === 'waiting' ? 'admission' : 'classification',
        errorCode: offset + index === 30 ? 'bot_memory_extraction_invalid' : null,
        reason: offset + index === 30 ? 'shape' : null,
        outcome: backend.current.saved ? 'saved' : null, attemptCount: 1,
        nextAttemptAt: timestamp, completedAt: null, createdAt: new Date(Date.parse(timestamp) - (offset + index) * 60_000).toISOString(),
        updatedAt: timestamp,
      }));
      return Response.json({ jobs, nextCursor: offset + limit < 135 ? String(offset + limit) : null });
    }
    if (url.pathname.endsWith('/memories')) {
      const extraction: BotMemoryExtractionSummary = {
        pending: backend.current.saved ? 0 : 235, failed: backend.current.state === 'attention' ? 110 : 0,
        waiting: backend.current.state === 'waiting' ? 235 : 0, recovering: backend.current.saved ? 0 : 120,
        nextAttemptAt: timestamp, workerStarted: true, recent: [],
      };
      return Response.json({ memories: backend.current.saved ? [fact(currentBot)] : [], nextCursor: null, extraction });
    }
    if (url.pathname.includes('/memories/')) {
      // A slow first bot detail response also exercises switching in flight.
      if (currentBot === FIRST_BOT) await new Promise((resolve) => setTimeout(resolve, 150));
      return Response.json({ memory: fact(currentBot), versions: [], sources: [] });
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  } }), []);
  const update = (state: string, saved = false) => {
    backend.current = { state, saved };
    window.dispatchEvent(new CustomEvent('devryan:bot-memory-changed', { detail: { botId } }));
  };
  return <div className="mx-auto max-w-4xl space-y-4 p-4">
    <div className="flex flex-wrap gap-2" aria-label="Memory fixture controls">
      {['updating', 'waiting', 'attention', 'unavailable'].map((state) => <Button key={state} size="sm" variant="outline" onClick={() => update(state)}>{state}</Button>)}
      <Button size="sm" variant="outline" onClick={() => update('up_to_date', true)}>Publish fact</Button>
      <Button size="sm" variant="outline" onClick={() => setBotId((current) => current === FIRST_BOT ? SECOND_BOT : FIRST_BOT)}>Switch bot</Button>
    </div>
    <BotMemoryConsole botId={botId} api={api} />
  </div>;
}
