import React from 'react';
import {
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiFileCopyLine,
  RiFilter3Line,
  RiLoader4Line,
  RiSearchLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
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
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { clearErrorLogs, getErrorLog, listErrorLogActors, listErrorLogs } from './api';
import {
  diagnosticDispositionLabelKey,
  diagnosticImpactLabelKey,
  diagnosticOutcomeLabelKey,
  errorLogKindLabelKey,
  type DiagnosticDisposition,
  type DiagnosticImpact,
  type ErrorLogActorOption,
  type ErrorLogClearRange,
  type ErrorLogDetail,
  type ErrorLogKind,
  type ErrorLogSummary,
} from './types';

type KindFilter = ErrorLogKind | 'all';
type DispositionFilter = DiagnosticDisposition | 'all';
type ImpactFilter = DiagnosticImpact | 'all';
type DateFilter = '24h' | '7d' | '30d' | 'all';

const SEARCH_DEBOUNCE_MS = 300;

const DATE_RANGES = [
  { value: '24h', hours: 24, labelKey: 'settings.bugReports.errors.dateFilter.range24h' },
  { value: '7d', hours: 24 * 7, labelKey: 'settings.bugReports.errors.dateFilter.range7d' },
  { value: '30d', hours: 24 * 30, labelKey: 'settings.bugReports.errors.dateFilter.range30d' },
  { value: 'all', hours: null, labelKey: 'settings.bugReports.errors.dateFilter.all' },
] as const satisfies ReadonlyArray<{
  value: DateFilter;
  hours: number | null;
  labelKey:
    | 'settings.bugReports.errors.dateFilter.range24h'
    | 'settings.bugReports.errors.dateFilter.range7d'
    | 'settings.bugReports.errors.dateFilter.range30d'
    | 'settings.bugReports.errors.dateFilter.all';
}>;

const PAGE_SIZES = [50, 100, 200] as const;

const dateFilterBound = (filter: DateFilter): string | null => {
  const range = DATE_RANGES.find((entry) => entry.value === filter);
  if (!range?.hours) return null;
  return new Date(Date.now() - range.hours * 60 * 60 * 1000).toISOString();
};

const CLEAR_RANGES = [
  { value: '24h', labelKey: 'settings.bugReports.errors.clear.range24h' },
  { value: '7d', labelKey: 'settings.bugReports.errors.clear.range7d' },
  { value: '14d', labelKey: 'settings.bugReports.errors.clear.range14d' },
  { value: 'all', labelKey: 'settings.bugReports.errors.clear.rangeAll' },
] as const satisfies ReadonlyArray<{
  value: ErrorLogClearRange;
  labelKey:
    | 'settings.bugReports.errors.clear.range24h'
    | 'settings.bugReports.errors.clear.range7d'
    | 'settings.bugReports.errors.clear.range14d'
    | 'settings.bugReports.errors.clear.rangeAll';
}>;

const impactBadgeClassName = (impact: DiagnosticImpact): string => {
  if (impact === 'critical') return 'bg-status-error text-[var(--status-error-foreground)]';
  if (impact === 'high') return 'bg-status-error/10 text-status-error';
  if (impact === 'medium') return 'bg-status-warning/10 text-status-warning';
  return 'bg-status-info/10 text-status-info';
};

const impactAccentClassName = (impact: DiagnosticImpact): string => {
  if (impact === 'critical') return 'w-1.5 bg-status-error';
  if (impact === 'high') return 'bg-status-error';
  if (impact === 'medium') return 'bg-status-warning';
  return 'bg-status-info';
};

const formatFailureClass = (value: string): string =>
  value
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const formatAgentContext = (log: ErrorLogDetail): string =>
  [
    'DevRyan captured diagnostic',
    `Event ID: ${log.eventId}`,
    `Kind: ${log.kind}`,
    `Action: ${log.action}`,
    `Impact: ${log.impact}`,
    `Disposition: ${log.disposition}`,
    `Classification source: ${log.classificationSource}`,
    `Failure class: ${log.failureClass}`,
    `Outcome: ${log.outcome}`,
    `Occurred: ${log.createdAt}`,
    `User: ${log.actor ? `${log.actor.displayName} (${log.actor.role}, ${log.actor.id})` : 'Unavailable'}`,
    `Project: ${log.project ? `${log.project.label} (${log.project.id})` : 'Unavailable'}`,
    `Session: ${log.sessionId || 'Unavailable'}`,
    ...(log.failureText ? ['', 'Failure text:', log.failureText] : []),
    ...(log.stack ? ['', 'Stack trace:', log.stack] : []),
    '',
    'Sanitized context:',
    JSON.stringify(log.context, null, 2),
  ].join('\n');

export const ErrorLogsPanel: React.FC = () => {
  const { t } = useI18n();
  const { diagnostics } = useRuntimeAPIs();
  const [kindFilter, setKindFilter] = React.useState<KindFilter>('all');
  const [dispositionFilter, setDispositionFilter] = React.useState<DispositionFilter>('actionable');
  const [impactFilter, setImpactFilter] = React.useState<ImpactFilter>('all');
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [dateFilter, setDateFilter] = React.useState<DateFilter>('all');
  const [actorFilter, setActorFilter] = React.useState<string>('all');
  const [actors, setActors] = React.useState<ErrorLogActorOption[]>([]);
  const [pageSize, setPageSize] = React.useState<number>(PAGE_SIZES[0]);
  const [logs, setLogs] = React.useState<ErrorLogSummary[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<ErrorLogDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [clearing, setClearing] = React.useState<ErrorLogClearRange | null>(null);

  const queryFilters = React.useMemo(
    () => ({
      kind: kindFilter,
      disposition: dispositionFilter,
      impact: impactFilter,
      search,
      from: dateFilterBound(dateFilter),
      actor: actorFilter,
      limit: pageSize,
    }),
    [actorFilter, dateFilter, dispositionFilter, impactFilter, kindFilter, pageSize, search],
  );

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  React.useEffect(() => {
    const controller = new AbortController();
    void listErrorLogActors(controller.signal)
      .then((options) => setActors(options))
      .catch(() => setActors([]));
    return () => controller.abort();
  }, []);

  const reload = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listErrorLogs({ ...queryFilters, signal });
        setLogs(page.items);
        setNextCursor(page.nextCursor);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [queryFilters],
  );

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
    void getErrorLog(selectedEventId, controller.signal)
      .then((log) => setDetail(log))
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedEventId]);

  const loadMore = React.useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listErrorLogs({ ...queryFilters, cursor: nextCursor });
      setLogs((current) => {
        const seen = new Set(current.map((log) => log.eventId));
        const additions = page.items.filter((log) => !seen.has(log.eventId));
        return additions.length > 0 ? [...current, ...additions] : current;
      });
      setNextCursor(page.nextCursor);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, queryFilters]);

  const copyAgentContext = React.useCallback(async () => {
    if (!detail) return;
    const result = await copyTextToClipboard(formatAgentContext(detail), {
      sourceSurface: 'settings',
      copyKind: 'text',
    });
    if (result.ok) toast.success(t('settings.bugReports.errors.contextCopied'));
    else toast.error(result.error);
  }, [detail, t]);

  const exportDiagnostics = React.useCallback(async () => {
    if (!detail?.sessionId || !diagnostics || exporting) return;
    setExporting(true);
    try {
      const result = await diagnostics.export({
        scope: 'task',
        sessionID: detail.sessionId,
      });
      if (!result.cancelled) {
        toast.success(
          t('settings.bugReports.errors.exportedDiagnostics', {
            fileName: result.fileName,
          }),
        );
      }
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  }, [detail?.sessionId, diagnostics, exporting, t]);

  const clearLogs = React.useCallback(
    async (range: ErrorLogClearRange, labelKey: (typeof CLEAR_RANGES)[number]['labelKey']) => {
      if (clearing) return;
      const confirmation =
        range === 'all'
          ? t('settings.bugReports.errors.clear.confirmAll')
          : t('settings.bugReports.errors.clear.confirmRecent', { range: t(labelKey).toLocaleLowerCase() });
      if (!window.confirm(confirmation)) return;

      setClearing(range);
      setError(null);
      try {
        const clearedCount = await clearErrorLogs(range);
        toast.success(t('settings.bugReports.errors.clear.success', { count: clearedCount }));
        setSelectedEventId(null);
        setDetail(null);
        await reload();
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        setError(message);
        toast.error(message);
      } finally {
        setClearing(null);
      }
    },
    [clearing, reload, t],
  );

  const activeFilterCount = [
    dispositionFilter !== 'actionable',
    kindFilter !== 'all',
    impactFilter !== 'all',
    dateFilter !== 'all',
    actorFilter !== 'all',
    pageSize !== PAGE_SIZES[0],
  ].filter(Boolean).length;

  const resetFilters = React.useCallback(() => {
    setDispositionFilter('actionable');
    setKindFilter('all');
    setImpactFilter('all');
    setDateFilter('all');
    setActorFilter('all');
    setPageSize(PAGE_SIZES[0]);
  }, []);

  const dispositionFilterLabel = dispositionFilter === 'all'
    ? t('settings.bugReports.errors.disposition.all')
    : t(diagnosticDispositionLabelKey(dispositionFilter));

  const kindFilterLabel = kindFilter === 'all'
    ? t('settings.bugReports.errors.filter.all')
    : t(errorLogKindLabelKey(kindFilter));
  const impactFilterLabel = impactFilter === 'all'
    ? t('settings.bugReports.errors.impactFilter.all')
    : t(diagnosticImpactLabelKey(impactFilter));
  const dateFilterLabel = t(
    DATE_RANGES.find((range) => range.value === dateFilter)?.labelKey
      ?? 'settings.bugReports.errors.dateFilter.all',
  );
  const actorFilterLabel = actorFilter === 'all'
    ? t('settings.bugReports.errors.userFilter.all')
    : actors.find((actor) => actor.id === actorFilter)?.displayName
      ?? t('settings.bugReports.errors.userFilter.all');

  if (selectedEventId) {
    return (
      <section aria-labelledby="error-log-detail-heading" className="space-y-5">
        <Button variant="outline" size="sm" onClick={() => setSelectedEventId(null)}>
          <RiArrowLeftLine className="h-4 w-4" />
          {t('settings.bugReports.errors.back')}
        </Button>

        {detailLoading ? (
          <div
            className="flex min-h-40 items-center justify-center gap-2 typography-meta text-muted-foreground"
            aria-busy="true"
          >
            <RiLoader4Line className="h-4 w-4 animate-spin" />
            {t('settings.bugReports.errors.loading')}
          </div>
        ) : detail ? (
          <div className="space-y-6">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[var(--surface-subtle)] px-2 py-1 typography-micro font-medium text-muted-foreground">
                  {t(errorLogKindLabelKey(detail.kind))}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-1 typography-micro font-semibold',
                    impactBadgeClassName(detail.impact),
                  )}
                >
                  {t(diagnosticImpactLabelKey(detail.impact))}
                </span>
                <span className="rounded-full border border-border/60 px-2 py-1 typography-micro font-medium text-muted-foreground">
                  {t(diagnosticDispositionLabelKey(detail.disposition))}
                </span>
                {detail.classificationSource === 'inferred' ? (
                  <span className="rounded-full border border-border/60 px-2 py-1 typography-micro font-medium text-muted-foreground">
                    {t('settings.bugReports.errors.inferred')}
                  </span>
                ) : null}
                <span className="rounded-full border border-border/60 px-2 py-1 typography-micro font-medium text-muted-foreground">
                  {t(diagnosticOutcomeLabelKey(detail.outcome))}
                </span>
                <span className="typography-micro text-muted-foreground">{formatDateTime(detail.createdAt)}</span>
              </div>
              <h2 id="error-log-detail-heading" className="typography-ui-header font-semibold text-foreground">
                {detail.summary}
              </h2>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyAgentContext()}>
                <RiFileCopyLine className="h-4 w-4" />
                {t('settings.bugReports.errors.copyContext')}
              </Button>
              {detail.sessionId && diagnostics ? (
                <Button variant="outline" size="sm" onClick={() => void exportDiagnostics()} disabled={exporting}>
                  <RiDownloadLine className="h-4 w-4" />
                  {t('settings.bugReports.errors.exportDiagnostics')}
                </Button>
              ) : null}
            </div>

            <dl className="grid gap-4 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4 sm:grid-cols-2">
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.eventId')}
                </dt>
                <dd className="break-all font-mono text-xs text-foreground">{detail.eventId}</dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.action')}
                </dt>
                <dd className="font-mono text-xs text-foreground">{detail.action}</dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.occurred')}
                </dt>
                <dd className="typography-meta text-foreground">{formatDateTime(detail.createdAt)}</dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.actor')}
                </dt>
                <dd className="typography-meta text-foreground">
                  {detail.actor ? detail.actor.displayName : '—'}
                  {detail.actor ? (
                    <span className="block break-all text-muted-foreground">
                      {detail.actor.email} · {detail.actor.role}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.project')}
                </dt>
                <dd className="typography-meta text-foreground">{detail.project?.label || '—'}</dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.session')}
                </dt>
                <dd className="break-all font-mono text-xs text-foreground">{detail.sessionId || '—'}</dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.classification')}
                </dt>
                <dd className="typography-meta capitalize text-foreground">{detail.classificationSource}</dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.failureClass')}
                </dt>
                <dd className="typography-meta text-foreground">{formatFailureClass(detail.failureClass)}</dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.errors.outcome')}
                </dt>
                <dd className="typography-meta text-foreground">{t(diagnosticOutcomeLabelKey(detail.outcome))}</dd>
              </div>
            </dl>

            {detail.failureText ? (
              <div className="space-y-2">
                <h3 className="typography-ui-label font-medium text-foreground">
                  {t('settings.bugReports.errors.failureText')}
                </h3>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 p-4 font-mono text-xs leading-5 text-foreground">
                  {detail.failureText}
                </pre>
              </div>
            ) : null}

            {detail.stack ? (
              <details className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35">
                <summary className="cursor-pointer px-4 py-3 typography-ui-label font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]">
                  {t('settings.bugReports.errors.stack')}
                </summary>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 p-4 font-mono text-xs leading-5 text-foreground">
                  {detail.stack}
                </pre>
              </details>
            ) : null}

            <div className="space-y-2">
              <h3 className="typography-ui-label font-medium text-foreground">
                {t('settings.bugReports.errors.context')}
              </h3>
              <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 p-4 font-mono text-xs leading-5 text-foreground">
                {JSON.stringify(detail.context, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)]"
          >
            {error}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-labelledby="error-log-list-heading" className="space-y-5">
      <div className="space-y-1">
        <h2 id="error-log-list-heading" className="typography-ui-header font-semibold text-foreground">
          {t('settings.bugReports.errors.title')}
        </h2>
        <p className="typography-meta text-muted-foreground">{t('settings.bugReports.errors.description')}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <RiSearchLine
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            maxLength={200}
            placeholder={t('settings.bugReports.errors.search.placeholder')}
            aria-label={t('settings.bugReports.errors.search.placeholder')}
            className="h-9 w-full rounded-lg border border-border/60 bg-[var(--surface-elevated)] pl-9 pr-3 typography-ui-label text-foreground outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-[var(--interactive-focus-ring)]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                aria-label={activeFilterCount > 0
                  ? t('settings.bugReports.errors.filter.active', { count: activeFilterCount })
                  : t('settings.bugReports.errors.filter.action')}
              >
                <RiFilter3Line className="h-4 w-4" />
                {t('settings.bugReports.errors.filter.action')}
                {activeFilterCount > 0 ? (
                  <span
                    className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 typography-micro font-semibold text-primary-foreground"
                    aria-hidden="true"
                  >
                    {activeFilterCount}
                  </span>
                ) : null}
                <RiArrowDownSLine className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-64">
              <DropdownMenuLabel>{t('settings.bugReports.errors.filter.menuLabel')}</DropdownMenuLabel>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span>{t('settings.bugReports.errors.disposition.label')}</span>
                  <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{dispositionFilterLabel}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-44">
                  <DropdownMenuRadioGroup
                    value={dispositionFilter}
                    onValueChange={(value) => setDispositionFilter(value as DispositionFilter)}
                  >
                    <DropdownMenuRadioItem value="actionable">{t('settings.bugReports.errors.disposition.actionable')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="expected">{t('settings.bugReports.errors.disposition.expected')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="all">{t('settings.bugReports.errors.disposition.all')}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span>{t('settings.bugReports.errors.filter.label')}</span>
                  <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{kindFilterLabel}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-48">
                  <DropdownMenuRadioGroup value={kindFilter} onValueChange={(value) => setKindFilter(value as KindFilter)}>
                    <DropdownMenuRadioItem value="all">{t('settings.bugReports.errors.filter.all')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="session">{t('settings.bugReports.errors.kind.session')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="tool">{t('settings.bugReports.errors.kind.tool')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="managed_task">{t('settings.bugReports.errors.kind.managedTask')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="client">{t('settings.bugReports.errors.kind.client')}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span>{t('settings.bugReports.errors.impactFilter.label')}</span>
                  <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{impactFilterLabel}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-44">
                  <DropdownMenuRadioGroup value={impactFilter} onValueChange={(value) => setImpactFilter(value as ImpactFilter)}>
                    <DropdownMenuRadioItem value="all">{t('settings.bugReports.errors.impactFilter.all')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="low">{t('settings.bugReports.errors.impact.low')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="medium">{t('settings.bugReports.errors.impact.medium')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="high">{t('settings.bugReports.errors.impact.high')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="critical">{t('settings.bugReports.errors.impact.critical')}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span>{t('settings.bugReports.errors.dateFilter.label')}</span>
                  <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{dateFilterLabel}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-44">
                  <DropdownMenuRadioGroup value={dateFilter} onValueChange={(value) => setDateFilter(value as DateFilter)}>
                    {DATE_RANGES.map((range) => (
                      <DropdownMenuRadioItem key={range.value} value={range.value}>{t(range.labelKey)}</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {actors.length > 0 ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <span>{t('settings.bugReports.errors.userFilter.label')}</span>
                    <span className="ml-auto max-w-28 truncate typography-meta text-muted-foreground">{actorFilterLabel}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-80 min-w-52 overflow-y-auto">
                    <DropdownMenuRadioGroup value={actorFilter} onValueChange={setActorFilter}>
                      <DropdownMenuRadioItem value="all">{t('settings.bugReports.errors.userFilter.all')}</DropdownMenuRadioItem>
                      {actors.map((actor) => (
                        <DropdownMenuRadioItem key={actor.id} value={actor.id}>{actor.displayName}</DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span>{t('settings.bugReports.errors.pageSize.label')}</span>
                  <span className="ml-auto typography-meta text-muted-foreground">{pageSize}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-36">
                  <DropdownMenuRadioGroup value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
                    {PAGE_SIZES.map((size) => (
                      <DropdownMenuRadioItem key={size} value={String(size)}>{size}</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={activeFilterCount === 0} onSelect={resetFilters}>
                {t('settings.bugReports.errors.filter.reset')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={clearing !== null}>
                {clearing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiDeleteBinLine className="h-4 w-4" />}
                {t('settings.bugReports.errors.clear.action')}
                <RiArrowDownSLine className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuLabel>{t('settings.bugReports.errors.clear.menuLabel')}</DropdownMenuLabel>
              {CLEAR_RANGES.map((range) => (
                <DropdownMenuItem
                  key={range.value}
                  variant="destructive"
                  onClick={() => void clearLogs(range.value, range.labelKey)}
                >
                  {t(range.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {loading ? (
        <div
          className="flex min-h-40 items-center justify-center gap-2 typography-meta text-muted-foreground"
          aria-busy="true"
        >
          <RiLoader4Line className="h-4 w-4 animate-spin" />
          {t('settings.bugReports.errors.loading')}
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center typography-meta text-muted-foreground">
          {search ? t('settings.bugReports.errors.search.noResults') : t('settings.bugReports.errors.empty')}
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
                <span
                  className={cn(
                    'absolute inset-y-2 left-0 w-1 rounded-r-full',
                    impactAccentClassName(log.impact),
                  )}
                  aria-hidden="true"
                />
                <span className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <span className="min-w-0">
                    <span className="block truncate typography-ui-label font-medium text-foreground">
                      {log.summary}
                    </span>
                    <span className="mt-1 block truncate typography-micro text-muted-foreground">
                      {log.actor?.displayName || '—'} · {log.project?.label || '—'} · {formatDateTime(log.createdAt)}
                    </span>
                  </span>
                  <span className="flex w-fit shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <span className="rounded-full bg-[var(--surface-subtle)] px-2 py-1 typography-micro font-medium text-muted-foreground">
                      {t(errorLogKindLabelKey(log.kind))}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-1 typography-micro font-semibold',
                        impactBadgeClassName(log.impact),
                      )}
                    >
                      {t(diagnosticImpactLabelKey(log.impact))}
                    </span>
                    <span className="rounded-full border border-border/60 px-2 py-1 typography-micro font-medium text-muted-foreground">
                      {t(diagnosticDispositionLabelKey(log.disposition))}
                    </span>
                    {log.occurrenceCount && log.occurrenceCount > 1 ? (
                      <span className="rounded-full border border-border/60 px-2 py-1 typography-micro font-medium text-muted-foreground">
                        {t('settings.bugReports.errors.occurrences', { count: log.occurrenceCount })}
                      </span>
                    ) : null}
                    {log.classificationSource === 'inferred' ? (
                      <span className="rounded-full border border-border/60 px-2 py-1 typography-micro font-medium text-muted-foreground">
                        {t('settings.bugReports.errors.inferred')}
                      </span>
                    ) : null}
                    {log.outcome === 'unknown' ? (
                      <span className="rounded-full border border-border/60 px-2 py-1 typography-micro font-medium text-muted-foreground">
                        {t('settings.bugReports.errors.outcome.unknown')}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)] sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t('settings.bugReports.common.retry')}
          </Button>
        </div>
      ) : null}

      {nextCursor && !loading ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? t('settings.bugReports.errors.loadingMore') : t('settings.bugReports.errors.loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
