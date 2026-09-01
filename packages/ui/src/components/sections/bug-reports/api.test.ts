import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
  clearErrorLogs,
  clearBotAudit,
  listBotAudit,
  listBugReports,
  listErrorLogs,
  submitBugReport,
  updateBugReportStatus,
} from './api';
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

  test('serializes error-log filters and omits the ones left at their defaults', async () => {
    let capturedInput: RequestInfo | URL | null = null;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedInput = input;
      return new Response(JSON.stringify({ logs: [], nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await listErrorLogs({
      kind: 'tool',
      disposition: 'expected',
      impact: 'all',
      search: '  timed out  ',
      from: '2026-08-01T00:00:00.000Z',
      actor: 'user-1',
      limit: 200,
    });

    const query = new URLSearchParams(String(capturedInput).split('?')[1]);
    expect(query.get('kind')).toBe('tool');
    expect(query.get('disposition')).toBe('expected');
    expect(query.get('q')).toBe('timed out');
    expect(query.get('from')).toBe('2026-08-01T00:00:00.000Z');
    expect(query.get('actor')).toBe('user-1');
    expect(query.get('limit')).toBe('200');
    expect(query.has('impact')).toBe(false);
    expect(query.has('to')).toBe(false);

    await listErrorLogs({ kind: 'all', impact: 'all', search: '   ', actor: 'all' });
    const defaults = new URLSearchParams(String(capturedInput).split('?')[1]);
    expect([...defaults.keys()]).toEqual(['limit', 'disposition']);
    expect(defaults.get('limit')).toBe('50');
    expect(defaults.get('disposition')).toBe('actionable');
  });

  for (const [clear, endpoint] of [
    [clearErrorLogs, '/api/error-logs'],
    [clearBotAudit, '/api/bot-audit'],
  ] as const) {
    test(`sends the selected clear range with CSRF protection (${endpoint})`, async () => {
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

      expect(await clear('7d')).toBe(2);

      expect(capturedInput).toBe(`${endpoint}?range=7d`);
      expect(capturedInit?.method).toBe('DELETE');
      expect(new Headers(capturedInit?.headers).get('X-DevRyan-CSRF')).toBe('1');
    });
  }

  test('serializes Bot audit filters while keeping the issues-first defaults compact', async () => {
    let capturedInput: RequestInfo | URL | null = null;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedInput = input;
      return new Response(JSON.stringify({ logs: [], nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await listBotAudit({ result: 'issues', bot: 'all', actor: 'all' });
    let query = new URLSearchParams(String(capturedInput).split('?')[1]);
    expect([...query.keys()]).toEqual(['limit']);
    expect(query.get('limit')).toBe('50');

    await listBotAudit({
      result: 'denied',
      bot: 'bot-1',
      actor: 'user-1',
      search: '  approval expired  ',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
      limit: 200,
      cursor: 'opaque',
    });
    query = new URLSearchParams(String(capturedInput).split('?')[1]);
    expect(query.get('result')).toBe('denied');
    expect(query.get('bot')).toBe('bot-1');
    expect(query.get('actor')).toBe('user-1');
    expect(query.get('q')).toBe('approval expired');
    expect(query.get('from')).toBe('2026-08-01T00:00:00.000Z');
    expect(query.get('to')).toBe('2026-08-31T00:00:00.000Z');
    expect(query.get('limit')).toBe('200');
    expect(query.get('cursor')).toBe('opaque');
  });
});
