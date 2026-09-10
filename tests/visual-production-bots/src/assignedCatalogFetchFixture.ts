// Imported before the default Bots API captures fetch. Everything in this scene
// is synthetic; no bot request or EventSource reaches the installed application.
import type { BotAssignedCatalog, BotChannel, BotMessage, BotRun, BotSnapshot, BotSummary } from '@/lib/botsApi';

const now = '2026-09-09T12:00:00.000Z';
const principalId = 'a0000000-0000-4000-8000-000000000001';
export const assignedBot: BotSummary = {
  id: 'assigned-bot', name: 'Assigned Assistant', title: 'Your project assistant', summary: '',
  avatarUrl: null, avatarFallback: 'AA', lifecycle: 'active', tenancy: 'team',
  activeRevisionId: 'assigned-revision', createdAt: now, updatedAt: now, retiredAt: null,
};
const channel: BotChannel = {
  id: 'assigned-channel', botId: assignedBot.id, ownerUserId: principalId, accessRole: 'owner', canSend: true,
  lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: 1, lastMessageAt: now,
  createdAt: now, updatedAt: now, archivedAt: null,
};
const history: BotMessage = {
  id: 'assigned-history', channelId: channel.id, runId: null, actorUserId: null, role: 'assistant',
  assistantPhase: 'result', sequence: 1, body: { text: 'Your existing conversation is available.', attachmentIds: [] },
  attachmentCount: 0, createdAt: now, finalizedAt: now,
};
const params = new URLSearchParams(location.search);
const mode = params.get('state');
const empty = mode === 'assigned_empty';
const catalog: BotAssignedCatalog = {
  bots: empty ? [] : [assignedBot],
  memberships: empty ? [] : [{ botId: assignedBot.id, userId: principalId, role: 'member', activatedAt: now, revokedAt: null, updatedAt: now }],
  revisions: [],
};
let restored = mode === 'assigned_recovery';
let snapshotBlocked = false;
let sequence = 0;
let createdSources = 0;
let maximumSources = 0;
const messages: BotMessage[] = [history];
const sources = new Set<{
  onerror: (() => void) | null;
  emit(kind: string, payload: unknown, eventSequence?: number): void;
}>();
const pending: Array<() => void> = [];
export const restoreAssignedFixture = () => {
  restored = true;
  snapshotBlocked = false;
  for (const done of pending.splice(0)) done();
  for (const source of sources) source.emit('snapshot', snapshot, 0);
};
let snapshot: BotSnapshot = { ...catalog, channels: empty ? [] : [channel], channelPreviews: [], runs: [], recentActions: [], pendingApprovals: [], computers: [] };
export const interruptAssignedFixture = () => {
  restored = false;
  for (const source of sources) source.onerror?.();
};
export const openAssignedTransportFixture = () => { restored = true; snapshotBlocked = true; };
export const assignedConnectionStats = () => ({ createdSources, maximumSources, activeSources: sources.size });
export const publishAssignedFixtureMessage = () => {
  const id = messages.length;
  const run: BotRun = {
    id: `fixture-run-${id}`, botId: assignedBot.id, channelId: channel.id, revisionId: 'assigned-revision',
    computerScopeKey: `bot:${assignedBot.id}`, state: 'running', retryable: false,
    modelSnapshot: null, queueSequence: id, interruptionKind: null,
    createdAt: now, updatedAt: now, startedAt: now, finishedAt: null,
  };
  const message: BotMessage = {
    ...history, id: `fixture-response-${id}`, runId: run.id, sequence: id + 1,
    body: { text: `Verified fixture response ${id}.`, attachmentIds: [] },
  };
  messages.push(message);
  const completed: BotRun = { ...run, state: 'completed', finishedAt: now };
  snapshot = { ...snapshot, runs: [...snapshot.runs, completed] };
  for (const [kind, payload] of [
    ['run.started', { run }], ['message.created', { message }], ['run.completed', { run: completed }],
  ] as const) {
    const eventSequence = ++sequence;
    for (const source of sources) source.emit(kind, payload, eventSequence);
  }
};

if (params.get('scene') === 'assigned-catalog') {
  Object.assign(window, { __DEVRYAN_BOT_EVENT_FIXTURE__: Object.freeze({ stats: assignedConnectionStats }) });
  const outside = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(address, location.href).pathname;
    if (!/^\/api\/(?:bots|bot-channels)(?:\/|$)/.test(path)) return outside(input, init);
    if (path === '/api/bots/assigned') {
      if (mode === 'assigned_loading' && !restored) await new Promise<void>((resolve) => pending.push(resolve));
      if (mode === 'assigned_failure' && !restored) return Response.json({ error: 'Fixture catalog unavailable', code: 'bot_catalog_unavailable' }, { status: 503 });
      return Response.json(catalog);
    }
    if (path === '/api/bots') return Response.json({ bots: [assignedBot], canCreateBot: false });
    if (path === '/api/bots/capabilities') return Response.json({ available: true, state: 'healthy', owner: 'electron', code: null, canManageRuntime: false, canCreateBot: false });
    if (path === `/api/bots/${assignedBot.id}/channel`) return Response.json({ channel });
    if (path === `/api/bot-channels/${channel.id}/messages`) return Response.json({ channelId: channel.id, messages, nextCursor: null });
    if (path.endsWith('/shared-files')) return Response.json({ sharedFiles: [] });
    if (path.endsWith('/prewarm')) return Response.json({ state: 'unavailable', leaseId: null });
    throw new Error(`Unexpected assigned-catalog fixture request: ${path}`);
  };
  class FixtureSource {
    listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor() {
      createdSources += 1;
      sources.add(this);
      maximumSources = Math.max(maximumSources, sources.size);
      queueMicrotask(() => {
        if (this.closed) return;
        if (!restored) { this.onerror?.(); return; }
        this.onopen?.();
        if (!snapshotBlocked) this.emit('snapshot', snapshot, 0);
      });
    }
    emit(kind: string, payload: unknown, eventSequence = ++sequence) {
      if (this.closed) return;
      const event = { id: `assigned-fixture:${eventSequence}`, sequence: eventSequence, kind, payload };
      for (const listener of this.listeners.get(kind) ?? []) listener(new MessageEvent(kind, { data: JSON.stringify(event) }));
    }
    addEventListener(kind: string, listener: (message: MessageEvent<string>) => void) {
      this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
    }
    close() { this.closed = true; sources.delete(this); }
  }
  window.EventSource = FixtureSource as unknown as typeof EventSource;
}
