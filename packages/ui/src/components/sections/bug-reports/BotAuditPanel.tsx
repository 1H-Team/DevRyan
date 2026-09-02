import React from 'react';
import {
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiFilter3Line,
  RiLoader4Line,
  RiSearchLine,
} from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { clearBotAudit, getBotAudit, listBotAudit, listBotAuditOptions, listErrorLogActors } from './api';
import {
  botAuditResultLabelKey,
  type BotAuditBotOption,
  type BotAuditClearRange,
  type BotAuditDetail,
  type BotAuditResult,
  type BotAuditResultFilter,
  type BotAuditSummary,
  type ErrorLogActorOption,
} from './types';

type DateFilter = '24h' | '7d' | '30d' | 'all';

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZES = [50, 100, 200] as const;
const CLEAR_RANGES = [
  { value: '24h', labelKey: 'settings.bugReports.botAudit.clear.range24h' },
  { value: '7d', labelKey: 'settings.bugReports.botAudit.clear.range7d' },
  { value: '30d', labelKey: 'settings.bugReports.botAudit.clear.range30d' },
  { value: 'all', labelKey: 'settings.bugReports.botAudit.clear.rangeAll' },
] as const;
const RESULT_FILTERS: readonly BotAuditResultFilter[] = [
  'issues', 'failure', 'partial', 'unknown', 'denied', 'success', 'all',
];
const DATE_RANGES = [
  { value: '24h', hours: 24, labelKey: 'settings.bugReports.botAudit.date.range24h' },
  { value: '7d', hours: 24 * 7, labelKey: 'settings.bugReports.botAudit.date.range7d' },
  { value: '30d', hours: 24 * 30, labelKey: 'settings.bugReports.botAudit.date.range30d' },
  { value: 'all', hours: null, labelKey: 'settings.bugReports.botAudit.date.all' },
] as const;
const CORRELATION_KEYS = [
  'botId', 'runId', 'channelId', 'revisionId', 'agentAdapter', 'agentThreadId',
  'terminalState', 'failurePhase', 'retryable', 'retryCount',
] as const;

const dateFilterBound = (filter: DateFilter): string | null => {
  const range = DATE_RANGES.find((entry) => entry.value === filter);
  if (!range?.hours) return null;
  return new Date(Date.now() - range.hours * 60 * 60 * 1000).toISOString();
};

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

const resultBadgeClassName = (result: BotAuditResult): string => {
  if (result === 'failure') return 'bg-status-error/10 text-status-error';
  if (result === 'partial') return 'bg-status-warning/10 text-status-warning';
  if (result === 'unknown') return 'bg-status-info/10 text-status-info';
  if (result === 'success') return 'bg-status-success/10 text-status-success';
  return 'bg-[var(--surface-subtle)] text-muted-foreground';
};

const resultAccentClassName = (result: BotAuditResult): string => {
  if (result === 'failure') return 'bg-status-error';
  if (result === 'partial') return 'bg-status-warning';
  if (result === 'unknown') return 'bg-status-info';
  if (result === 'success') return 'bg-status-success';
  return 'bg-muted-foreground/55';
};

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const formatBotContext = (log: BotAuditDetail): string => [
  'DevRyan Bot audit context',
  `Event ID: ${log.eventId}`,
  `Bot: ${log.bot.name}${log.bot.id ? ` (${log.bot.id})` : ''}`,
  `User: ${log.actor.displayName}${log.actor.id ? ` (${log.actor.id})` : ''}`,
  `Action: ${log.action}`,
  `Result: ${log.result}`,
  `Target: ${log.target.type}${log.target.id ? ` (${log.target.id})` : ''}`,
  `Occurred: ${log.timestamp}`,
  `Diagnostic code: ${log.diagnosticCode || 'Unavailable'}`,
  '',
  'Content-free metadata:',
  JSON.stringify(log.metadata, null, 2),
].join('\n');

export const BotAuditPanel: React.FC = () => {
  const { t } = useI18n();
  const [resultFilter, setResultFilter] = React.useState<BotAuditResultFilter>('issues');
  const [botFilter, setBotFilter] = React.useState('all');
  const [actorFilter, setActorFilter] = React.useState('all');
  const [dateFilter, setDateFilter] = React.useState<DateFilter>('all');
  const [pageSize, setPageSize] = React.useState<number>(PAGE_SIZES[0]);
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [bots, setBots] = React.useState<BotAuditBotOption[]>([]);
  const [actors, setActors] = React.useState<ErrorLogActorOption[]>([]);
  const [logs, setLogs] = React.useState<BotAuditSummary[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [clearing, setClearing] = React.useState<BotAuditClearRange | null>(null);
  const clearInProgress = React.useRef(false);
  const listRequestId = React.useRef(0);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<BotAuditDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailRetryKey, setDetailRetryKey] = React.useState(0);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  React.useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      listBotAuditOptions(controller.signal),
      listErrorLogActors(controller.signal),
    ]).then(([botResult, actorResult]) => {
      if (controller.signal.aborted) return;
      setBots(botResult.status === 'fulfilled' ? botResult.value : []);
      setActors(actorResult.status === 'fulfilled' ? actorResult.value : []);
    });
    return () => controller.abort();
  }, []);

  const queryFilters = React.useMemo(() => ({
    result: resultFilter,
    bot: botFilter,
    actor: actorFilter,
    search,
    from: dateFilterBound(dateFilter),
    to: new Date().toISOString(),
    limit: pageSize,
  }), [actorFilter, botFilter, dateFilter, pageSize, resultFilter, search]);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    const requestId = ++listRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const page = await listBotAudit({ ...queryFilters, signal });
      if (requestId !== listRequestId.current || signal?.aborted) return;
      setLogs(page.items);
      setNextCursor(page.nextCursor);
    } catch (requestError) {
      if (requestId !== listRequestId.current) return;
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      if (requestId === listRequestId.current && !signal?.aborted) setLoading(false);
    }
  }, [queryFilters]);

  React.useEffect(() => {
    const controller = new AbortController();
    setSelectedEventId(null);
    setDetail(null);
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  React.useEffect(() => {
    if (!selectedEventId) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    setError(null);
    void getBotAudit(selectedEventId, controller.signal)
      .then(setDetail)
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [detailRetryKey, selectedEventId]);

  const loadMore = React.useCallback(async () => {
    if (!nextCursor || loadingMore || clearInProgress.current) return;
    const requestId = listRequestId.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listBotAudit({ ...queryFilters, cursor: nextCursor });
      if (requestId !== listRequestId.current) return;
      setLogs((current) => {
        const seen = new Set(current.map((log) => log.eventId));
        const additions = page.items.filter((log) => !seen.has(log.eventId));
        return additions.length > 0 ? [...current, ...additions] : current;
      });
      setNextCursor(page.nextCursor);
    } catch (requestError) {
      if (requestId !== listRequestId.current) return;
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, queryFilters]);

  const clearLogs = React.useCallback(async (range: (typeof CLEAR_RANGES)[number]) => {
    if (clearInProgress.current) return;
    const confirmation = range.value === 'all'
      ? t('settings.bugReports.botAudit.clear.confirmAll')
      : t('settings.bugReports.botAudit.clear.confirmRecent', { range: t(range.labelKey).toLocaleLowerCase() });
    if (!window.confirm(confirmation)) return;

    clearInProgress.current = true;
    setClearing(range.value);
    setError(null);
    try {
      const clearedCount = await clearBotAudit(range.value);
      listRequestId.current += 1;
      setLogs([]);
      setNextCursor(null);
      setSelectedEventId(null);
      setDetail(null);
      toast.success(t('settings.bugReports.botAudit.clear.success', { count: clearedCount }));
      await reload();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error(message);
    } finally {
      clearInProgress.current = false;
      setClearing(null);
    }
  }, [reload, t]);

  const copyBotContext = React.useCallback(async () => {
    if (!detail) return;
    const result = await copyTextToClipboard(formatBotContext(detail), {
      sourceSurface: 'settings',
      copyKind: 'text',
    });
    if (result.ok) toast.success(t('settings.bugReports.botAudit.contextCopied'));
    else toast.error(result.error);
  }, [detail, t]);

  const activeFilterCount = [
    resultFilter !== 'issues',
    botFilter !== 'all',
    actorFilter !== 'all',
    dateFilter !== 'all',
    pageSize !== PAGE_SIZES[0],
  ].filter(Boolean).length;

  const resetFilters = React.useCallback(() => {
    setResultFilter('issues');
    setBotFilter('all');
    setActorFilter('all');
    setDateFilter('all');
    setPageSize(PAGE_SIZES[0]);
  }, []);

  const botFilterLabel = botFilter === 'all'
    ? t('settings.bugReports.botAudit.bot.all')
    : bots.find((bot) => bot.id === botFilter)?.name ?? t('settings.bugReports.botAudit.bot.all');
  const actorFilterLabel = actorFilter === 'all'
    ? t('settings.bugReports.botAudit.user.all')
    : actors.find((actor) => actor.id === actorFilter)?.displayName ?? t('settings.bugReports.botAudit.user.all');
  const dateFilterLabel = t(
    DATE_RANGES.find((range) => range.value === dateFilter)?.labelKey
      ?? 'settings.bugReports.botAudit.date.all',
  );

  if (selectedEventId) {
    const correlationEntries = detail
      ? CORRELATION_KEYS
          .filter((key) => Object.hasOwn(detail.metadata, key))
          .map((key) => [key, detail.metadata[key]] as const)
      : [];
    return (
      <section aria-labelledby="bot-audit-detail-heading" className="space-y-5">
        <Button variant="outline" size="sm" onClick={() => setSelectedEventId(null)}>
          <RiArrowLeftLine className="h-4 w-4" />
          {t('settings.bugReports.botAudit.back')}
        </Button>

        {detailLoading ? (
          <div className="flex min-h-40 items-center justify-center gap-2 typography-meta text-muted-foreground" aria-busy="true">
            <RiLoader4Line className="h-4 w-4 animate-spin" />
            {t('settings.bugReports.botAudit.loading')}
          </div>
        ) : detail ? (
          <div className="space-y-6">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('rounded-full px-2 py-1 typography-micro font-semibold', resultBadgeClassName(detail.result))}>
                  {t(botAuditResultLabelKey(detail.result))}
                </span>
                <span className="typography-micro text-muted-foreground">{formatDateTime(detail.timestamp)}</span>
              </div>
              <h2 id="bot-audit-detail-heading" className="typography-ui-header font-semibold text-foreground">
                {detail.summary}
              </h2>
            </div>

            <Button variant="outline" size="sm" onClick={() => void copyBotContext()}>
              <RiFileCopyLine className="h-4 w-4" />
              {t('settings.bugReports.botAudit.copyContext')}
            </Button>

            {detail.metadataRedacted ? (
              <div role="status" className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning)]">
                {t('settings.bugReports.botAudit.metadataRedacted')}
              </div>
            ) : null}

            <dl className="grid gap-4 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4 sm:grid-cols-2">
              {[
                [t('settings.bugReports.botAudit.eventId'), detail.eventId, true],
                [t('settings.bugReports.botAudit.bot.label'), `${detail.bot.name}${detail.bot.deleted ? ` · ${t('settings.bugReports.botAudit.bot.deleted')}` : ''}`, false],
                [t('settings.bugReports.botAudit.user.label'), detail.actor.displayName, false],
                [t('settings.bugReports.botAudit.action'), detail.action, true],
                [t('settings.bugReports.botAudit.result.label'), t(botAuditResultLabelKey(detail.result)), false],
                [t('settings.bugReports.botAudit.target'), `${detail.target.type}${detail.target.id ? ` · ${detail.target.id}` : ''}`, true],
                [t('settings.bugReports.botAudit.occurred'), formatDateTime(detail.timestamp), false],
                [t('settings.bugReports.botAudit.diagnosticCode'), detail.diagnosticCode || '—', true],
                [t('settings.bugReports.botAudit.resolvedAt'), detail.resolvedAt ? formatDateTime(detail.resolvedAt) : '—', false],
                [t('settings.bugReports.botAudit.resolvedBy'), detail.resolvedByEventId || '—', true],
              ].map(([label, value, mono]) => (
                <div key={String(label)} className="min-w-0 space-y-1">
                  <dt className="typography-micro uppercase tracking-wide text-muted-foreground">{label}</dt>
                  <dd className={cn('break-all text-foreground', mono ? 'font-mono text-xs' : 'typography-meta')}>{value}</dd>
                </div>
              ))}
            </dl>

            {correlationEntries.length > 0 ? (
              <div className="space-y-2">
                <h3 className="typography-ui-label font-medium text-foreground">{t('settings.bugReports.botAudit.correlation')}</h3>
                <dl className="grid gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60 sm:grid-cols-2">
                  {correlationEntries.map(([key, value]) => (
                    <div key={key} className="min-w-0 bg-[var(--surface-subtle)] px-3 py-2">
                      <dt className="typography-micro text-muted-foreground">{key}</dt>
                      <dd className="break-all font-mono text-xs text-foreground">{displayValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}

            <div className="space-y-2">
              <h3 className="typography-ui-label font-medium text-foreground">{t('settings.bugReports.botAudit.metadata')}</h3>
              <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 p-4 font-mono text-xs leading-5 text-foreground">
                {JSON.stringify(detail.metadata, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)] sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => setDetailRetryKey((value) => value + 1)}>
              {t('settings.bugReports.common.retry')}
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-labelledby="bot-audit-list-heading" className="space-y-5">
      <div className="space-y-1">
        <h2 id="bot-audit-list-heading" className="typography-ui-header font-semibold text-foreground">
          {t('settings.bugReports.botAudit.title')}
        </h2>
        <p className="typography-meta text-muted-foreground">{t('settings.bugReports.botAudit.description')}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <RiSearchLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            disabled={clearing !== null}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            maxLength={200}
            placeholder={t('settings.bugReports.botAudit.search.placeholder')}
            aria-label={t('settings.bugReports.botAudit.search.placeholder')}
            className="h-9 w-full rounded-lg border border-border/60 bg-[var(--surface-elevated)] pl-9 pr-3 typography-ui-label text-foreground outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-[var(--interactive-focus-ring)]"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={loadingMore || clearing !== null}
              aria-label={activeFilterCount > 0
                ? t('settings.bugReports.botAudit.filter.active', { count: activeFilterCount })
                : t('settings.bugReports.botAudit.filter.action')}
            >
              <RiFilter3Line className="h-4 w-4" />
              {t('settings.bugReports.botAudit.filter.action')}
              {activeFilterCount > 0 ? (
                <span className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 typography-micro font-semibold text-primary-foreground" aria-hidden="true">
                  {activeFilterCount}
                </span>
              ) : null}
              <RiArrowDownSLine className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-64">
            <DropdownMenuLabel>{t('settings.bugReports.botAudit.filter.menuLabel')}</DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>{t('settings.bugReports.botAudit.result.label')}</span>
                <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{t(botAuditResultLabelKey(resultFilter))}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                <DropdownMenuRadioGroup value={resultFilter} onValueChange={(value) => setResultFilter(value as BotAuditResultFilter)}>
                  {RESULT_FILTERS.map((result) => (
                    <DropdownMenuRadioItem key={result} value={result}>{t(botAuditResultLabelKey(result))}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>{t('settings.bugReports.botAudit.bot.label')}</span>
                <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{botFilterLabel}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 min-w-52 overflow-y-auto">
                <DropdownMenuRadioGroup value={botFilter} onValueChange={setBotFilter}>
                  <DropdownMenuRadioItem value="all">{t('settings.bugReports.botAudit.bot.all')}</DropdownMenuRadioItem>
                  {bots.map((bot) => <DropdownMenuRadioItem key={bot.id} value={bot.id}>{bot.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>{t('settings.bugReports.botAudit.user.label')}</span>
                <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{actorFilterLabel}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 min-w-52 overflow-y-auto">
                <DropdownMenuRadioGroup value={actorFilter} onValueChange={setActorFilter}>
                  <DropdownMenuRadioItem value="all">{t('settings.bugReports.botAudit.user.all')}</DropdownMenuRadioItem>
                  {actors.map((actor) => <DropdownMenuRadioItem key={actor.id} value={actor.id}>{actor.displayName}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>{t('settings.bugReports.botAudit.date.label')}</span>
                <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{dateFilterLabel}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                <DropdownMenuRadioGroup value={dateFilter} onValueChange={(value) => setDateFilter(value as DateFilter)}>
                  {DATE_RANGES.map((range) => <DropdownMenuRadioItem key={range.value} value={range.value}>{t(range.labelKey)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>{t('settings.bugReports.botAudit.pageSize')}</span>
                <span className="ml-auto typography-meta text-muted-foreground">{pageSize}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-36">
                <DropdownMenuRadioGroup value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
                  {PAGE_SIZES.map((size) => <DropdownMenuRadioItem key={size} value={String(size)}>{size}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={activeFilterCount === 0} onSelect={resetFilters}>
              {t('settings.bugReports.botAudit.filter.reset')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={loading || loadingMore || clearing !== null}>
              {clearing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiDeleteBinLine className="h-4 w-4" />}
              {t('settings.bugReports.errors.clear.action')}
              <RiArrowDownSLine className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel>{t('settings.bugReports.errors.clear.menuLabel')}</DropdownMenuLabel>
            {CLEAR_RANGES.map((range) => (
              <DropdownMenuItem key={range.value} variant="destructive" onClick={() => void clearLogs(range)}>
                {t(range.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {loading ? (
        <div className="flex min-h-40 items-center justify-center gap-2 typography-meta text-muted-foreground" aria-busy="true">
          <RiLoader4Line className="h-4 w-4 animate-spin" />
          {t('settings.bugReports.botAudit.loading')}
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center typography-meta text-muted-foreground">
          {search || activeFilterCount > 0
            ? t('settings.bugReports.botAudit.filteredEmpty')
            : t('settings.bugReports.botAudit.empty')}
        </div>
      ) : (
        <ul className="space-y-2">
          {logs.map((log) => (
            <li key={log.eventId}>
              <button
                type="button"
                onClick={() => setSelectedEventId(log.eventId)}
                className="group relative w-full overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)] py-3 pl-5 pr-4 text-left outline-none transition hover:border-border hover:bg-[var(--interactive-hover)] focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
              >
                <span className={cn('absolute inset-y-2 left-0 w-1 rounded-r-full', resultAccentClassName(log.result))} aria-hidden="true" />
                <span className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <span className="min-w-0">
                    <span className="block truncate typography-ui-label font-medium text-foreground">{log.summary}</span>
                    <span className="mt-1 block truncate typography-micro text-muted-foreground">
                      {log.bot.name} · {log.actor.displayName} · {formatDateTime(log.timestamp)}
                    </span>
                  </span>
                  <span className="flex w-fit shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {log.resolvedAt ? (
                      <span className="rounded-full bg-status-success/10 px-2 py-1 typography-micro font-semibold text-status-success" data-bot-audit-resolved="true">
                        {t('settings.bugReports.botAudit.resolved')}
                      </span>
                    ) : null}
                    {log.diagnosticCode ? (
                      <span className="max-w-52 truncate rounded-full border border-border/60 px-2 py-1 font-mono text-[10px] text-muted-foreground">{log.diagnosticCode}</span>
                    ) : null}
                    <span className={cn('rounded-full px-2 py-1 typography-micro font-semibold', resultBadgeClassName(log.result))}>
                      {t(botAuditResultLabelKey(log.result))}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)] sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>{t('settings.bugReports.common.retry')}</Button>
        </div>
      ) : null}

      {nextCursor && !loading ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore || clearing !== null}>
            {loadingMore ? t('settings.bugReports.botAudit.loadingMore') : t('settings.bugReports.botAudit.loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
