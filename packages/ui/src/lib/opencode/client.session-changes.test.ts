import { afterEach, expect, spyOn, test } from 'bun:test';
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:5180', href: 'http://127.0.0.1:5180/' } } });
const { opencodeClient, parseSessionTreeChanges } = await import('./client');
if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
else Reflect.deleteProperty(globalThis, 'window');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const summary = { rootSessionID: 'root', directory: '/fixture', revision: 'revision', attributionVersion: 2,
  coverage: 'complete', reasons: [], restoreAvailable: true, restoreReasons: [], totalsMode: 'net',
  files: [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 1, sessions: ['root'], reviewMode: 'net', segmentCount: 0 }] };

test('review mode survives parsing and legacy/incomplete summaries cannot authorize restore', () => {
  expect(parseSessionTreeChanges(summary)).toMatchObject({ totalsMode: 'net', restoreAvailable: true });
  expect(parseSessionTreeChanges({ ...summary, attributionVersion: 1 }).restoreAvailable).toBe(false);
  expect(parseSessionTreeChanges({ ...summary, coverage: 'partial' }).restoreAvailable).toBe(false);
  expect(parseSessionTreeChanges({ ...summary, restoreAvailable: undefined }).restoreAvailable).toBe(false);
  const recorded = parseSessionTreeChanges({ ...summary, totalsMode: 'recorded', restoreAvailable: false,
    files: [{ ...summary.files[0], reviewMode: 'segments', segmentCount: 3 }] });
  expect(recorded.files[0]).toMatchObject({ reviewMode: 'segments', segmentCount: 3 });
  expect(recorded.totalsMode).toBe('recorded');
});

test('diff requests retain cursor and segment identity and reject mismatched server responses', async () => {
  const urls: URL[] = [];
  const body = { rootSessionID: 'root', revision: 'revision', path: 'a.txt', patch: '+own edit\n', pageIndex: 0,
    totalBytes: 10, nextCursor: null, previousCursor: null, reviewMode: 'segments', segmentIndex: 1, segmentCount: 2,
    segment: { sessionID: 'child', messageID: 'message', callID: 'call', source: 'cursor' } };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    urls.push(new URL(String(input))); return Response.json(body);
  });
  try {
    const page = await opencodeClient.getSessionChangesDiffPage('root', '/fixture', 'revision', 'a.txt', 'cursor', undefined, 1);
    expect(page.segment?.sessionID).toBe('child');
    expect(urls[0].searchParams.get('segment')).toBe('1');
    expect(urls[0].searchParams.get('cursor')).toBe('cursor');
    body.segmentIndex = 0;
    await expect(opencodeClient.getSessionChangesDiffPage('root', '/fixture', 'revision', 'a.txt', null, undefined, 1)).rejects.toThrow('Invalid session diff segment');
    body.segmentIndex = 1; body.segmentCount = 1;
    await expect(opencodeClient.getSessionChangesDiffPage('root', '/fixture', 'revision', 'a.txt', null, undefined, 1)).rejects.toThrow('Invalid session diff segment');
    body.segmentCount = 2; body.rootSessionID = 'unrelated';
    await expect(opencodeClient.getSessionChangesDiffPage('root', '/fixture', 'revision', 'a.txt', null, undefined, 1)).rejects.toThrow('Session diff identity mismatch');
  } finally { fetch.mockRestore(); }
});
