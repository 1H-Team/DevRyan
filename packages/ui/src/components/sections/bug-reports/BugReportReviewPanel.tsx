import React from 'react';
import { RiArrowLeftLine, RiLoader4Line } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { getBugReport, listBugReports, updateBugReportStatus } from './api';
import {
  BugReportsRequestError,
  bugReportStatusLabelKey,
  selectClassName,
  type BugReportDetail,
  type BugReportStatus,
  type BugReportSummary,
} from './types';

type StatusFilter = BugReportStatus | 'all';

const statusRailClassName = (status: BugReportStatus): string => {
  if (status === 'resolved') return 'bg-status-success';
  if (status === 'in_progress') return 'bg-status-warning';
  return 'bg-status-info';
};

const statusBadgeClassName = (status: BugReportStatus): string => {
  if (status === 'resolved') return 'bg-status-success/10 text-status-success';
  if (status === 'in_progress') return 'bg-status-warning/10 text-status-warning';
  return 'bg-status-info/10 text-status-info';
};

const roleLabel = (role: string): string =>
  role
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

export const BugReportReviewPanel: React.FC = () => {
  const { t } = useI18n();
  const [filter, setFilter] = React.useState<StatusFilter>('all');
  const [reports, setReports] = React.useState<BugReportSummary[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<BugReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [statusSaving, setStatusSaving] = React.useState(false);

  const reload = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listBugReports({ status: filter, signal });
        setReports(page.items);
        setNextCursor(page.nextCursor);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [filter],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    setSelectedId(null);
    setDetail(null);
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  React.useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    setError(null);
    void getBugReport(selectedId, controller.signal)
      .then((report) => setDetail(report))
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId]);

  const loadMore = React.useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listBugReports({ status: filter, cursor: nextCursor });
      setReports((current) => {
        const seen = new Set(current.map((report) => report.id));
        const additions = page.items.filter((report) => !seen.has(report.id));
        return additions.length > 0 ? [...current, ...additions] : current;
      });
      setNextCursor(page.nextCursor);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoadingMore(false);
    }
  }, [filter, loadingMore, nextCursor]);

  const changeStatus = React.useCallback(
    async (status: BugReportStatus) => {
      if (!detail || statusSaving || status === detail.status) return;
      setStatusSaving(true);
      setError(null);
      try {
        const updated = await updateBugReportStatus(detail.id, status, detail.updatedAt);
        setDetail(updated);
        setReports((current) => {
          if (filter !== 'all' && updated.status !== filter) {
            return current.filter((report) => report.id !== updated.id);
          }
          return current.map((report) =>
            report.id === updated.id
              ? {
                  ...report,
                  status: updated.status,
                  updatedAt: updated.updatedAt,
                }
              : report,
          );
        });
        toast.success(t('settings.bugReports.reports.statusUpdated'));
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        setError(message);
        if (requestError instanceof BugReportsRequestError && requestError.status === 409) {
          const refreshed = await getBugReport(detail.id).catch(() => null);
          if (refreshed) {
            setDetail(refreshed);
            setReports((current) =>
              current.map((report) =>
                report.id === refreshed.id
                  ? {
                      ...report,
                      status: refreshed.status,
                      updatedAt: refreshed.updatedAt,
                    }
                  : report,
              ),
            );
          }
        }
      } finally {
        setStatusSaving(false);
      }
    },
    [detail, filter, statusSaving, t],
  );

  if (selectedId) {
    return (
      <section aria-labelledby="bug-report-detail-heading" className="space-y-5">
        <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
          <RiArrowLeftLine className="h-4 w-4" />
          {t('settings.bugReports.reports.back')}
        </Button>

        {detailLoading ? (
          <div
            className="flex min-h-40 items-center justify-center gap-2 typography-meta text-muted-foreground"
            aria-busy="true"
          >
            <RiLoader4Line className="h-4 w-4 animate-spin" />
            {t('settings.bugReports.reports.loading')}
          </div>
        ) : detail ? (
          <div className="space-y-6">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'rounded-full px-2 py-1 typography-micro font-medium',
                    statusBadgeClassName(detail.status),
                  )}
                >
                  {t(bugReportStatusLabelKey(detail.status))}
                </span>
                <span className="typography-micro text-muted-foreground">{formatDateTime(detail.createdAt)}</span>
              </div>
              <h2 id="bug-report-detail-heading" className="typography-ui-header font-semibold text-foreground">
                {detail.title}
              </h2>
            </div>

            <dl className="grid gap-4 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4 sm:grid-cols-2">
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.reports.reporter')}
                </dt>
                <dd className="typography-meta text-foreground">
                  {detail.reporter.displayName} · {roleLabel(detail.reporter.role)}
                  <span className="block break-all text-muted-foreground">{detail.reporter.email}</span>
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.reports.statusLabel')}
                </dt>
                <dd>
                  <select
                    aria-label={t('settings.bugReports.reports.statusLabel')}
                    className={cn(selectClassName, 'w-full sm:w-48')}
                    value={detail.status}
                    disabled={statusSaving}
                    onChange={(event) => void changeStatus(event.target.value as BugReportStatus)}
                  >
                    <option value="submitted">{t('settings.bugReports.status.submitted')}</option>
                    <option value="in_progress">{t('settings.bugReports.status.inProgress')}</option>
                    <option value="resolved">{t('settings.bugReports.status.resolved')}</option>
                  </select>
                  {statusSaving ? (
                    <span className="mt-1 block typography-micro text-muted-foreground">
                      {t('settings.bugReports.reports.savingStatus')}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.reports.created')}
                </dt>
                <dd className="typography-meta text-foreground">{formatDateTime(detail.createdAt)}</dd>
              </div>
              <div className="space-y-1">
                <dt className="typography-micro uppercase tracking-wide text-muted-foreground">
                  {t('settings.bugReports.reports.updated')}
                </dt>
                <dd className="typography-meta text-foreground">{formatDateTime(detail.updatedAt)}</dd>
              </div>
            </dl>

            <div className="space-y-2">
              <h3 className="typography-ui-label font-medium text-foreground">
                {t('settings.bugReports.reports.descriptionLabel')}
              </h3>
              <div className="whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 p-4 typography-markdown text-foreground">
                {detail.description}
              </div>
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
    <section aria-labelledby="bug-report-list-heading" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 id="bug-report-list-heading" className="typography-ui-header font-semibold text-foreground">
            {t('settings.bugReports.reports.title')}
          </h2>
          <p className="typography-meta text-muted-foreground">{t('settings.bugReports.reports.description')}</p>
        </div>
        <label className="flex items-center gap-2 typography-meta text-muted-foreground">
          <span>{t('settings.bugReports.reports.filter.label')}</span>
          <select
            className={cn(selectClassName, 'min-w-40')}
            value={filter}
            disabled={loadingMore}
            onChange={(event) => setFilter(event.target.value as StatusFilter)}
          >
            <option value="all">{t('settings.bugReports.reports.filter.all')}</option>
            <option value="submitted">{t('settings.bugReports.status.submitted')}</option>
            <option value="in_progress">{t('settings.bugReports.status.inProgress')}</option>
            <option value="resolved">{t('settings.bugReports.status.resolved')}</option>
          </select>
        </label>
      </div>

      {loading ? (
        <div
          className="flex min-h-40 items-center justify-center gap-2 typography-meta text-muted-foreground"
          aria-busy="true"
        >
          <RiLoader4Line className="h-4 w-4 animate-spin" />
          {t('settings.bugReports.reports.loading')}
        </div>
      ) : reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center typography-meta text-muted-foreground">
          {t('settings.bugReports.reports.empty')}
        </div>
      ) : (
        <ul className="space-y-2">
          {reports.map((report) => (
            <li key={report.id}>
              <button
                type="button"
                onClick={() => setSelectedId(report.id)}
                className="group relative w-full overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)] py-3 pl-5 pr-4 text-left outline-none transition hover:border-border hover:bg-[var(--interactive-hover)] focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
              >
                <span
                  className={cn('absolute inset-y-2 left-0 w-1 rounded-r-full', statusRailClassName(report.status))}
                  aria-hidden="true"
                />
                <span className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <span className="min-w-0">
                    <span className="block truncate typography-ui-label font-medium text-foreground">
                      {report.title}
                    </span>
                    <span className="mt-1 block truncate typography-micro text-muted-foreground">
                      {report.reporter.displayName} · {formatDateTime(report.createdAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'w-fit shrink-0 rounded-full px-2 py-1 typography-micro font-medium',
                      statusBadgeClassName(report.status),
                    )}
                  >
                    {t(bugReportStatusLabelKey(report.status))}
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
            {loadingMore ? t('settings.bugReports.reports.loadingMore') : t('settings.bugReports.reports.loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
