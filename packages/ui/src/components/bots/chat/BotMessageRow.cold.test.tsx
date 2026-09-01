import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import type { BotChannel, BotMessage, BotSummary } from '@/lib/botsApi';
import { withDom } from './botMountedDom';

type LoadedRenderer = { default: React.FC<{ content: string }> };
let finishLoading: (value: LoadedRenderer) => void = () => {};
const pendingRenderer = new Promise<LoadedRenderer>((resolve) => { finishLoading = resolve; });
// Keep the real wrapper's Suspense unresolved until the assertions explicitly
// release it. The UI test runner isolates mock.module files in their own process.
mock.module('@/lib/chunkLoadRecovery', () => ({
  lazyWithChunkRecovery: () => React.lazy(() => pendingRenderer),
}));

const { I18nProvider } = await import('@/lib/i18n');
const { useBotChannelStore } = await import('@/stores/useBotChannelStore');
const { BotMessageRow } = await import('./BotMessageRow');
const { MarkdownRenderer } = await import('@/components/chat/MarkdownRenderer');
const channel: BotChannel = { id: 'cold-channel', botId: 'cold-bot', ownerUserId: 'member', accessRole: 'owner', canSend: true, lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: 0, lastMessageAt: null, createdAt: '', updatedAt: '', archivedAt: null };
const bot: BotSummary = { id: channel.botId, name: 'Cold Bot', title: '', summary: '', avatarUrl: null, avatarFallback: 'CB', lifecycle: 'active', tenancy: 'team', activeRevisionId: 'revision', createdAt: '', updatedAt: '', retiredAt: null };
const message = (id: string, sequence: number, changes: Partial<BotMessage> = {}): BotMessage => ({ id, sequence, channelId: channel.id, runId: 'run', actorUserId: 'member', role: 'assistant', assistantPhase: 'result', body: { text: '', attachmentIds: [] }, attachmentCount: 0, createdAt: '2026-08-31T00:00:00Z', finalizedAt: '2026-08-31T00:00:00Z', ...changes });

test('cold verified answers stay readable and escaped while Markdown loads; unverified output stays hidden', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  useBotChannelStore.getState().resetPrincipal('member');
  useBotChannelStore.getState().upsertChannel(channel);
  useBotChannelStore.getState().upsertMessage(message('ack', 1, { assistantPhase: 'acknowledgment', body: { text: 'HIDDEN ACK', attachmentIds: [] } }));
  useBotChannelStore.getState().upsertMessage(message('result', 2, { finalizedAt: null, body: { text: 'HIDDEN PARTIAL', attachmentIds: [] } }));
  const answer = 'Verified **answer**\nمرحبا 日本語 <think>literal protocol</think> <script>literal code</script>';
  try {
    await act(async () => root.render(<I18nProvider>
      <BotMessageRow bot={bot} messageId="ack" /><BotMessageRow bot={bot} messageId="result" />
      <aside><MarkdownRenderer content="Default wrapper loading remains unchanged" messageId="default-wrapper" /></aside>
    </I18nProvider>));
    expect(container.textContent).not.toContain('HIDDEN ACK');
    expect(container.textContent).not.toContain('HIDDEN PARTIAL');
    expect(container.textContent).not.toContain('Default wrapper loading remains unchanged');

    await act(async () => { useBotChannelStore.getState().upsertMessage(message('result', 2, { body: { text: answer, attachmentIds: [] } })); });
    const fallback = container.find((node) => node.hasAttribute('data-bot-final-text-fallback'));
    expect(fallback?.textContent).toBe(answer);
    expect(container.find((node) => node.tagName === 'SCRIPT')).toBeNull();
    expect(container.textContent).not.toContain('HIDDEN ACK');
    expect(container.textContent).not.toContain('HIDDEN PARTIAL');

    await act(async () => { finishLoading({ default: ({ content }) => <div data-loaded-markdown>{content}</div> }); });
    expect(container.find((node) => node.hasAttribute('data-bot-final-text-fallback'))).toBeNull();
    expect(container.find((node) => node.hasAttribute('data-loaded-markdown'))?.textContent).toBe(answer);
    expect(container.textContent).toContain('Default wrapper loading remains unchanged');
  } finally {
    await act(async () => root.unmount());
    useBotChannelStore.getState().resetPrincipal(null);
  }
}), 30_000);
