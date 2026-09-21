import { expect, test, spyOn } from 'bun:test';
// Retention's module lifetime is a browser-tab lifetime; keep this fixture isolated.
Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true });
const { useSessionUIStore } = await import('./session-ui-store');
const { protectRetentionSelection } = await import('../lib/sessionRetention');

test('store navigation fences an in-flight click across draft round trips and protects a promotion', async () => {

  const sent: Array<{ sessionID: string | null; committed: boolean }> = [];
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let staged!: () => void;
  const arrived = new Promise<void>(resolve => { staged = resolve; });
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    if (body.sessionID === 'pending-click' && !body.committed) { staged(); await blocked; }
    return new Response('{}', { status: 200 });
  });
  try {
    useSessionUIStore.setState({ currentSessionId: null, currentDraftId: 'draft-a' });
    await protectRetentionSelection(null);
    useSessionUIStore.getState().setCurrentSession('pending-click');
    await arrived;
    useSessionUIStore.setState({ currentDraftId: 'draft-b' });
    useSessionUIStore.setState({ currentDraftId: 'draft-a' });
    unblock(); await protectRetentionSelection(null);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(sent.some(row => row.sessionID === 'pending-click' && row.committed)).toBe(false);
    useSessionUIStore.getState().promoteDraftToSession({ draftId: 'draft-a', sessionId: 'promoted' });
    await protectRetentionSelection('promoted');
    expect(useSessionUIStore.getState().currentSessionId).toBe('promoted');
    expect(sent.at(-1)).toMatchObject({ sessionID: 'promoted', committed: true });
  } finally { unblock(); fetchMock.mockRestore(); }
});
