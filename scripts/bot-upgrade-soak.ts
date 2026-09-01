/** Synthetic only: no providers, Telegram, browser/network connections, or app sessions. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBotChannelStore } from '../packages/ui/src/stores/useBotChannelStore';
import { createBotSharedFilesStore } from '../packages/ui/src/stores/useBotSharedFilesStore';
import { type BotChannel, type BotMessage, type BotSharedFile, type BotPrewarmState, type BotsApi } from '../packages/ui/src/lib/botsApi';
import { createBotPrewarmLeaseManager } from '../packages/ui/src/lib/botPrewarmLease';

const durationMs = Number(process.env.BOT_SOAK_DURATION_MS ?? 60 * 60_000);
assert(Number.isFinite(durationMs) && durationMs > 0 && durationMs <= 24 * 60 * 60_000);
const logPath = resolve(import.meta.dir, '../.tmp/bot-upgrade-soak.jsonl');
mkdirSync(resolve(import.meta.dir, '../.tmp'), { recursive: true });
const started = Date.now();
const counters = { cycles: 0, concurrentRequests: 0, assertions: 0, resets: 0, rejectedWarms: 0, releasedLeases: 0 };
const report = (status: string, extra = {}) => {
  const event = { status, pid: process.pid, timestamp: new Date().toISOString(), elapsedMs: Date.now() - started,
    requiredDurationMs: durationMs, synthetic: true, ...counters, heapUsed: process.memoryUsage().heapUsed,
    limitations: 'Injected in-process read/event/lease failures only; no live provider, Telegram, browser layout, network, or persistent-host execution.', ...extra };
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const now = '2026-08-31T00:00:00.000Z';
const channel = (id: string): BotChannel => ({ id, botId: 'bot', ownerUserId: 'member', accessRole: 'owner', canSend: true,
  lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: 0, lastMessageAt: null, createdAt: now, updatedAt: now, archivedAt: null });
const message = (channelId: string, id: string, text: string, finalizedAt: string | null): BotMessage => ({
  id, channelId, runId: 'run', actorUserId: null, role: 'assistant', assistantPhase: 'result', sequence: 1,
  body: { text, attachmentIds: [] }, attachmentCount: 0, createdAt: now, finalizedAt,
});
const file = (channelId: string, id: string, copyState: BotSharedFile['copyState']): BotSharedFile => ({
  id, channelId, botId: 'bot', messageId: `message-${channelId}`, objectId: `object-${id}`, senderUserId: 'member', direction: 'bot',
  filename: 'synthetic.txt', contentType: 'text/plain', sha256: null, size: 1, computerPath: '/workspace/Shared/synthetic.txt',
  copyState, errorCode: null, createdAt: now, updatedAt: copyState === 'ready' ? '2026-08-31T00:00:01.000Z' : now,
});
let pages = new Map<string, ReturnType<typeof deferred<{ messages: BotMessage[]; nextCursor: null }>>>();
const channelStore = createBotChannelStore({ api: { listMessages: (id: string) => pages.get(id)!.promise } as unknown as BotsApi, isChannelBusy: () => false });
const sharedStore = createBotSharedFilesStore();
const cacheStore = createBotChannelStore({ isChannelBusy: () => false });
const cacheChannels = Array.from({ length: 30 }, (_, index) => channel(`cache-${index}`));
cacheStore.getState().replaceSnapshot({ channels: cacheChannels });
cacheStore.getState().setActiveChannel(cacheChannels[0].id);
let warmResult = deferred<BotPrewarmState>();
const releases: string[] = [];
const { warmBotChannel, releaseBotChannelPrewarm, takeBotPrewarmLease } = createBotPrewarmLeaseManager({
  prewarmChannel: () => warmResult.promise,
  releasePrewarmChannel: async (_channelId, leaseId) => { releases.push(leaseId); counters.releasedLeases += 1; return { released: true }; },
});
const lease = (leaseId: string): BotPrewarmState => ({ state: 'ready', leaseId, revisionId: 'revision', expiresAt: new Date(Date.now() + 120_000).toISOString(), reason: null });
const check = (condition: unknown, reason: string) => { assert(condition, reason); counters.assertions += 1; };

report('started');
let lastReport = started;
try {
  while (Date.now() - started < durationMs) {
    const ids = Array.from({ length: 4 }, (_, index) => `channel-${index}`);
    channelStore.getState().resetPrincipal('member');
    channelStore.getState().replaceSnapshot({ channels: ids.map(channel) });
    sharedStore.getState().resetPrincipal('member');
    sharedStore.getState().replaceSnapshot(ids.map(channel));
    pages = new Map(ids.map((id) => [id, deferred<{ messages: BotMessage[]; nextCursor: null }>()]));
    const files = new Map(ids.map((id) => [id, deferred<{ sharedFiles: BotSharedFile[] }>()]));
    const loads = ids.flatMap((id) => [channelStore.getState().loadInitialMessages(id),
      sharedStore.getState().loadChannel('bot', id, { listSharedFiles: () => files.get(id)!.promise })]);
    counters.concurrentRequests += loads.length;
    const reset = counters.cycles % 7 === 0;
    for (const id of ids) {
      channelStore.getState().upsertMessage(message(id, `message-${id}`, 'Verified answer', now));
      sharedStore.getState().upsertFile(file(id, `old-${id}`, 'ready'));
      sharedStore.getState().upsertFile(file(id, `new-${id}`, 'ready'));
      channelStore.getState().setDraft(id, { text: `Draft ${counters.cycles}`, attachmentIds: [] });
    }
    if (reset) {
      counters.resets += 1;
      channelStore.getState().resetPrincipal('other'); channelStore.getState().resetPrincipal('member');
      sharedStore.getState().resetPrincipal('other'); sharedStore.getState().resetPrincipal('member');
      channelStore.getState().replaceSnapshot({ channels: ids.map(channel) });
      sharedStore.getState().replaceSnapshot(ids.map(channel));
    }
    // Settle the oldest snapshots after newer authoritative events, in reverse order.
    for (const id of ids.toReversed()) {
      pages.get(id)!.resolve({ messages: [message(id, `message-${id}`, 'Stale partial', null)], nextCursor: null });
      files.get(id)!.resolve({ sharedFiles: [file(id, `old-${id}`, 'pending')] });
    }
    await Promise.all(loads);
    if (reset) {
      check(Object.keys(channelStore.getState().messagesById).length === 0, 'late private transcript survived principal reset');
      check(Object.keys(sharedStore.getState().filesById).length === 0, 'late Shared listing survived principal reset');
      check(Object.keys(channelStore.draftStore.getState().draftsByChannelId).length === 0, 'draft survived principal reset');
    } else for (const id of ids) {
      check(channelStore.getState().messagesById[`message-${id}`]?.body.text === 'Verified answer', 'stale page overwrote final answer');
      check(sharedStore.getState().filesById[`old-${id}`]?.copyState === 'ready', 'stale Shared status overwrote event');
      check(sharedStore.getState().filesById[`new-${id}`] !== undefined, 'stale Shared listing deleted new file');
    }
    warmResult = deferred<BotPrewarmState>();
    const oldWarm = warmBotChannel('warm-channel').catch(() => null);
    const released = releaseBotChannelPrewarm('warm-channel');
    const staleResult = warmResult;
    warmResult = deferred<BotPrewarmState>();
    const newWarm = warmBotChannel('warm-channel');
    if (counters.cycles % 2 === 0) { staleResult.reject(new Error('injected old warm failure')); counters.rejectedWarms += 1; }
    else staleResult.resolve(lease(`old-${counters.cycles}`));
    warmResult.resolve(lease(`new-${counters.cycles}`));
    await Promise.all([oldWarm, released, newWarm]);
    check(takeBotPrewarmLease('warm-channel') === `new-${counters.cycles}`, 'old warm settled over replacement');
    check(takeBotPrewarmLease('warm-channel') === null, 'consumed lease reused');
    releases.length = 0;
    const cacheChannel = cacheChannels[counters.cycles % cacheChannels.length];
    const text = counters.cycles % 31 === 0 ? 'x'.repeat(11 * 1024 * 1024) : 'x'.repeat(1024);
    cacheStore.getState().mergeMessagePage(cacheChannel.id, { messages: [message(cacheChannel.id, `cache-message-${cacheChannel.id}`, text, now)], nextCursor: null });
    const cached = Object.keys(cacheStore.getState().messageIdsByChannelId).filter((id) => id !== cacheChannels[0].id);
    check(cached.length <= 20, 'inactive channel cache count exceeded');
    const cachedBytes = cached.reduce((total, id) => total + (cacheStore.getState().messageIdsByChannelId[id] ?? []).reduce((sum, messageId) => sum + 512 + 2 * cacheStore.getState().messagesById[messageId].body.text.length, 0), 0);
    check(cachedBytes <= 20 * 1024 * 1024, 'inactive transcript bytes exceeded');
    counters.cycles += 1;
    if (Date.now() - lastReport >= 30_000) { report('running'); lastReport = Date.now(); }
    await new Promise((done) => setTimeout(done, 100));
  }
  report('passed');
} catch (error) {
  report('failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
