import React, { act } from 'react';
import { describe, expect, spyOn, test } from 'bun:test';
import { BotMessageList } from '@/components/bots/chat/BotMessageList';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import { botsApi, type BotChannel, type BotEventEnvelope, type BotMessage, type BotSnapshot, type BotSummary } from '@/lib/botsApi';
import { I18nProvider } from '@/lib/i18n';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotComputerActivityStore } from '@/stores/useBotComputerActivityStore';
import { useBotLiveMessageStore } from '@/stores/useBotLiveMessageStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotSharedFilesStore } from '@/stores/useBotSharedFilesStore';
import { useBotsStore } from '@/stores/useBotsStore';
import { BotsEventOwner, createBotEventReconciler } from './BotsEventOwner';

// Prism discovers the real environment on module load, before the host fixture.
await import('@/components/chat/MarkdownRendererImpl');

const NOW = '2026-08-31T00:00:00.000Z';
const runtimeApis = { runtime: {}, editor: {}, files: {} } as unknown as RuntimeAPIs;
const bot: BotSummary = { id: 'event-bot', name: 'Event Bot', title: '', summary: '', avatarUrl: null, avatarFallback: 'EB', lifecycle: 'active', tenancy: 'team', activeRevisionId: 'revision', createdAt: NOW, updatedAt: NOW, retiredAt: null };
const channel: BotChannel = { id: 'event-channel', botId: bot.id, ownerUserId: 'member', accessRole: 'owner', canSend: true, lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: 0, lastMessageAt: null, createdAt: NOW, updatedAt: NOW, archivedAt: null };
const snapshot: BotSnapshot = { bots: [bot], revisions: [], memberships: [{ botId: bot.id, userId: 'member', role: 'member', activatedAt: NOW, revokedAt: null, updatedAt: NOW }], channels: [channel], channelPreviews: [], runs: [], recentActions: [], pendingApprovals: [], computers: [] };
const message = (id: string, sequence: number, overrides: Partial<BotMessage> = {}): BotMessage => ({ id, sequence, channelId: channel.id, runId: 'event-run', actorUserId: 'member', role: 'user', assistantPhase: null, body: { text: 'Visible user request', attachmentIds: [] }, attachmentCount: 0, createdAt: NOW, finalizedAt: NOW, ...overrides });
const envelope = (sequence: number, kind: string, payload: BotEventEnvelope['payload'], epoch = 'event-epoch'): BotEventEnvelope => ({ id: `${epoch}:${sequence}`, sequence, kind, botId: bot.id, channelId: channel.id, payload });
const resetStores = (principalId: string | null) => {
  useBotsStore.getState().resetPrincipal(principalId);
  useBotChannelStore.getState().resetPrincipal(principalId);
  useBotOperationsStore.getState().resetPrincipal(principalId);
  useBotSharedFilesStore.getState().resetPrincipal(principalId);
  useBotComputerActivityStore.getState().reset();
  useBotLiveMessageStore.getState().reset();
};
const Transcript = ({ owner = false, channelId = channel.id }: { owner?: boolean; channelId?: string }) => (
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <I18nProvider>{owner ? <BotsEventOwner /> : null}<BotMessageList bot={bot} channelId={channelId} typingRunId="event-run" /></I18nProvider>
  </RuntimeAPIContext.Provider>
);

describe('normalized Bot events through the mounted transcript', () => {
  test('buffers streaming and acknowledgment events until verified finality, then ignores replay and partial regression', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    resetStores('member');
    const reconciler = createBotEventReconciler();
    try {
      expect(reconciler.ingest(envelope(0, 'snapshot', { ...snapshot }))).toEqual({ accepted: true, reason: 'snapshot' });
      await act(async () => { root.render(<Transcript />); });
      await act(async () => { reconciler.ingest(envelope(1, 'message.created', { message: message('user', 1) })); });
      expect(container.textContent).toContain('Visible user request');
      expect(container.find((node) => node.hasAttribute('data-bot-typing-indicator'))).not.toBeNull();
      await act(async () => {
        reconciler.ingest(envelope(2, 'message.updated', { message: message('ack', 2, { role: 'assistant', assistantPhase: 'acknowledgment', body: { text: 'Hidden acknowledgment prose', attachmentIds: [] } }) }));
        reconciler.ingest(envelope(3, 'message.streaming', { messageId: 'answer', runId: 'event-run', channelId: channel.id, sequence: 3, createdAt: NOW, text: 'Hidden unverified stream', revision: 1 }));
        reconciler.ingest(envelope(4, 'message.updated', { message: message('answer', 3, { role: 'assistant', assistantPhase: 'result', finalizedAt: null, body: { text: 'Hidden partial checkpoint', attachmentIds: [] } }), streamRevision: 1 }));
      });
      expect(container.textContent).not.toContain('Hidden');
      expect(container.find((node) => node.getAttribute('data-bot-message-id') === 'answer')).toBeNull();
      expect(container.find((node) => node.hasAttribute('data-bot-typing-indicator'))).not.toBeNull();
      const final = envelope(5, 'message.updated', { message: message('answer', 3, { role: 'assistant', assistantPhase: 'result', body: { text: 'Verified answer. مرحباً', attachmentIds: [] } }), streamRevision: 2 });
      await act(async () => { reconciler.ingest(final); });
      const finalNode = container.find((node) => node.getAttribute('data-bot-message-id') === 'answer');
      expect(finalNode).not.toBeNull();
      expect(container.textContent).toContain('Verified answer. مرحباً');
      expect(container.find((node) => node.hasAttribute('data-bot-typing-indicator'))).toBeNull();
      await act(async () => {
        expect(reconciler.ingest(final)).toEqual({ accepted: false, reason: 'stale' });
        reconciler.ingest(envelope(6, 'message.updated', { message: message('answer', 3, { role: 'assistant', assistantPhase: 'result', finalizedAt: null, body: { text: 'Hidden delayed partial', attachmentIds: [] } }) }));
      });
      expect(container.find((node) => node.getAttribute('data-bot-message-id') === 'answer')).toBe(finalNode);
      expect(container.textContent).toContain('Verified answer. مرحباً');
      expect(container.textContent).not.toContain('Hidden');
      expect(useBotChannelStore.getState().messageIdsByChannelId[channel.id]).toEqual(['user', 'ack', 'answer']);
    } finally { await act(async () => { root.unmount(); }); resetStores(null); }
  }), 30_000);

  test('filters computer activity against channel ACL snapshots and removes mounted private content on revocation', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    resetStores('member');
    const reconciler = createBotEventReconciler();
    const activity = { botId: bot.id, channelId: channel.id, runId: 'event-run', revision: 1, state: 'active' };
    try {
      reconciler.ingest(envelope(0, 'snapshot', { ...snapshot, computerActivity: [activity, { ...activity, channelId: 'unreadable-channel', revision: 50 }] }));
      expect(useBotComputerActivityStore.getState().byBotId[bot.id]).toEqual(activity);
      await act(async () => { root.render(<Transcript />); reconciler.ingest(envelope(1, 'message.created', { message: message('private', 1) })); });
      expect(container.textContent).toContain('Visible user request');
      await act(async () => {
        reconciler.ingest(envelope(2, 'computer.activity', { activity: { ...activity, channelId: 'unreadable-channel', revision: 51 } }));
        reconciler.ingest(envelope(3, 'computer.activity', { activity: { ...activity, botId: 'unrelated-bot', revision: 52 } }));
      });
      expect(useBotComputerActivityStore.getState().byBotId).toEqual({ [bot.id]: activity });
      await act(async () => { reconciler.ingest(envelope(4, 'computer.activity', { activity: { ...activity, revision: 2, state: 'waiting' } })); });
      expect(useBotComputerActivityStore.getState().byBotId[bot.id]?.state).toBe('waiting');
      await act(async () => { reconciler.ingest(envelope(5, 'channel.revoked', { channelId: channel.id })); });
      expect(container.textContent).not.toContain('Visible user request');
      expect(useBotComputerActivityStore.getState().byBotId).toEqual({});
      await act(async () => {
        reconciler.ingest(envelope(6, 'message.updated', { message: message('late-private', 2) }));
        reconciler.ingest(envelope(7, 'computer.activity', { activity: { ...activity, revision: 100 } }));
      });
      expect(container.textContent).not.toContain('Visible user request');
      expect(useBotComputerActivityStore.getState().byBotId).toEqual({});
      await act(async () => {
        reconciler.ingest(envelope(0, 'snapshot', { ...snapshot }));
        reconciler.ingest(envelope(8, 'message.created', { message: message('restored-private', 3) }));
      });
      expect(container.textContent).toContain('Visible user request');
      await act(async () => { reconciler.ingest(envelope(9, 'membership.revoked', { botId: bot.id })); });
      expect(container.textContent).not.toContain('Visible user request');
      expect(useBotChannelStore.getState().channelsById).toEqual({});
      expect(useBotsStore.getState().botsById).toEqual({});
    } finally { await act(async () => { root.unmount(); }); resetStores(null); }
  }), 30_000);

  test('the mounted event owner closes the prior account stream and ignores its delayed events after switching accounts', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const originalPrincipal = getAuthPrincipal();
    const originalSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
    const sources: FixtureSource[] = [];
    class FixtureSource {
      readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      constructor() { sources.push(this); }
      addEventListener(kind: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]); }
      close() { this.closed = true; }
      // Deliberately dispatch even after close to reproduce a queued browser callback.
      emit(event: BotEventEnvelope) { for (const listener of this.listeners.get(event.kind) ?? []) listener({ data: JSON.stringify(event) } as MessageEvent<string>); }
    }
    Object.defineProperty(globalThis, 'EventSource', { value: FixtureSource, configurable: true, writable: true });
    const capabilities = spyOn(botsApi, 'getCapabilities').mockResolvedValue({ available: true, state: 'ready', code: null, owner: 'test', canManageRuntime: false, canCreateBot: false, runtime: null });
    try {
      setAuthPrincipal({ ...originalPrincipal, id: 'member', scope: 'managed', policy: { ...originalPrincipal.policy, bots: true } });
      await act(async () => { root.render(<Transcript owner />); });
      expect(sources).toHaveLength(1);
      await act(async () => {
        sources[0]!.emit(envelope(0, 'snapshot', { ...snapshot }));
        sources[0]!.emit(envelope(1, 'message.created', { message: message('old-account', 1) }));
      });
      expect(container.textContent).toContain('Visible user request');
      await act(async () => { setAuthPrincipal({ ...getAuthPrincipal(), id: 'next-member' }); });
      expect(sources[0]!.closed).toBe(true);
      expect(sources).toHaveLength(2);
      expect(container.textContent).not.toContain('Visible user request');
      await act(async () => {
        sources[0]!.emit(envelope(0, 'snapshot', { ...snapshot }));
        sources[0]!.emit(envelope(2, 'message.updated', { message: message('late-old-account', 2) }));
        sources[1]!.emit(envelope(0, 'snapshot', { ...snapshot, bots: [], memberships: [], channels: [] }, 'next-account'));
      });
      expect(useBotChannelStore.getState().principalId).toBe('next-member');
      expect(useBotChannelStore.getState().messagesById).toEqual({});
      expect(container.textContent).not.toContain('Visible user request');
    } finally {
      await act(async () => { root.unmount(); }); capabilities.mockRestore(); setAuthPrincipal(originalPrincipal); resetStores(null);
      if (originalSource) Object.defineProperty(globalThis, 'EventSource', originalSource); else Reflect.deleteProperty(globalThis, 'EventSource');
    }
    expect(sources.every((source) => source.closed)).toBe(true);
  }), 30_000);
});
