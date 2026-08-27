import type { BotMessage, BotRun } from '@/lib/botsApi';

export const resolveBotTypingRunId = (run: BotRun | null): string | null => (
  run && (run.state === 'queued' || run.state === 'starting' || run.state === 'running')
    ? run.id
    : null
);

export const shouldShowBotTypingIndicator = ({
  typingRunId,
  messageIds,
  messagesById,
}: {
  typingRunId: string | null;
  messageIds: readonly string[];
  messagesById: Readonly<Record<string, BotMessage | undefined>>;
}): boolean => {
  if (!typingRunId) return false;
  return !messageIds.some((messageId) => {
    const message = messagesById[messageId];
    return message?.role === 'assistant'
      && message.runId === typingRunId
      && message.assistantPhase !== 'acknowledgment'
      && (message.body.text.trim().length > 0 || message.attachmentCount > 0);
  });
};
