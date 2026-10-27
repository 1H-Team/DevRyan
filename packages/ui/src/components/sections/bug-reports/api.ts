import type {
  BugReportDetail,
  BugReportStatus,
  CursorPage,
  ErrorLogActorOption,
  ErrorLogClearRange,
  ErrorLogDetail,
  ErrorLogKind,
  DiagnosticDisposition,
  DiagnosticImpact,
  ErrorLogSummary,
  BugReportSummary,
} from './types';
import { BugReportsRequestError } from './types';

interface ErrorPayload {
  error?: string;
  code?: string;
  retryable?: boolean;
}

const requestJson = async <TResponse>(url: string, options: RequestInit = {}): Promise<TResponse> => {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-DevRyan-CSRF', '1');
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as TResponse & ErrorPayload;
  if (!response.ok) {
    throw new BugReportsRequestError(payload.error || `Request failed (${response.status})`, {
      status: response.status,
      code: payload.code,
      retryable: payload.retryable,
    });
  }
  return payload;
};

export const submitBugReport = async (input: {
  id: string;
  title: string;
  description: string;
}): Promise<BugReportDetail> => {
  const payload = await requestJson<{ report: BugReportDetail }>('/api/bug-reports', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return payload.report;
};

export const listBugReports = async ({
  status,
  cursor,
  signal,
}: {
  status: BugReportStatus | 'all';
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<CursorPage<BugReportSummary>> => {
  const query = new URLSearchParams({ limit: '50' });
  if (status !== 'all') query.set('status', status);
  if (cursor) query.set('cursor', cursor);
  const payload = await requestJson<{ reports: BugReportSummary[]; nextCursor: string | null }>(
    `/api/bug-reports?${query}`,
    { signal },
  );
  return { items: payload.reports, nextCursor: payload.nextCursor };
};

export const getBugReport = async (id: string, signal?: AbortSignal): Promise<BugReportDetail> => {
  const payload = await requestJson<{ report: BugReportDetail }>(`/api/bug-reports/${encodeURIComponent(id)}`, {
    signal,
  });
  return payload.report;
};

export const updateBugReportStatus = async (
  id: string,
  status: BugReportStatus,
  expectedUpdatedAt: string,
): Promise<BugReportDetail> => {
  const payload = await requestJson<{ report: BugReportDetail }>(`/api/bug-reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, expectedUpdatedAt }),
  });
  return payload.report;
};

export const listErrorLogs = async ({
  kind,
  disposition = 'actionable',
  impact,
  search,
  from,
  to,
  actor,
  limit = 50,
  cursor,
  signal,
}: {
  kind: ErrorLogKind | 'all';
  disposition?: DiagnosticDisposition | 'all';
  impact: DiagnosticImpact | 'all';
  search?: string;
  from?: string | null;
  to?: string | null;
  actor?: string | 'all';
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<CursorPage<ErrorLogSummary>> => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (kind !== 'all') query.set('kind', kind);
  query.set('disposition', disposition);
  if (impact !== 'all') query.set('impact', impact);
  if (search?.trim()) query.set('q', search.trim());
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (actor && actor !== 'all') query.set('actor', actor);
  if (cursor) query.set('cursor', cursor);
  const payload = await requestJson<{ logs: ErrorLogSummary[]; nextCursor: string | null }>(
    `/api/error-logs?${query}`,
    { signal },
  );
  return { items: payload.logs, nextCursor: payload.nextCursor };
};

export const getErrorLog = async (eventId: string, signal?: AbortSignal): Promise<ErrorLogDetail> => {
  const payload = await requestJson<{ log: ErrorLogDetail }>(`/api/error-logs/${encodeURIComponent(eventId)}`, {
    signal,
  });
  return payload.log;
};

export const listErrorLogActors = async (signal?: AbortSignal): Promise<ErrorLogActorOption[]> => {
  const payload = await requestJson<{ users: { id: string; display_name: string; email: string }[] }>(
    '/api/admin/users',
    { signal },
  );
  return (payload.users || [])
    .map((user) => ({ id: user.id, displayName: user.display_name || user.email }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
};

export const clearErrorLogs = async (range: ErrorLogClearRange): Promise<number> => {
  const query = new URLSearchParams({ range });
  const payload = await requestJson<{ clearedCount: number; linkedResolutionCount: number }>(`/api/error-logs?${query}`, {
    method: 'DELETE',
  });
  return payload.clearedCount;
};
