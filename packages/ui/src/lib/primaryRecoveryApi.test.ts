import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { hostOwnsPrimaryRecovery, usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';

let gate: () => Promise<() => void> = async () => () => {};
const actualOpencodeClientModule = await import('./opencode/client');
mock.module('./opencode/client', () => ({ ...actualOpencodeClientModule, opencodeClient: { getDirectory: () => '/fixture/project', awaitInputSubscription: () => gate() } }));
mock.module('@/sync/sync-refs', () => ({ getSyncSessionDirectoryAnyDirectory: () => null }));
const { actOnRecoveredInput, readRecoveredInput, requestPrimaryRecovery, admitQueuedRecoveryIntent } = await import('./primaryRecoveryApi');
const originalFetch = globalThis.fetch;
const input = { revision: 'a'.repeat(64), messageID: 'msg_pending', payloadHash: 'b'.repeat(64) };
const snapshot = () => ({ schemaVersion: 1, mode: 'off', supported: false, enforced: false, progressTimeoutMs: false, record: null,
  recoveredInput: { revision: input.revision, state: 'paused', inputs: [{ ...input, type: 'user', delivery: 'queue', location: 'queued',
    preview: 'Pending', attachmentCount: 0, canResume: true, canDiscard: true, reason: null }] } });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
beforeEach(() => { gate = async () => () => {}; usePrimaryRecoveryStore.setState({ snapshots: {} }); });
afterEach(() => { globalThis.fetch = originalFetch; });

test('retained actions send exact ID/hash/inventory revision and CSRF without a generated message ID', async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = mock(async (url, init) => { captured.push({ url: String(url), init }); return response(snapshot()); }) as typeof fetch;
  await actOnRecoveredInput('ses_test', 'resume', input);
  await actOnRecoveredInput('ses_test', 'discard', input);
  expect(captured.map(row => new URL(row.url, 'http://fixture').pathname)).toEqual([
    '/api/session/ses_test/recovery/resume-input', '/api/session/ses_test/recovery/discard-input',
  ]);
  for (const row of captured) {
    expect(row.init?.method).toBe('POST');
    expect(new Headers(row.init?.headers).get('X-DevRyan-CSRF')).toBe('1');
    expect(JSON.parse(String(row.init?.body))).toEqual(input);
  }
});

test('detail reads bind the displayed identity and never enter the snapshot store', async () => {
  let url = '';
  globalThis.fetch = mock(async requested => {
    url = String(requested);
    return response({ ...input, type: 'user', delivery: 'queue', location: 'queued', text: 'Full text', files: [] });
  }) as typeof fetch;
  expect((await readRecoveredInput('ses_test', input, new AbortController().signal)).text).toBe('Full text');
  const query = new URL(url, 'http://fixture').searchParams;
  for (const [key, value] of Object.entries(input)) expect(query.get(key)).toBe(value);
  expect(usePrimaryRecoveryStore.getState().snapshots).toEqual({});
  globalThis.fetch = mock(async () => response({ ...input, messageID: 'msg_wrong', type: 'user', delivery: 'queue', location: 'queued', text: '', files: [] })) as typeof fetch;
  await expect(readRecoveredInput('ses_test', input, new AbortController().signal)).rejects.toThrow('This input changed');
});

test('a stale status reply cannot erase a newer retained-input projection', async () => {
  let finish: (value: Response) => void = () => {};
  globalThis.fetch = mock(() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
  const old = requestPrimaryRecovery('ses_test');
  usePrimaryRecoveryStore.getState().accept('ses_test', snapshot());
  const current = usePrimaryRecoveryStore.getState().snapshots.ses_test;
  finish(response({ ...snapshot(), recoveredInput: undefined }));
  await old;
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test).toBe(current);
});

test('a retained action reply cannot restore input after a newer completion event', async () => {
  for (const action of ['resume', 'discard'] as const) {
    usePrimaryRecoveryStore.getState().accept('ses_test', snapshot());
    let finish: (value: Response) => void = () => {};
    let entered: () => void = () => {};
    const fetchEntered = new Promise<void>(resolve => { entered = resolve; });
    globalThis.fetch = mock(() => new Promise<Response>(resolve => { finish = resolve; entered(); })) as typeof fetch;
    const pending = actOnRecoveredInput('ses_test', action, input);
    await fetchEntered;
    // No primary record or numeric revision can order these inventory changes.
    usePrimaryRecoveryStore.getState().accept('ses_test', { ...snapshot(), recoveredInput: undefined });
    const completed = usePrimaryRecoveryStore.getState().snapshots.ses_test;
    finish(response({ ...snapshot(), recoveredInput: { ...snapshot().recoveredInput,
      state: action === 'resume' ? 'resuming' : 'discarding' } }));
    await pending;
    expect(usePrimaryRecoveryStore.getState().snapshots.ses_test).toBe(completed);
    expect(hostOwnsPrimaryRecovery('ses_test')).toBe(false);
  }
});

test('a partial controller event during an input action triggers one full read without repeating the action', async () => {
  usePrimaryRecoveryStore.getState().accept('ses_test', snapshot());
  const calls: string[] = []; let finish: (value: Response) => void = () => {};
  globalThis.fetch = mock((_url, init) => {
    calls.push(init?.method ?? 'GET');
    return init?.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve; })
      : Promise.resolve(response({ ...snapshot(), recoveredInput: undefined }));
  }) as typeof fetch;
  const action = actOnRecoveredInput('ses_test', 'discard', input);
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...snapshot(), recoveredInput: undefined, recoveredInputPartial: true });
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test.recoveredInput).toBeDefined();
  finish(response(snapshot()));
  await action;
  expect(calls).toEqual(['POST', 'GET']);
  expect(usePrimaryRecoveryStore.getState().snapshots.ses_test.recoveredInput).toBeUndefined();
});

test('new queued intent cannot supersede retained native input', async () => {
  globalThis.fetch = mock(async () => response(snapshot())) as typeof fetch;
  await expect(admitQueuedRecoveryIntent('ses_test')).rejects.toThrow('Review the retained input');
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test('ordinary Continue and Stop preserve their numeric revision contract', async () => {
  const current = { ...snapshot(), recoveredInput: undefined, record: { sessionID: 'ses_test', anchorID: 'msg_old',
    failedID: null, recoveryID: null, state: 'needs_attention', revision: 7, attemptCount: 0, maxAttempts: 1,
    readOnly: false, providerID: 'openai', modelID: 'fixture', agent: 'build', variant: null, reason: 'prompt_dispatch_uncertain', updatedAt: 1 } };
  usePrimaryRecoveryStore.getState().accept('ses_test', current);
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = mock(async (url, init) => {
    calls.push({ url: new URL(String(url), 'http://fixture').pathname, body: JSON.parse(String(init?.body)) });
    return response(current);
  }) as typeof fetch;
  await requestPrimaryRecovery('ses_test', 'continue', 'msg_new');
  await requestPrimaryRecovery('ses_test', 'cancel');
  usePrimaryRecoveryStore.getState().accept('ses_test', { ...snapshot(), record: { ...current.record, revision: 9 } });
  await requestPrimaryRecovery('ses_test', 'cancel');
  expect(calls).toEqual([{ url: '/api/session/ses_test/recovery/continue', body: { revision: 7, messageID: 'msg_new' } },
    { url: '/api/session/ses_test/recovery/cancel', body: { revision: 7 } },
    { url: '/api/session/ses_test/recovery/cancel', body: { revision: 9 } }]);
});

test('retained Resume and Continue require subscription while Stop, discard, intent and reads remain available', async () => {
  gate = async () => { throw new Error('subscription unavailable'); };
  globalThis.fetch = mock(async () => response(snapshot())) as typeof fetch;
  await expect(actOnRecoveredInput('ses_test', 'resume', input)).rejects.toThrow('subscription unavailable');
  await expect(requestPrimaryRecovery('ses_test', 'continue')).rejects.toThrow('subscription unavailable');
  expect(globalThis.fetch).toHaveBeenCalledTimes(0);
  await actOnRecoveredInput('ses_test', 'discard', input);
  await requestPrimaryRecovery('ses_test', 'cancel');
  await requestPrimaryRecovery('ses_test', 'intent');
  await requestPrimaryRecovery('ses_test');
  expect(globalThis.fetch).toHaveBeenCalledTimes(4);
});
