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

test('failed and superseded switches preserve project, directory stores and client routing', async () => {
  const { useDirectoryStore } = await import('../stores/useDirectoryStore');
  const { useProjectsStore } = await import('../stores/useProjectsStore');
  const { opencodeClient } = await import('../lib/opencode/client');
  const { useSessionWorktreeStore } = await import('./session-worktree-store');
  const original = { directory: useDirectoryStore.getState(), projects: useProjectsStore.getState(), client: opencodeClient.getDirectory() };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let stageStarted!: () => void;
  let arrived = new Promise<void>(resolve => { stageStarted = resolve; });
  let failure = false;
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.sessionID === 'target' && !body.committed) {
      stageStarted(); await pending;
      if (failure) return new Response(JSON.stringify({ code: 'session_retention_in_progress' }), { status: 409 });
    }
    return new Response('{}');
  });
  try {
    useSessionUIStore.setState({ currentSessionId: 'old', currentDraftId: null });
    useDirectoryStore.setState({ currentDirectory: '/fixture/old' });
    opencodeClient.setDirectory('/fixture/old');
    useProjectsStore.setState({ activeProjectId: 'old-project' });
    const worktrees = useSessionWorktreeStore.getState();
    await protectRetentionSelection('old');
    const applied = () => useProjectsStore.setState({ activeProjectId: 'target-project' });
    useSessionUIStore.getState().setCurrentSession('target', '/fixture/target', { onApplied: applied });
    await arrived;
    useSessionUIStore.getState().setCurrentSession('old', '/fixture/old');
    await protectRetentionSelection('old');
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    const assertUnchanged = () => {
      expect(useSessionUIStore.getState().currentSessionId).toBe('old');
      expect(useDirectoryStore.getState().currentDirectory).toBe('/fixture/old');
      expect(opencodeClient.getDirectory()).toBe('/fixture/old');
      expect(useProjectsStore.getState().activeProjectId).toBe('old-project');
      expect(useSessionWorktreeStore.getState()).toBe(worktrees);
    };
    assertUnchanged();
    failure = true;
    arrived = new Promise<void>(resolve => { stageStarted = resolve; });
    useSessionUIStore.getState().setCurrentSession('target', '/fixture/target', { onApplied: applied });
    await arrived; await new Promise(resolve => setTimeout(resolve, 0));
    assertUnchanged(); expect(useSessionUIStore.getState().pendingSessionId).toBeNull();
  } finally {
    release(); fetchMock.mockRestore();
    useDirectoryStore.setState(original.directory); useProjectsStore.setState(original.projects);
    opencodeClient.setDirectory(original.client);
  }
});

test('cleanup dispatch requires confirmation and a current navigation revision', async () => {
  const { runProtectedSessionRetention } = await import('../lib/sessionRetention');
  let rejectStage!: (error: Error) => void;
  let releaseStage!: () => void;
  let arrived!: () => void;
  const stage = new Promise<void>((resolve, reject) => { releaseStage = resolve; rejectStage = reject; });
  const started = new Promise<void>(resolve => { arrived = resolve; });
  let runs = 0;
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/run')) {
      runs++; return new Response(JSON.stringify({ action: 'archive', completed: [], failed: [], skipped: [] }));
    }
    const body = JSON.parse(String(init?.body));
    if (body.sessionID === 'cleanup' && !body.committed) { arrived(); await stage; }
    return new Response('{}');
  });
  try {
    useSessionUIStore.setState({ currentSessionId: 'cleanup' });
    const cleanup = runProtectedSessionRetention().catch(error => error);
    await started;
    useSessionUIStore.getState().setCurrentSession(null);
    expect((await cleanup as Error).message).toBe('selection_superseded'); expect(runs).toBe(0);
    releaseStage(); await protectRetentionSelection(null);
    await runProtectedSessionRetention(); expect(runs).toBe(1);
  } finally { rejectStage(new Error('fixture closed')); fetchMock.mockRestore(); }
});

test('cleanup never starts on failed protection; timeout is retryable and keeps the per-request 15 seconds', async () => {
  const { runProtectedSessionRetention, RetentionRequestError } = await import('../lib/sessionRetention');
  let runs = 0, shouldTimeout = true;
  const requestedTimeouts: number[] = [];
  const timeoutMock = spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    requestedTimeouts.push(ms);
    const controller = new AbortController();
    if (shouldTimeout) queueMicrotask(() => controller.abort(new DOMException('fixture timeout', 'TimeoutError')));
    return controller.signal;
  });
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (shouldTimeout) return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    if (String(input).endsWith('/run')) {
      runs++; return new Response(JSON.stringify({ action: 'delete', completed: [], failed: [], skipped: [] }));
    }
    return new Response('{}');
  });
  try {
    useSessionUIStore.setState({ currentSessionId: 'timeout' });
    const error = await runProtectedSessionRetention().catch(error => error);
    expect(error instanceof RetentionRequestError).toBe(true);
    expect(error.code).toBe('retention_timeout'); expect(error.retryable).toBe(true);
    expect(runs).toBe(0); expect(requestedTimeouts.every(ms => ms === 15_000)).toBe(true);
    shouldTimeout = false;
    await runProtectedSessionRetention(); expect(runs).toBe(1);
  } finally { fetchMock.mockRestore(); timeoutMock.mockRestore(); }
});

test('server supersession is silent and authentication errors do not offer Retry', async () => {
  const { toast } = await import('../components/ui');
  const errors: Array<Parameters<typeof toast.error>> = [];
  const errorToast = spyOn(toast, 'error').mockImplementation((...args) => { errors.push(args); return 'fixture-toast'; });
  let status = 409;
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return body.sessionID === 'denied'
      ? new Response(JSON.stringify({ code: status === 409 ? 'selection_superseded' : 'authentication_required' }), { status })
      : new Response('{}');
  });
  try {
    useSessionUIStore.setState({ currentSessionId: 'old' });
    await protectRetentionSelection('old');
    useSessionUIStore.getState().setCurrentSession('denied');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(errors.length).toBe(0);
    expect(useSessionUIStore.getState().pendingSessionId).toBeNull();
    expect(useSessionUIStore.getState().currentSessionId).toBe('old');
    status = 401;
    useSessionUIStore.getState().setCurrentSession('denied');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(errors[0][0]).toBe('Sign in again to open this session.');
    expect(errors[0][1]?.action).toBeUndefined();
  } finally { fetchMock.mockRestore(); errorToast.mockRestore(); }
});

test('reconnect between acknowledgement reuse and cleanup dispatch requires fresh confirmation', async () => {
  const { runProtectedSessionRetention, retentionConnectionChanged } = await import('../lib/sessionRetention');
  let runs = 0;
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).endsWith('/run')) runs++;
    return new Response('{}');
  });
  try {
    useSessionUIStore.setState({ currentSessionId: 'reconnect-cleanup' });
    await protectRetentionSelection('reconnect-cleanup');
    const cleanup = runProtectedSessionRetention().catch(error => error);
    retentionConnectionChanged();
    expect((await cleanup as Error).message).toBe('selection_superseded');
    expect(runs).toBe(0);
    await protectRetentionSelection('reconnect-cleanup');
  } finally { fetchMock.mockRestore(); }
});

test('late worktree preparation updates its draft without changing a newer selection target', async () => {
  const { getRetentionNavigationRevision, beginRetentionNavigation } = await import('../lib/sessionRetention');
  const { useDirectoryStore } = await import('../stores/useDirectoryStore');
  const { opencodeClient } = await import('../lib/opencode/client');
  const previous = useSessionUIStore.getState();
  const directory = useDirectoryStore.getState().currentDirectory;
  const clientDirectory = opencodeClient.getDirectory();
  try {
    const draft = { id: 'owned-worktree-draft', text: '', createdAt: 1, updatedAt: 1, directoryOverride: '/fixture/root', pendingWorktreeRequestId: 'owned-request', parentID: null };
    useSessionUIStore.setState({
      currentDraftId: draft.id, draftsById: { [draft.id]: draft }, draftOrder: [draft.id],
      newSessionDraft: { open: true, id: draft.id, directoryOverride: '/fixture/root', pendingWorktreeRequestId: 'owned-request', parentID: null },
    });
    const expectedNavigationRevision = getRetentionNavigationRevision();
    beginRetentionNavigation();
    useSessionUIStore.getState().resolvePendingDraftWorktreeTarget('owned-request', '/fixture/worktree', { expectedNavigationRevision });
    expect(useSessionUIStore.getState().draftsById[draft.id].directoryOverride).toBe('/fixture/worktree');
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe('/fixture/root');
    expect(useDirectoryStore.getState().currentDirectory).toBe(directory);
    expect(opencodeClient.getDirectory()).toBe(clientDirectory);
  } finally { useSessionUIStore.setState(previous); }
});
