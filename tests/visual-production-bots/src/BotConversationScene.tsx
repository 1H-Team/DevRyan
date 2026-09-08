import React from 'react';
import { BotComposer } from '@/components/bots/chat/BotComposer';
import { BotComputerStatusBar } from '@/components/bots/chat/BotComputerStatusBar';
import { BotInlineComputer } from '@/components/bots/chat/BotInlineComputer';
import { BotMessageList } from '@/components/bots/chat/BotMessageList';
import type { BotChannel, BotMessage, BotRun, BotSummary } from '@/lib/botsApi';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotComputerActivityStore } from '@/stores/useBotComputerActivityStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';

export function BotConversationScene({ bot, channel, run, state, installComputer }: {
  bot: BotSummary; channel: BotChannel; run: BotRun; state: string; installComputer: () => () => void;
}) {
  React.useLayoutEffect(() => {
    window.__DEVRYAN_VISUAL_SCREEN_STREAMS__ = { starts: 0, stops: 0, active: 0, maxActive: 0 };
    const uninstall = installComputer();
    const completed = state === 'computer_completed';
    useBotOperationsStore.getState().upsertRun({ ...run, state: completed ? 'completed' : state === 'computer_waiting' ? 'waiting_control' : 'running' });
    useBotChannelStore.getState().resetPrincipal(channel.ownerUserId);
    useBotChannelStore.getState().upsertChannel(channel);
    useBotComputerActivityStore.getState().reset();
    const message = (id: string, sequence: number, text: string, role: BotMessage['role'], assistantPhase: BotMessage['assistantPhase']): BotMessage => ({
      id, sequence, role, assistantPhase, channelId: channel.id, runId: run.id, actorUserId: null,
      body: { text, attachmentIds: [] }, attachmentCount: 0, createdAt: '2026-09-07T12:00:00Z', finalizedAt: '2026-09-07T12:00:00Z',
    });
    useBotChannelStore.getState().upsertMessage(message('conversation-request', 1, 'Create an image of a tiny robot exploring the moon.', 'user', null));
    useBotChannelStore.getState().upsertMessage(message('conversation-ack', 2, 'One tiny robot, one giant leap — I’ll give it a moon worth exploring.', 'assistant', 'acknowledgment'));
    if (completed) useBotChannelStore.getState().upsertMessage(message('conversation-result', 3, 'Your lunar explorer is ready.', 'assistant', 'result'));
    useBotChannelStore.getState().setDraft(channel.id, { text: 'Make the stars a little brighter', attachmentIds: [] });
    if (state !== 'computer_idle' && !completed) useBotComputerActivityStore.getState().upsert({ botId: bot.id, channelId: channel.id, runId: run.id, revision: 1, state: state === 'computer_waiting' ? 'waiting' : 'active' });
    if (['computer_shown', 'computer_expanded', 'computer_owned', 'computer_waiting', 'computer_disconnected'].includes(state)) useBotComputerActivityStore.getState().show(bot.id, channel.id);
    return () => { uninstall(); useBotComputerActivityStore.getState().reset(); };
  }, [bot.id, channel, installComputer, run, state]);
  return <div className="flex h-[min(650px,calc(100dvh-160px))] min-h-[380px] flex-col overflow-hidden rounded-xl border border-border bg-background" data-conversation-fixture data-visual-focus-scope>
    <BotMessageList bot={bot} channelId={channel.id} typingRunId={state === 'computer_completed' ? null : run.id}
      computerSlot={<BotInlineComputer botId={bot.id} channelId={channel.id} botActive />} />
    <BotComputerStatusBar bot={bot} channelId={channel.id} />
    <BotComposer botId={bot.id} channel={channel} runtimeState="healthy" runtimeAvailable />
  </div>;
}
