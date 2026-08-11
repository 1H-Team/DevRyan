import React from 'react';
import {
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiFileCopyLine,
  RiLoader4Line,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { clearErrorLogs, getErrorLog, listErrorLogs } from './api';
import {
  diagnosticImpactLabelKey,
  diagnosticOutcomeLabelKey,
  errorLogKindLabelKey,
  selectClassName,
  type DiagnosticImpact,
  type ErrorLogClearRange,
  type ErrorLogDetail,
  type ErrorLogKind,
  type ErrorLogSummary,
} from './types';

type KindFilter = ErrorLogKind | 'all';
type ImpactFilter = DiagnosticImpact | 'all';

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
    `Classification source: ${log.classificationSource}`,
    `Failure class: ${log.failureClass}`,
    `Outcome: ${log.outcome}`,
    `Occurred: ${log.createdAt}`,
    `User: ${log.actor ? `${log.actor.displayName} (${log.actor.role}, ${log.actor.id})` : 'Unavailable'}`,
    `Project: ${log.project ? `${log.project.label} (${log.project.id})` : 'Unavailable'}`,
    `Session: ${log.sessionId || 'Unavailable'}`,
    '',
    'Sanitized context:',
    JSON.stringify(log.context, null, 2),
  ].join('\n');

export const ErrorLogsPanel: React.FC = () => {
  const { t } = useI18n();
  const { diagnostics } = useRuntimeAPIs();
  const [kindFilter, setKindFilter] = React.useState<KindFilter>('all');
  const [impactFilter, setImpactFilter] = React.useState<ImpactFilter>('all');
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

  const reload = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listErrorLogs({ kind: kindFilter, impact: impactFilter, signal });
        setLogs(page.items);
        setNextCursor(page.nextCursor);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [impactFilter, kindFilter],
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
      const page = await listErrorLogs({ kind: kindFilter, impact: impactFilter, cursor: nextCursor });
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
  }, [impactFilter, kindFilter, loadingMore, nextCursor]);

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 id="error-log-list-heading" className="typography-ui-header font-semibold text-foreground">
            {t('settings.bugReports.errors.title')}
          </h2>
          <p className="typography-meta text-muted-foreground">{t('settings.bugReports.errors.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 typography-meta text-muted-foreground">
            <span>{t('settings.bugReports.errors.filter.label')}</span>
            <select
              className={cn(selectClassName, 'min-w-36')}
              value={kindFilter}
              disabled={loadingMore}
              onChange={(event) => setKindFilter(event.target.value as KindFilter)}
            >
              <option value="all">{t('settings.bugReports.errors.filter.all')}</option>
              <option value="session">{t('settings.bugReports.errors.kind.session')}</option>
              <option value="tool">{t('settings.bugReports.errors.kind.tool')}</option>
              <option value="managed_task">{t('settings.bugReports.errors.kind.managedTask')}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 typography-meta text-muted-foreground">
            <span>{t('settings.bugReports.errors.impactFilter.label')}</span>
            <select
              className={cn(selectClassName, 'min-w-36')}
              value={impactFilter}
              disabled={loadingMore}
              onChange={(event) => setImpactFilter(event.target.value as ImpactFilter)}
            >
              <option value="all">{t('settings.bugReports.errors.impactFilter.all')}</option>
              <option value="low">{t('settings.bugReports.errors.impact.low')}</option>
              <option value="medium">{t('settings.bugReports.errors.impact.medium')}</option>
              <option value="high">{t('settings.bugReports.errors.impact.high')}</option>
              <option value="critical">{t('settings.bugReports.errors.impact.critical')}</option>
            </select>
          </label>
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
          {t('settings.bugReports.errors.empty')}
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
