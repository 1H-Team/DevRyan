import React, { act } from 'react';
import { describe, expect, spyOn, test } from 'bun:test';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import {
  botsApi,
  type BotChannel,
  type BotMessage,
  type BotSendMessageResponse,
  type BotSummary,
} from '@/lib/botsApi';
import { useBotsStore } from '@/stores/useBotsStore';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotComputerActivityStore } from '@/stores/useBotComputerActivityStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { BotComputerStatusBar } from './BotComputerStatusBar';
import { BotMessageList, type BotMessageListHandle } from './BotMessageList';

// Load the heavy renderer before installing the host fixture, as in normal
// SSR module discovery; only its actual mounted rendering uses the fixture.
await import('@/components/chat/MarkdownRendererImpl');

import { withDom } from './botMountedDom';

const runtimeApis = { runtime: {}, editor: {}, files: {} } as unknown as RuntimeAPIs;
const channel: BotChannel = { id: 'mounted-channel', botId: 'mounted-bot', ownerUserId: 'member', accessRole: 'owner', canSend: true, lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: 0, lastMessageAt: null, createdAt: '', updatedAt: '', archivedAt: null };
const bot: BotSummary = { id: channel.botId, name: 'Test Bot', title: '', summary: '', avatarUrl: null, avatarFallback: 'TB', lifecycle: 'active', tenancy: 'team', activeRevisionId: 'revision', createdAt: '', updatedAt: '', retiredAt: null };
const message = (id: string, sequence: number, overrides: Partial<BotMessage> = {}): BotMessage => ({ id, sequence, channelId: channel.id, runId: 'run', actorUserId: 'member', role: 'user', assistantPhase: null, body: { text: 'User request', attachmentIds: [] }, attachmentCount: 0, createdAt: '2026-08-31T00:00:00Z', finalizedAt: '2026-08-31T00:00:00Z', ...overrides });
const questionMessage = (multiple: boolean): BotMessage => message('question', 2, {
  actorUserId: null,
  role: 'assistant',
  assistantPhase: 'result',
  body: {
    text: 'Which plan?',
    attachmentIds: [],
    question: {
      version: 1,
      prompt: 'Which plan?',
      options: [
        { label: 'Monthly', description: null },
        { label: 'Annual', description: 'Two months free' },
      ],
      multiple,
      allowFreeText: true,
    },
  },
});

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

  test('draft keystrokes do not repaint the transcript; acknowledgments stay visible and partial prose stays private', async () => withDom(async (container) => {
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
        useBotChannelStore.getState().upsertMessage(message('ack', 2, { role: 'assistant', assistantPhase: 'acknowledgment', body: { text: 'I’ll turn your sketch into a moonlit city.', attachmentIds: [] } }));
        useBotChannelStore.getState().upsertMessage(message('answer', 3, { role: 'assistant', assistantPhase: 'result', finalizedAt: null, body: { text: 'Unverified preamble', attachmentIds: [] } }));
      });
      expect(container.textContent).toContain('I’ll turn your sketch into a moonlit city.');
      expect(container.textContent).not.toContain('Unverified preamble');
      expect(container.find((node) => node.hasAttribute('data-bot-typing-indicator'))).not.toBeNull();
      await act(async () => {
        useBotChannelStore.getState().upsertMessage(message('answer', 3, { role: 'assistant', assistantPhase: 'result', body: { text: 'Verified final answer', attachmentIds: [] } }));
        await import('@/components/chat/MarkdownRendererImpl');
      });
      expect(container.find((node) => node.getAttribute('data-bot-message-id') === 'answer')).not.toBeNull();
      expect(container.textContent).toContain('Verified final answer');
      expect(container.textContent).toContain('I’ll turn your sketch into a moonlit city.');
      expect(container.textContent.indexOf('I’ll turn your sketch')).toBeLessThan(container.textContent.indexOf('Verified final answer'));
      expect(container.find((node) => node.hasAttribute('data-bot-typing-indicator'))).toBeNull();
    } finally { await act(async () => { root.unmount(); }); useBotChannelStore.getState().resetPrincipal(null); }
  }), 30_000);

  test('a single-choice quick reply forces the transcript to the optimistic conversation tail', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const pendingSend = new Promise<BotSendMessageResponse>(() => undefined);
    const send = spyOn(botsApi, 'sendMessage').mockImplementation(() => pendingSend);
    useBotChannelStore.getState().resetPrincipal('member');
    useBotOperationsStore.getState().resetPrincipal('member');
    useBotChannelStore.getState().upsertChannel(channel);
    useBotChannelStore.getState().upsertMessage(message('user', 1));
    useBotChannelStore.getState().upsertMessage(questionMessage(false));
    try {
      await act(async () => {
        root.render(<RuntimeAPIContext.Provider value={runtimeApis}><I18nProvider><BotMessageList bot={bot} channelId={channel.id} typingRunId={null} /></I18nProvider></RuntimeAPIContext.Provider>);
      });
      const transcript = container.find((node) => node.getAttribute('aria-label') === 'Bot Conversation Transcript');
      expect(transcript).not.toBeNull();
      if (!transcript) return;
      transcript.scrollTop = 100;
      transcript.dispatch('scroll');
      const annual = container.find((node) => node.getAttribute('role') === 'radio' && node.textContent.includes('Annual'));
      await act(async () => { annual?.click(); });
      expect(transcript.scrollTop).toBe(transcript.scrollHeight);
      expect(container.find((node) => (
        node.getAttribute('data-bot-message-role') === 'user' && node.textContent.includes('Annual')
      ))).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      send.mockRestore();
      useBotChannelStore.getState().resetPrincipal(null);
      useBotOperationsStore.getState().resetPrincipal(null);
    }
  }), 30_000);

  test('a multi-choice question waits for submission before forcing the transcript tail', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const pendingSend = new Promise<BotSendMessageResponse>(() => undefined);
    const send = spyOn(botsApi, 'sendMessage').mockImplementation(() => pendingSend);
    useBotChannelStore.getState().resetPrincipal('member');
    useBotOperationsStore.getState().resetPrincipal('member');
    useBotChannelStore.getState().upsertChannel(channel);
    useBotChannelStore.getState().upsertMessage(message('user', 1));
    useBotChannelStore.getState().upsertMessage(questionMessage(true));
    try {
      await act(async () => {
        root.render(<RuntimeAPIContext.Provider value={runtimeApis}><I18nProvider><BotMessageList bot={bot} channelId={channel.id} typingRunId={null} /></I18nProvider></RuntimeAPIContext.Provider>);
      });
      const transcript = container.find((node) => node.getAttribute('aria-label') === 'Bot Conversation Transcript');
      expect(transcript).not.toBeNull();
      if (!transcript) return;
      transcript.scrollTop = 100;
      transcript.dispatch('scroll');
      const annual = container.find((node) => node.getAttribute('role') === 'checkbox' && node.textContent.includes('Annual'));
      await act(async () => { annual?.click(); });
      expect(transcript.scrollTop).toBe(100);
      const submit = container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Send');
      await act(async () => { submit?.click(); });
      expect(transcript.scrollTop).toBe(transcript.scrollHeight);
      expect(container.find((node) => (
        node.getAttribute('data-bot-message-role') === 'user' && node.textContent.includes('Annual')
      ))).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      send.mockRestore();
      useBotChannelStore.getState().resetPrincipal(null);
      useBotOperationsStore.getState().resetPrincipal(null);
    }
  }), 30_000);

  test('computer status appearance follows only an already-pinned transcript and fires once per appearance', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const messageListRef = React.createRef<BotMessageListHandle>();
    let appearances = 0;
    const handleVisible = () => {
      appearances += 1;
      messageListRef.current?.scrollToLatest('if-following');
    };
    useBotComputerActivityStore.getState().reset();
    useBotsStore.getState().resetPrincipal('member');
    useBotOperationsStore.getState().resetPrincipal('member');
    useBotChannelStore.getState().resetPrincipal('member');
    useBotsStore.getState().upsertBot(bot);
    useBotsStore.getState().upsertMembership({ botId: bot.id, userId: 'member', role: 'operator', activatedAt: '', revokedAt: null, updatedAt: '' });
    useBotChannelStore.getState().upsertChannel(channel);
    useBotChannelStore.getState().upsertMessage(message('user', 1));
    const activity = { botId: bot.id, channelId: channel.id, runId: 'run', revision: 1, state: 'active' as const };
    try {
      await act(async () => {
        root.render(
          <RuntimeAPIContext.Provider value={runtimeApis}>
            <I18nProvider>
              <BotMessageList ref={messageListRef} bot={bot} channelId={channel.id} typingRunId={null} />
              <BotComputerStatusBar bot={bot} channelId={channel.id} onVisible={handleVisible} />
            </I18nProvider>
          </RuntimeAPIContext.Provider>,
        );
      });
      const transcript = container.find((node) => node.getAttribute('aria-label') === 'Bot Conversation Transcript');
      expect(transcript).not.toBeNull();
      if (!transcript) return;

      transcript.scrollTop = 100;
      transcript.dispatch('scroll');
      await act(async () => { useBotComputerActivityStore.getState().upsert(activity); });
      expect(appearances).toBe(1);
      expect(transcript.scrollTop).toBe(100);

      await act(async () => {
        useBotComputerActivityStore.getState().upsert({ ...activity, revision: 2, state: 'idle' });
      });
      transcript.scrollTop = 400;
      transcript.dispatch('scroll');
      transcript.clientHeight = 500;
      await act(async () => {
        useBotComputerActivityStore.getState().upsert({ ...activity, revision: 3 });
      });
      expect(appearances).toBe(2);
      expect(transcript.scrollTop).toBe(transcript.scrollHeight);

      transcript.scrollTop = 200;
      transcript.dispatch('scroll');
      await act(async () => {
        useBotComputerActivityStore.getState().upsert({ ...activity, revision: 4, state: 'waiting' });
      });
      expect(appearances).toBe(2);
      expect(transcript.scrollTop).toBe(200);
    } finally {
      await act(async () => { root.unmount(); });
      useBotComputerActivityStore.getState().reset();
      useBotsStore.getState().resetPrincipal(null);
      useBotOperationsStore.getState().resetPrincipal(null);
      useBotChannelStore.getState().resetPrincipal(null);
    }
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
