import React, { act } from 'react';
import { describe, expect, spyOn, test } from 'bun:test';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { botsApi, type BotChannel, type BotMessage, type BotSummary } from '@/lib/botsApi';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { BotMessageList } from './BotMessageList';

// Load the heavy renderer before installing the host fixture, as in normal
// SSR module discovery; only its actual mounted rendering uses the fixture.
await import('@/components/chat/MarkdownRendererImpl');

import { withDom } from './botMountedDom';

const runtimeApis = { runtime: { isVSCode: false }, editor: {}, files: {} } as unknown as RuntimeAPIs;
const channel: BotChannel = { id: 'mounted-channel', botId: 'mounted-bot', ownerUserId: 'member', accessRole: 'owner', canSend: true, lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: 0, lastMessageAt: null, createdAt: '', updatedAt: '', archivedAt: null };
const bot: BotSummary = { id: channel.botId, name: 'Test Bot', title: '', summary: '', avatarUrl: null, avatarFallback: 'TB', lifecycle: 'active', tenancy: 'team', activeRevisionId: 'revision', createdAt: '', updatedAt: '', retiredAt: null };
const message = (id: string, sequence: number, overrides: Partial<BotMessage> = {}): BotMessage => ({ id, sequence, channelId: channel.id, runId: 'run', actorUserId: 'member', role: 'user', assistantPhase: null, body: { text: 'User request', attachmentIds: [] }, attachmentCount: 0, createdAt: '2026-08-31T00:00:00Z', finalizedAt: '2026-08-31T00:00:00Z', ...overrides });

describe('mounted Bot transcript', () => {
  test('an inactive computer slot preserves initial loading and empty conversation feedback', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const InactiveComputer = () => null;
    useBotChannelStore.getState().resetPrincipal('member');
    useBotChannelStore.getState().upsertChannel(channel);
    useBotChannelStore.setState({ loadingByChannelId: { [channel.id]: true } });
    try {
      await act(async () => {
        root.render(<RuntimeAPIContext.Provider value={runtimeApis}><I18nProvider><BotMessageList bot={bot} channelId={channel.id} typingRunId={null} computerSlot={<InactiveComputer />} /></I18nProvider></RuntimeAPIContext.Provider>);
      });
      expect(container.textContent).toContain('Loading encrypted messages…');
      expect(container.textContent).not.toContain('Start the continuous conversation');
      await act(async () => { useBotChannelStore.setState({ loadingByChannelId: {} }); });
      expect(container.textContent).toContain('Start the continuous conversation');
      expect(container.textContent).not.toContain('Loading encrypted messages…');
      await act(async () => { useBotChannelStore.getState().upsertMessage(message('loaded', 1)); });
      expect(container.textContent).toContain('User request');
      expect(container.textContent).not.toContain('Start the continuous conversation');
    } finally { await act(async () => { root.unmount(); }); useBotChannelStore.getState().resetPrincipal(null); }
  }), 30_000);

  test('draft keystrokes do not commit transcript renders and partial/acknowledgment events never reach the DOM', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    useBotChannelStore.getState().resetPrincipal('member');
    useBotChannelStore.getState().upsertChannel(channel);
    useBotChannelStore.getState().upsertMessage(message('user', 1));
    let commits = 0;
    try {
      await act(async () => { root.render(<RuntimeAPIContext.Provider value={runtimeApis}><I18nProvider><React.Profiler id="transcript" onRender={() => { commits += 1; }}><BotMessageList bot={bot} channelId={channel.id} typingRunId="run" /></React.Profiler></I18nProvider></RuntimeAPIContext.Provider>); });
      expect(container.textContent).toContain('User request');
      expect(container.find((node) => node.hasAttribute('data-bot-typing-indicator'))).not.toBeNull();
      const before = commits;
      await act(async () => {
        for (let index = 0; index < 100; index += 1) useBotChannelStore.getState().setDraft(channel.id, { text: `Typing ${index}`, attachmentIds: [] });
      });
      expect(commits).toBe(before);
      await act(async () => {
        useBotChannelStore.getState().upsertMessage(message('ack', 2, { role: 'assistant', assistantPhase: 'acknowledgment', body: { text: 'Internal acknowledgment', attachmentIds: [] } }));
        useBotChannelStore.getState().upsertMessage(message('answer', 3, { role: 'assistant', assistantPhase: 'result', finalizedAt: null, body: { text: 'Unverified preamble', attachmentIds: [] } }));
      });
      expect(container.textContent).not.toContain('Internal acknowledgment');
      expect(container.textContent).not.toContain('Unverified preamble');
      expect(container.find((node) => node.hasAttribute('data-bot-typing-indicator'))).not.toBeNull();
      await act(async () => {
        useBotChannelStore.getState().upsertMessage(message('answer', 3, { role: 'assistant', assistantPhase: 'result', body: { text: 'Verified final answer', attachmentIds: [] } }));
        await import('@/components/chat/MarkdownRendererImpl');
      });
      expect(container.find((node) => node.getAttribute('data-bot-message-id') === 'answer')).not.toBeNull();
      expect(container.textContent).toContain('Verified final answer');
      expect(container.find((node) => node.hasAttribute('data-bot-typing-indicator'))).toBeNull();
    } finally { await act(async () => { root.unmount(); }); useBotChannelStore.getState().resetPrincipal(null); }
  }), 30_000);

  test('initial history failure offers a working Retry button that loads messages into the mounted DOM', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const load = spyOn(botsApi, 'listMessages').mockResolvedValue({ messages: [message('retried', 1)], nextCursor: null });
    useBotChannelStore.getState().resetPrincipal('member');
    useBotChannelStore.getState().upsertChannel(channel);
    useBotChannelStore.setState({ loadErrorCodeByChannelId: { [channel.id]: 'network_error' } });
    try {
      await act(async () => { root.render(<RuntimeAPIContext.Provider value={runtimeApis}><I18nProvider><BotMessageList bot={bot} channelId={channel.id} typingRunId={null} /></I18nProvider></RuntimeAPIContext.Provider>); });
      const retry = container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Retry');
      expect(retry).not.toBeNull();
      await act(async () => { retry?.click(); });
      expect(load).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('User request');
      expect(container.find((node) => node.getAttribute('role') === 'alert')).toBeNull();
    } finally { await act(async () => { root.unmount(); }); load.mockRestore(); useBotChannelStore.getState().resetPrincipal(null); }
  }), 30_000);
});
