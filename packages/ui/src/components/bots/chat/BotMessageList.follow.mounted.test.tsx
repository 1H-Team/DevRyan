import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import type { BotChannel, BotMessage, BotSummary } from '@/lib/botsApi';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { BotMessageList } from './BotMessageList';

// Load the heavy renderer before installing the host fixture, as in normal SSR module discovery.
await import('@/components/chat/MarkdownRendererImpl');

import { withDom, type HostElement } from './botMountedDom';

const runtimeApis = { runtime: {}, editor: {}, files: {} } as unknown as RuntimeAPIs;
const channel = (id: string): BotChannel => ({ id, botId: 'follow-bot', ownerUserId: 'member', accessRole: 'owner', canSend: true, lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: 0, lastMessageAt: null, createdAt: '', updatedAt: '', archivedAt: null });
const bot: BotSummary = { id: 'follow-bot', name: 'Follow Bot', title: '', summary: '', avatarUrl: null, avatarFallback: 'FB', lifecycle: 'active', tenancy: 'team', activeRevisionId: 'revision', createdAt: '', updatedAt: '', retiredAt: null };
const message = (id: string, sequence: number, channelId = 'follow-channel'): BotMessage => ({ id, sequence, channelId, runId: 'run', actorUserId: 'member', role: 'user', assistantPhase: null, body: { text: `Request ${id}`, attachmentIds: [] }, attachmentCount: 0, createdAt: '2026-08-31T00:00:00Z', finalizedAt: '2026-08-31T00:00:00Z' });

type ObserverRecord = { callback: () => void; targets: unknown[]; disconnected: boolean };

const mountList = async (
  options: { resizeObserver: boolean },
  run: (ctx: {
    transcript: HostElement;
    content: HostElement;
    observers: ObserverRecord[];
    release: () => void;
    setChannel: (id: string) => Promise<void>;
  }) => Promise<void>,
) => withDom(async (container) => {
  const observers: ObserverRecord[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: options.resizeObserver ? class {
      record: ObserverRecord;
      constructor(callback: () => void) { this.record = { callback, targets: [], disconnected: false }; observers.push(this.record); }
      observe(target: unknown) { this.record.targets.push(target); }
      disconnect() { this.record.disconnected = true; }
    } : undefined,
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  useBotChannelStore.getState().resetPrincipal('member');
  useBotChannelStore.getState().upsertChannel(channel('follow-channel'));
  useBotChannelStore.getState().upsertChannel(channel('other-channel'));
  useBotChannelStore.getState().upsertMessage(message('first', 1));
  const render = (channelId: string) => (
    <RuntimeAPIContext.Provider value={runtimeApis}>
      <I18nProvider><BotMessageList bot={bot} channelId={channelId} typingRunId={null} /></I18nProvider>
    </RuntimeAPIContext.Provider>
  );
  try {
    await act(async () => { root.render(render('follow-channel')); });
    const transcript = container.find((node) => node.getAttribute('aria-label') === 'Bot Conversation Transcript') as HostElement;
    const content = transcript.childNodes[0] as HostElement;
    await run({
      transcript,
      content,
      observers,
      release: () => {
        // Scroll away from the bottom: the scroll event un-pins the transcript.
        transcript.scrollTop = 0;
        transcript.dispatch('scroll');
      },
      setChannel: async (id) => { await act(async () => { root.render(render(id)); }); },
    });
  } finally {
    await act(async () => { root.unmount(); });
    useBotChannelStore.getState().resetPrincipal(null);
    if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});

describe('mounted Bot transcript following', () => {
  test('follows intrinsic transcript growth while pinned through one content observer', async () => {
    await mountList({ resizeObserver: true }, async ({ transcript, content, observers }) => {
      expect(observers).toHaveLength(1);
      expect(observers[0].targets.map((target) => target === content)).toEqual([true]);

      transcript.scrollHeight = 2400;
      transcript.scrollTop = 0;
      await act(async () => { observers[0].callback(); });
      expect(transcript.scrollTop).toBe(2400);
    });
  }, 30_000);

  test('stops following once the reader scrolls away, and resumes at the bottom', async () => {
    await mountList({ resizeObserver: true }, async ({ transcript, observers, release }) => {
      release();
      transcript.scrollHeight = 3000;
      await act(async () => { observers[0].callback(); });
      expect(transcript.scrollTop).toBe(0);

      // Returning to the bottom pins the transcript again.
      transcript.scrollTop = 2400;
      transcript.dispatch('scroll');
      transcript.scrollHeight = 3200;
      await act(async () => { observers[0].callback(); });
      expect(transcript.scrollTop).toBe(3200);
    });
  }, 30_000);

  test('keeps a non-observer fallback: new messages scroll a pinned transcript to the bottom', async () => {
    await mountList({ resizeObserver: false }, async ({ transcript, observers }) => {
      expect(observers).toHaveLength(0);
      transcript.scrollHeight = 2000;
      transcript.scrollTop = 0;
      transcript.dispatch('scroll');
      // Dispatching a scroll at the top un-pins; re-pin by returning to the bottom first.
      transcript.scrollTop = 1400;
      transcript.dispatch('scroll');
      await act(async () => { useBotChannelStore.getState().upsertMessage(message('second', 2)); });
      expect(transcript.scrollTop).toBe(2000);
    });
  }, 30_000);

  test('does not use the fallback while an observer owns growth', async () => {
    await mountList({ resizeObserver: true }, async ({ transcript }) => {
      transcript.scrollHeight = 2000;
      transcript.scrollTop = 1400;
      transcript.dispatch('scroll');
      await act(async () => { useBotChannelStore.getState().upsertMessage(message('second', 2)); });
      expect(transcript.scrollTop).toBe(1400);
    });
  }, 30_000);

  test('resets following per channel, even after the reader scrolled away', async () => {
    await mountList({ resizeObserver: true }, async ({ transcript, release, setChannel }) => {
      release();
      transcript.scrollHeight = 2600;
      await setChannel('other-channel');
      expect(transcript.scrollTop).toBe(2600);
    });
  }, 30_000);

  test('disables browser scroll anchoring so the viewport is managed explicitly', async () => {
    await mountList({ resizeObserver: true }, async ({ transcript }) => {
      expect((transcript.style as unknown as Record<string, string>).overflowAnchor).toBe('none');
    });
  }, 30_000);

  test('releases the content observer on unmount', async () => {
    let record: ObserverRecord | undefined;
    await mountList({ resizeObserver: true }, async ({ observers }) => { record = observers[0]; });
    expect(record?.disconnected).toBe(true);
  }, 30_000);
});
