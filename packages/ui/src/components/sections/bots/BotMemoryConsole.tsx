import React from 'react';
import { RiDatabase2Line, RiRefreshLine, RiSearchLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  botsApi,
  type BotMemory,
  type BotMemoryDetail,
  type BotMemoryExtractionSummary,
  type BotsApi,
} from '@/lib/botsApi';
import { cn } from '@/lib/utils';
import { BotMemoryEditor, type BotMemoryEditRequest } from './BotMemoryEditor';

type MemoryApi = Pick<BotsApi,
  | 'listBotMemories'
  | 'getBotMemory'
  | 'editBotMemory'
  | 'tombstoneBotMemory'
  | 'restoreBotMemory'
> & Partial<Pick<BotsApi, 'requeueBotMemoryExtraction'>>;

// A refresh replaces the first page but keeps every page the user already
// scrolled to, so a memory reached through "Load More" never vanishes from the
// list when an event or the recovery poll refetches page one.
const mergeMemoryPages = (
  current: readonly BotMemory[],
  page: readonly BotMemory[],
  firstPage: boolean,
): BotMemory[] => {
  if (!firstPage) {
    const known = new Set(current.map((memory) => memory.id));
    return [...current, ...page.filter((memory) => !known.has(memory.id))];
  }
  const incoming = new Map(page.map((memory) => [memory.id, memory]));
  const retained = current.filter((memory) => !incoming.has(memory.id));
  return [...page, ...retained].sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
  ));
};

const extractionStatusText = (summary: BotMemoryExtractionSummary | null | undefined) => {
  if (!summary) return null;
  const parts: string[] = [];
  if (!summary.workerStarted) parts.push('Memory extraction is paused until the retrieval index is reachable.');
  if (summary.pending > 0) {
    parts.push(`Extraction pending for ${summary.pending} recent ${summary.pending === 1 ? 'turn' : 'turns'}.`);
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed} recent ${summary.failed === 1 ? 'turn' : 'turns'} failed extraction.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
};

export type BotMemoryConsoleProps = {
  botId: string;
  api?: MemoryApi;
};

type Filter = 'active' | 'forgotten';

export const BotMemoryConsole: React.FC<BotMemoryConsoleProps> = ({
  botId,
  api = botsApi,
}) => {
  const [memories, setMemories] = React.useState<BotMemory[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<BotMemoryDetail | null>(null);
  const [filter, setFilter] = React.useState<Filter>('active');
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>('load');
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [extraction, setExtraction] = React.useState<BotMemoryExtractionSummary | null>(null);
  const filterRef = React.useRef<Filter>(filter);
  filterRef.current = filter;

  const load = React.useCallback(async (cursor: string | null = null, options: { reset?: boolean } = {}) => {
    setBusy('load');
    const state = filterRef.current;
    try {
      const page = await api.listBotMemories(botId, { cursor, limit: 100, state });
      if (filterRef.current !== state) return;
      setMemories((current) => (options.reset
        ? [...page.memories]
        : mergeMemoryPages(current, page.memories, cursor === null)));
      if (cursor === null || options.reset) setNextCursor(page.nextCursor);
      else setNextCursor(page.nextCursor);
      if (page.extraction !== undefined) setExtraction(page.extraction ?? null);
      setSelectedId((current) => current || page.memories[0]?.id || null);
      setFeedback(null);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to load Bot memory.');
    } finally {
      setBusy(null);
    }
  }, [api, botId]);

  const requeueExtractions = async (runIds: readonly string[]) => {
    if (typeof api.requeueBotMemoryExtraction !== 'function') return;
    setBusy('requeue-all');
    let queued = 0;
    const failures: string[] = [];
    for (const runId of runIds) {
      try {
        await api.requeueBotMemoryExtraction(botId, runId);
        queued += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Extraction could not be queued again.');
      }
    }
    await load();
    if (failures.length === 0) {
      setFeedback(`${queued} failed ${queued === 1 ? 'extraction' : 'extractions'} queued again.`);
    } else {
      setFeedback(`${queued} queued again; ${failures.length} could not be queued. ${failures[0]}`);
    }
    setBusy(null);
  };

  const loadDetail = React.useCallback(async (memoryId: string) => {
    setBusy('detail');
    try {
      const next = await api.getBotMemory(botId, memoryId);
      setDetail(next);
      setMemories((current) => current.map((memory) => (
        memory.id === next.memory.id ? next.memory : memory
      )));
      setFeedback(null);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to load memory provenance.');
    } finally {
      setBusy(null);
    }
  }, [api, botId]);

  React.useEffect(() => {
    setMemories([]);
    setNextCursor(null);
    void load(null, { reset: true });
  }, [load, filter]);
  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  React.useEffect(() => {
    const refresh = (event: Event) => {
      const changedBotId = event instanceof CustomEvent
        && typeof event.detail?.botId === 'string'
        ? event.detail.botId
        : null;
      if (changedBotId && changedBotId !== botId) return;
      void load();
      if (selectedId) void loadDetail(selectedId);
    };
    window.addEventListener('devryan:bot-memory-changed', refresh);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh(new Event('poll'));
    }, 15_000);
    return () => {
      window.removeEventListener('devryan:bot-memory-changed', refresh);
      window.clearInterval(interval);
    };
  }, [botId, load, loadDetail, selectedId]);

  const refreshSelected = async (message: string) => {
    if (!selectedId) return;
    await Promise.all([load(), loadDetail(selectedId)]);
    setFeedback(message);
  };

  const mutate = async (operation: string, action: () => Promise<unknown>, message: string) => {
    setBusy(operation);
    try {
      await action();
      await refreshSelected(message);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Bot memory operation failed.');
    } finally {
      setBusy(null);
    }
  };

  const filtered = memories.filter((memory) => {
    if (filter === 'forgotten' && !memory.tombstonedAt) return false;
    if (filter === 'active' && memory.tombstonedAt) return false;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return !normalizedQuery
      || memory.logicalKey.toLocaleLowerCase().includes(normalizedQuery)
      || memory.content.text.toLocaleLowerCase().includes(normalizedQuery);
  });
  const extractionStatus = extractionStatusText(extraction);
  const failedExtractions = (extraction?.recent ?? []).filter((job) => job.state === 'terminal');

  const save = (request: BotMemoryEditRequest) => {
    if (!detail) return;
    void mutate(
      'save',
      () => api.editBotMemory(botId, detail.memory.id, request),
      'Memory updated.',
    );
  };

  return (
    <section className="space-y-4" aria-labelledby="bot-memory-console-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <RiDatabase2Line className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h3 id="bot-memory-console-heading" className="typography-ui-header font-semibold text-foreground">Memory</h3>
          </div>
          <p className="typography-ui text-muted-foreground">
            Useful facts this Bot keeps between conversations.
          </p>
        </div>
        <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void load()}>
          <RiRefreshLine className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['active', 'forgotten'] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="xs"
            variant="chip"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === 'active' ? 'Remembered' : 'Forgotten'}
          </Button>
        ))}
        <label className="relative ml-auto min-w-52 flex-1 sm:max-w-xs">
          <RiSearchLine className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Memory"
            aria-label="Search Memory"
            className="pl-8"
          />
        </label>
      </div>

      {feedback ? (
        <p role="status" className="rounded-lg border border-border/70 bg-[var(--surface-subtle)]/45 px-3 py-2 typography-ui text-foreground">
          {feedback}
        </p>
      ) : null}

      {extractionStatus ? (
        <div
          role="status"
          data-bot-memory-extraction-status
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-[var(--surface-subtle)]/45 px-3 py-2 typography-ui text-foreground"
        >
          <span className="min-w-0 flex-1">{extractionStatus}</span>
          {failedExtractions.length > 0 && typeof api.requeueBotMemoryExtraction === 'function' ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void requeueExtractions(failedExtractions.map((job) => job.runId))}
            >
              Re-Run All Failed Extractions
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid min-h-[32rem] overflow-hidden rounded-xl border border-border/70 lg:grid-cols-[minmax(14rem,0.8fr)_minmax(0,2fr)]">
        <div className="border-b border-border/70 bg-[var(--surface-subtle)]/25 lg:border-b-0 lg:border-r">
          <div className="max-h-[32rem] overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="p-3 typography-ui text-muted-foreground">No memory matches this view.</p>
            ) : filtered.map((memory) => (
              <button
                key={memory.id}
                type="button"
                onClick={() => setSelectedId(memory.id)}
                className={cn(
                  'mb-1 w-full rounded-lg border border-transparent p-2.5 text-left transition-colors last:mb-0',
                  'hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45',
                  selectedId === memory.id && 'border-border/70 bg-background',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate typography-ui-label font-medium text-foreground">{memory.logicalKey}</span>
                  {memory.unreadable
                    ? <span className="typography-micro text-[var(--status-error)]">Unreadable</span>
                    : memory.tombstonedAt ? <span className="typography-micro text-muted-foreground">Forgotten</span> : null}
                </div>
                <p className="mt-1 line-clamp-2 typography-micro text-muted-foreground">
                  {memory.unreadable ? 'This Memory Could Not Be Decrypted with the Current Key.' : memory.content.text}
                </p>
              </button>
            ))}
          </div>
          {nextCursor ? (
            <div className="border-t border-border/70 p-2">
              <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void load(nextCursor)}>
                Load More Memory
              </Button>
            </div>
          ) : null}
        </div>

        <div className="min-w-0 p-4 sm:p-5">
          {detail && detail.memory.id === selectedId ? (
            <BotMemoryEditor
              detail={detail}
              busy={busy !== null}
              onSave={save}
              onTombstone={() => void mutate(
                'tombstone',
                () => api.tombstoneBotMemory(botId, detail.memory.id, detail.memory.updatedAt),
                'Memory forgotten. It will no longer be used in replies.',
              )}
              onRestore={() => void mutate(
                'restore',
                () => api.restoreBotMemory(botId, detail.memory.id, detail.memory.updatedAt),
                'Memory restored. It may be used in future replies.',
              )}
            />
          ) : (
            <div className="flex min-h-80 items-center justify-center typography-ui text-muted-foreground">
              {busy ? 'Loading memory…' : 'Select a memory.'}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
