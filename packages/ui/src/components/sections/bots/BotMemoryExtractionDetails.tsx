import React from 'react';
import { Button } from '@/components/ui/button';
import type { BotMemoryExtractionJob, BotsApi } from '@/lib/botsApi';

type ActivityApi = Partial<Pick<BotsApi, 'listBotMemoryExtractions' | 'requeueBotMemoryExtraction'>>;

const jobDescription = (job: BotMemoryExtractionJob): string => {
  if (job.state === 'leased') return 'Updating memory';
  if (job.state === 'queued') return job.phase === 'admission'
    ? 'Waiting for the conversation to finish' : 'Queued for automatic processing';
  if (job.state === 'succeeded') {
    if (job.outcome === 'no_facts') return 'No reusable facts in this conversation';
    if (job.outcome === 'filtered') return 'Facts excluded by memory policy';
    return 'Memory processing completed';
  }
  if (job.errorCode?.includes('encryption') || job.errorCode?.includes('envelope') || job.errorCode?.includes('decrypt')) {
    return 'Saved source data could not be decrypted. Restore access to the original encryption key.';
  }
  if (job.errorCode?.endsWith('_not_found')) return 'Required conversation data is unavailable.';
  if (job.outcome === 'invalid' || job.errorCode === 'bot_memory_extraction_invalid') {
    return 'The model returned unusable facts after automatic repair attempts.';
  }
  return 'Memory processing needs attention. Check the bot’s model connection before retrying.';
};

export function BotMemoryExtractionDetails({ botId, api, onChanged }: {
  botId: string; api: ActivityApi; onChanged: () => Promise<void>;
}) {
  const [jobs, setJobs] = React.useState<BotMemoryExtractionJob[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const request = React.useRef(0);
  const loadedPages = React.useRef(1);
  const load = React.useCallback(async (next: string | null = null) => {
    if (!api.listBotMemoryExtractions) return;
    const generation = ++request.current;
    setBusy(true);
    try {
      let page = await api.listBotMemoryExtractions(botId, { cursor: next, limit: 25 });
      let refreshedPages = 1;
      if (!next) {
        const allJobs = [...page.jobs];
        while (page.nextCursor && refreshedPages < loadedPages.current) {
          if (generation !== request.current) return;
          page = await api.listBotMemoryExtractions(botId, { cursor: page.nextCursor, limit: 25 });
          allJobs.push(...page.jobs);
          refreshedPages += 1;
        }
        page = { ...page, jobs: allJobs };
      }
      if (generation !== request.current) return;
      setJobs((current) => next ? [...current, ...page.jobs.filter((job) => !current.some((item) => item.runId === job.runId))] : page.jobs);
      loadedPages.current = next ? loadedPages.current + 1 : refreshedPages;
      setCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      if (generation === request.current) setError(cause instanceof Error ? cause.message : 'Memory activity is unavailable.');
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }, [api, botId]);
  React.useEffect(() => {
    void load();
    const refresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.botId === botId) void load();
    };
    const poll = window.setInterval(() => void load(), 30_000);
    window.addEventListener('devryan:bot-memory-changed', refresh);
    return () => { window.clearInterval(poll); request.current += 1; window.removeEventListener('devryan:bot-memory-changed', refresh); };
  }, [botId, load]);
  const retry = async (runId: string) => {
    setBusy(true);
    try {
      await api.requeueBotMemoryExtraction?.(botId, runId);
      await Promise.all([load(), onChanged()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Memory could not be queued.');
    } finally { setBusy(false); }
  };
  return <div className="space-y-3 rounded-lg border border-border/70 p-3" aria-label="Memory Activity">
    {error ? <p role="status" className="typography-ui text-muted-foreground">{error}</p> : null}
    {!busy && !error && jobs.length === 0 ? <p className="typography-ui text-muted-foreground">No memory activity yet.</p> : null}
    {jobs.map((job) => <div key={job.runId} className="flex items-start justify-between gap-3 border-b border-border/50 pb-2 last:border-0">
      <div className="min-w-0 space-y-1">
        <p className="typography-ui">{jobDescription(job)}</p>
        <p className="typography-micro text-muted-foreground">{new Date(job.createdAt).toLocaleString()}</p>
        {job.state === 'queued' && job.nextAttemptAt && job.phase !== 'admission'
          ? <p className="typography-micro text-muted-foreground">Next attempt: {new Date(job.nextAttemptAt).toLocaleTimeString()}</p> : null}
        {job.state === 'terminal' && job.errorCode
          ? <p className="break-all typography-micro text-muted-foreground">Diagnostic: {job.errorCode}{job.reason ? ` (${job.reason})` : ''}</p> : null}
      </div>
      {job.state === 'terminal' && api.requeueBotMemoryExtraction
        ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void retry(job.runId)}>Retry</Button> : null}
    </div>)}
    {cursor ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(cursor)}>Load More Activity</Button> : null}
  </div>;
}
