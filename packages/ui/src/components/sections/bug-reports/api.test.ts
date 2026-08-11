import { afterEach, describe, expect, mock, test } from 'bun:test';

import { clearErrorLogs, listBugReports, submitBugReport, updateBugReportStatus } from './api';
import { BugReportsRequestError } from './types';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Bug Reports browser API', () => {
  test('adds CSRF to mutations and sends only the submission contract', async () => {
    let capturedInput: RequestInfo | URL | null = null;
    let capturedInit: RequestInit | undefined;
    let callCount = 0;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      capturedInput = input;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          report: { id: 'report-1' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await submitBugReport({
      id: 'report-1',
      title: 'Title',
      description: 'Description',
    });

    expect(callCount).toBe(1);
    expect(capturedInput).toBe('/api/bug-reports');
    expect(capturedInit?.method).toBe('POST');
    expect(new Headers(capturedInit?.headers).get('X-DevRyan-CSRF')).toBe('1');
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      id: 'report-1',
      title: 'Title',
      description: 'Description',
    });
  });

  test('uses bounded list pagination without adding a mutation header', async () => {
    let capturedInput: RequestInfo | URL | null = null;
    let capturedInit: RequestInit | undefined;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedInput = input;
      capturedInit = init;
      return new Response(JSON.stringify({ reports: [], nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await listBugReports({ status: 'in_progress', cursor: 'opaque' });

    expect(String(capturedInput)).toContain('/api/bug-reports?');
    expect(String(capturedInput)).toContain('limit=50');
    expect(String(capturedInput)).toContain('status=in_progress');
    expect(String(capturedInput)).toContain('cursor=opaque');
    expect(new Headers(capturedInit?.headers).has('X-DevRyan-CSRF')).toBe(false);
  });

  test('surfaces structured stale-update errors to the review panel', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Bug report status changed in another session',
            code: 'stale_update',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const error = await updateBugReportStatus('report-1', 'resolved', '2026-08-09T18:00:00.000Z')
      .then(() => null)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(BugReportsRequestError);
    expect((error as BugReportsRequestError).status).toBe(409);
    expect((error as BugReportsRequestError).code).toBe('stale_update');
  });

  test('sends the selected error-log clear range with CSRF protection', async () => {
    let capturedInput: RequestInfo | URL | null = null;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedInput = input;
      capturedInit = init;
      return new Response(JSON.stringify({ clearedCount: 2, linkedResolutionCount: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    expect(await clearErrorLogs('7d')).toBe(2);

    expect(capturedInput).toBe('/api/error-logs?range=7d');
    expect(capturedInit?.method).toBe('DELETE');
    expect(new Headers(capturedInit?.headers).get('X-DevRyan-CSRF')).toBe('1');
  });
});
