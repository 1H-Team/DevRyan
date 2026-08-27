import { create } from 'zustand';

import type { BotStreamingMessage } from '@/lib/botsApi';

const MAX_LIVE_TEXT_BYTES = 192 * 1024;

export type BotLiveMessageState = {
  messagesById: Readonly<Record<string, BotStreamingMessage>>;
  messageIdByChannelId: Readonly<Record<string, string>>;
  upsert(message: BotStreamingMessage): void;
  reconcileCanonical(messageId: string, streamRevision: number | null, finalized: boolean): void;
  clearMessage(messageId: string): void;
  clearRun(runId: string): void;
  clearChannel(channelId: string): void;
  reset(): void;
};

const omitKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => (
  Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))
);

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const markFirstStreamedText = (): void => {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.clearMarks?.('bot.first-streamed-text');
      performance.mark('bot.first-streamed-text');
    }
  } catch {
    // Instrumentation must never affect live delivery.
  }
};

export const createBotLiveMessageStore = () => create<BotLiveMessageState>((set, get) => {
  const clearMessage = (messageId: string) => set((state) => {
    const current = state.messagesById[messageId];
    if (!current) return state;
    return {
      messagesById: omitKey(state.messagesById, messageId),
      messageIdByChannelId: state.messageIdByChannelId[current.channelId] === messageId
        ? omitKey(state.messageIdByChannelId, current.channelId)
        : state.messageIdByChannelId,
    };
  });

  return {
    messagesById: {},
    messageIdByChannelId: {},
    upsert(message) {
      if (!Number.isSafeInteger(message.revision) || message.revision < 1
        || !Number.isSafeInteger(message.sequence) || message.sequence < 1
        || typeof message.text !== 'string' || utf8Bytes(message.text) > MAX_LIVE_TEXT_BYTES) return;
      set((state) => {
        const current = state.messagesById[message.messageId];
        if (current && current.revision >= message.revision) return state;
        const previousChannelMessageId = state.messageIdByChannelId[message.channelId];
        const messagesById = previousChannelMessageId && previousChannelMessageId !== message.messageId
          ? omitKey(state.messagesById, previousChannelMessageId)
          : { ...state.messagesById };
        messagesById[message.messageId] = Object.freeze({ ...message });
        if (!current) markFirstStreamedText();
        return {
          messagesById,
          messageIdByChannelId: previousChannelMessageId === message.messageId
            ? state.messageIdByChannelId
            : { ...state.messageIdByChannelId, [message.channelId]: message.messageId },
        };
      });
    },
    reconcileCanonical(messageId, streamRevision, finalized) {
      const current = get().messagesById[messageId];
      if (!current) return;
      if (finalized || (streamRevision !== null && streamRevision >= current.revision)) {
        clearMessage(messageId);
      }
    },
    clearMessage,
    clearRun(runId) {
      for (const message of Object.values(get().messagesById)) {
        if (message.runId === runId) clearMessage(message.messageId);
      }
    },
    clearChannel(channelId) {
      const messageId = get().messageIdByChannelId[channelId];
      if (messageId) clearMessage(messageId);
    },
    reset() {
      set((state) => (
        Object.keys(state.messagesById).length === 0
          ? state
          : { messagesById: {}, messageIdByChannelId: {} }
      ));
    },
  };
});

export const useBotLiveMessageStore = createBotLiveMessageStore();
