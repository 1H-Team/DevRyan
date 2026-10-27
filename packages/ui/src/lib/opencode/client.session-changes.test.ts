import { afterEach, expect, spyOn, test } from 'bun:test';
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:5180', href: 'http://127.0.0.1:5180/' } } });
const { opencodeClient, parseSessionTreeChanges } = await import('./client');
if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
else Reflect.deleteProperty(globalThis, 'window');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const summary = { rootSessionID: 'root', directory: '/fixture', revision: 'revision', attributionVersion: 2,
  coverage: 'complete', reasons: [], restoreAvailable: true, restoreReasons: [], totalsMode: 'net', restoreProof: { version: 1, digest: 'a'.repeat(64) },
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

test('reconciliation status supports pending and settled responses and older servers', () => {
  expect(parseSessionTreeChanges({ ...summary, attributionVersion: 3, reconciliationState: 'settled' }))
    .toMatchObject({ reconciliationState: 'settled', restoreAvailable: true });
  expect(parseSessionTreeChanges({ ...summary, reconciliationState: 'pending' }))
    .toMatchObject({ reconciliationState: 'pending', restoreAvailable: false });
  expect(parseSessionTreeChanges({ ...summary, coverage: 'partial', reasons: ['capture_pending'] }).reconciliationState).toBe('pending');
  expect(parseSessionTreeChanges(summary).reconciliationState).toBe('settled');
});

test('version 4 exact receipts preserve host restore authority and all safety gates', () => {
  const exact = { ...summary, attributionVersion: 4, reconciliationState: 'settled' };
  expect(parseSessionTreeChanges(exact)).toMatchObject({ attributionVersion: 4, restoreAvailable: true });
  for (const overrides of [
    { restoreAvailable: false }, { coverage: 'partial' }, { reconciliationState: 'pending' },
    { attributionVersion: 5 }, { attributionVersion: '4' }, { restoreProof: undefined }, { restoreProof: { version: 1, digest: 'bad' } },
  ]) {
    expect(parseSessionTreeChanges({ ...exact, ...overrides }).restoreAvailable).toBe(false);
  }
});

test('per-file verification preserves observed reasons and rejects unknown states', () => {
  const parse = (verification: unknown) => parseSessionTreeChanges({ ...summary,
    files: [{ ...summary.files[0], verification }] }).files[0].verification;
  expect(parse({ state: 'uncertain', reason: 'content_differs' }))
    .toEqual({ state: 'uncertain', reason: 'content_differs' });
  expect(parse({ state: 'restored', reason: 'matches_captured_before' }))
    .toEqual({ state: 'restored', reason: 'matches_captured_before' });
  expect(parse(undefined)).toBeUndefined();
  expect(parse({ state: 'safe', reason: 'matches_captured_after' })).toBeUndefined();
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


test('current observations and per-session capture gaps remain separate from captured revision totals', () => {
  const current = { state: 'restored', verifiedFileCount: 0, restoredFileCount: 1, uncertainFileCount: 0,
    foreignModifiedCount: 0, checkedFileCount: 1, observedAt: 1000, reasons: [] };
  const parsed = parseSessionTreeChanges({ ...summary, current, fileCount: 1,
    coverageBySession: [{ sessionID: 'child', reasons: ['execution_receipt_unavailable'] }] });
  expect(parsed.current).toEqual(current);
  expect(parsed.revision).toBe('revision'); expect(parsed.fileCount).toBe(1);
  expect(parsed.coverageBySession).toEqual([{ sessionID: 'child', reasons: ['execution_receipt_unavailable'] }]);
  expect(parseSessionTreeChanges({ ...summary, current: { ...current, checkedFileCount: -1 } }).current).toBeUndefined();
  const foreign = { ...current, state: 'uncertain', restoredFileCount: 0, uncertainFileCount: 1, foreignModifiedCount: 1 };
  expect(parseSessionTreeChanges({ ...summary, current: foreign }).current).toEqual(foreign);
  // Runtimes from before foreignModifiedCount report none.
  const { foreignModifiedCount: _omitted, ...older } = foreign;
  expect(parseSessionTreeChanges({ ...summary, current: older }).current?.foreignModifiedCount).toBe(0);
});

test('undo submits the exact reviewed proof with its revision', async () => {
  let body: unknown;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return Response.json({ undone: true });
  });
  try {
    const proof = { version: 1 as const, digest: 'b'.repeat(64) };
    await opencodeClient.sessionChangesAction('root', '/fixture', 'revision', 'undo', proof);
    expect(body).toEqual({ revision: 'revision', restoreProof: proof });
  } finally { fetch.mockRestore(); }
});
