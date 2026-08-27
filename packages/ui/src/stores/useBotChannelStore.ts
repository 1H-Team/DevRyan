import { create, type StoreApi, type UseBoundStore } from 'zustand';

import {
  botsApi,
  BotsApiError,
  type BotChannel,
  type BotChannelPreview,
  type BotMessage,
  type BotMessagePage,
  type BotSendMessageRequest,
  type BotSendMessageResponse,
  type BotsApi,
  type BotSnapshot,
} from '@/lib/botsApi';
import { takeBotPrewarmLease } from '@/lib/botPrewarmLease';
import { getAuthPrincipal } from '@/lib/authSession';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';

type ChannelsSnapshot = Pick<BotSnapshot, 'channels' | 'channelPreviews'>;
const EMPTY_IDS: readonly string[] = Object.freeze([]);
const EMPTY_PREVIEWS: readonly BotChannelPreview[] = Object.freeze([]);

export type BotComposerDraft = {
  text: string;
  attachmentIds: readonly string[];
};

export type BotChannelState = {
  principalId: string | null;
  activeChannelId: string | null;
  channelsById: Readonly<Record<string, BotChannel>>;
  previewsByChannelId: Readonly<Record<string, BotChannelPreview>>;
  messagesById: Readonly<Record<string, BotMessage>>;
  messageIdsByChannelId: Readonly<Record<string, readonly string[]>>;
  attachmentIdsByChannelId: Readonly<Record<string, readonly string[]>>;
  nextCursorByChannelId: Readonly<Record<string, string | null | undefined>>;
  loadingByChannelId: Readonly<Record<string, true>>;
  draftsByChannelId: Readonly<Record<string, BotComposerDraft>>;
  pendingMessageIdByChannelId: Readonly<Record<string, string>>;
  unconfirmedMessageIds: Readonly<Record<string, true>>;
  sendErrorCodeByChannelId: Readonly<Record<string, string>>;
  loadErrorCodeByChannelId: Readonly<Record<string, string>>;
  openingOwnerChannelByBotId: Readonly<Record<string, true>>;
  ownerChannelErrorCodeByBotId: Readonly<Record<string, string>>;
  resetPrincipal(principalId: string | null): void;
  setActiveChannel(channelId: string | null): void;
  replaceSnapshot(snapshot: ChannelsSnapshot): void;
  upsertChannel(channel: BotChannel): void;
  upsertPreview(preview: BotChannelPreview): void;
  removeChannel(channelId: string): void;
  upsertMessage(message: BotMessage): void;
  removeMessage(messageId: string): void;
  mergeMessagePage(channelId: string, page: BotMessagePage, reset?: boolean): void;
  loadInitialMessages(channelId: string): Promise<void>;
  loadOlderMessages(channelId: string): Promise<void>;
  refreshLatestMessages(channelId: string): Promise<void>;
  ensureOwnerChannel(botId: string): Promise<BotChannel>;
  setDraft(channelId: string, draft: BotComposerDraft): void;
  clearDraft(channelId: string): void;
  sendDraft(channelId: string): Promise<BotSendMessageResponse | null>;
  retryRun(runId: string): Promise<{ run: BotSendMessageResponse['run'] } | null>;
};

export type BotChannelStore = UseBoundStore<StoreApi<BotChannelState>>;

const channelEqual = (left: BotChannel, right: BotChannel): boolean => (
  left.id === right.id
  && left.botId === right.botId
  && left.ownerUserId === right.ownerUserId
  && left.accessRole === right.accessRole
  && left.canSend === right.canSend
  && left.lifecycle === right.lifecycle
  && left.currentCheckpointNumber === right.currentCheckpointNumber
  && left.lastMessageSequence === right.lastMessageSequence
  && left.lastMessageAt === right.lastMessageAt
  && left.createdAt === right.createdAt
  && left.updatedAt === right.updatedAt
  && left.archivedAt === right.archivedAt
);

const previewEqual = (left: BotChannelPreview, right: BotChannelPreview): boolean => (
  left.channelId === right.channelId
  && left.messageId === right.messageId
  && left.role === right.role
  && left.sequence === right.sequence
  && left.text === right.text
  && left.attachmentCount === right.attachmentCount
  && left.createdAt === right.createdAt
  && left.finalizedAt === right.finalizedAt
);

const sameStrings = (left: readonly string[], right: readonly string[]): boolean => (
  left === right
  || (left.length === right.length && left.every((value, index) => value === right[index]))
);

const messageEqual = (left: BotMessage, right: BotMessage): boolean => (
  left.id === right.id
  && left.channelId === right.channelId
  && left.runId === right.runId
  && left.actorUserId === right.actorUserId
  && left.role === right.role
  && left.assistantPhase === right.assistantPhase
  && left.sequence === right.sequence
  && left.body.text === right.body.text
  && sameStrings(left.body.attachmentIds, right.body.attachmentIds)
  && left.attachmentCount === right.attachmentCount
  && left.createdAt === right.createdAt
  && left.finalizedAt === right.finalizedAt
);

const draftEqual = (left: BotComposerDraft, right: BotComposerDraft): boolean => (
  left.text === right.text && sameStrings(left.attachmentIds, right.attachmentIds)
);

const preserveChannel = (current: BotChannel | undefined, next: BotChannel): BotChannel => (
  current && channelEqual(current, next) ? current : next
);

const preserveMessage = (current: BotMessage | undefined, next: BotMessage): BotMessage => (
  current && messageEqual(current, next) ? current : next
);

const sortedMessageIds = (
  channelId: string,
  messagesById: Readonly<Record<string, BotMessage>>,
): readonly string[] => Object.values(messagesById)
  .filter((message) => message.channelId === channelId)
  .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
  .map((message) => message.id);

const attachmentIdsForChannel = (
  channelId: string,
  messageIdsByChannelId: Readonly<Record<string, readonly string[]>>,
  messagesById: Readonly<Record<string, BotMessage>>,
): readonly string[] => {
  const ids = new Set<string>();
  for (const messageId of messageIdsByChannelId[channelId] || []) {
    for (const attachmentId of messagesById[messageId]?.body.attachmentIds || []) ids.add(attachmentId);
  }
  return [...ids];
};

const omitKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => (
  Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))
);

const clearConfirmedMessages = (
  record: Readonly<Record<string, true>>,
  messages: readonly BotMessage[],
): Readonly<Record<string, true>> => {
  let next = record;
  for (const message of messages) {
    if (!record[message.id] || (message.runId === null && message.finalizedAt === null)) continue;
    if (next === record) next = { ...record };
    delete (next as Record<string, true>)[message.id];
  }
  return next;
};

const defaultUuid = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('A secure client message ID generator is unavailable');
};

const stableErrorCode = (error: unknown): string => (
  error instanceof BotsApiError ? error.code : 'bot_request_failed'
);

const isAmbiguousAcceptanceError = (error: unknown): boolean => (
  error instanceof BotsApiError
  && (error.status === 0 || error.code === 'network_error' || error.code === 'bot_invalid_response')
);

const markBotPerformance = (name: string): void => {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.clearMarks?.(name);
      performance.mark(name);
    }
  } catch {
    // Instrumentation must never affect delivery.
  }
};

export const createBotChannelStore = ({
  api = botsApi,
  uuid = defaultUuid,
  now = () => new Date(),
  getPrincipalId = () => getAuthPrincipal().id,
  onRunAccepted = (run) => useBotOperationsStore.getState().upsertRun(run),
}: {
  api?: BotsApi;
  uuid?: () => string;
  now?: () => Date;
  getPrincipalId?: () => string;
  onRunAccepted?: (run: BotSendMessageResponse['run']) => void;
} = {}): BotChannelStore => create<BotChannelState>((set, get) => {
  let principalGeneration = 0;
  const pendingOwnerChannels = new Map<string, Promise<BotChannel>>();
  const latestMessageRefreshes = new Map<string, Promise<void>>();

  const removeChannelState = (state: BotChannelState, channelId: string) => {
    const messageIds = state.messageIdsByChannelId[channelId] || [];
    const messagesById = { ...state.messagesById };
    for (const messageId of messageIds) delete messagesById[messageId];
    return {
      activeChannelId: state.activeChannelId === channelId ? null : state.activeChannelId,
      channelsById: omitKey(state.channelsById, channelId),
      previewsByChannelId: omitKey(state.previewsByChannelId, channelId),
      messagesById,
      messageIdsByChannelId: omitKey(state.messageIdsByChannelId, channelId),
      attachmentIdsByChannelId: omitKey(state.attachmentIdsByChannelId, channelId),
      nextCursorByChannelId: omitKey(state.nextCursorByChannelId, channelId),
      loadingByChannelId: omitKey(state.loadingByChannelId, channelId),
      draftsByChannelId: omitKey(state.draftsByChannelId, channelId),
      pendingMessageIdByChannelId: omitKey(state.pendingMessageIdByChannelId, channelId),
      unconfirmedMessageIds: messageIds.reduce<Record<string, true>>((next, messageId) => {
        delete next[messageId];
        return next;
      }, { ...state.unconfirmedMessageIds }),
      sendErrorCodeByChannelId: omitKey(state.sendErrorCodeByChannelId, channelId),
      loadErrorCodeByChannelId: omitKey(state.loadErrorCodeByChannelId, channelId),
    };
  };

  const loadPage = async (channelId: string, reset: boolean): Promise<void> => {
    const state = get();
    if (!state.channelsById[channelId] || state.loadingByChannelId[channelId]) return;
    const cursor = reset ? null : state.nextCursorByChannelId[channelId];
    if (!reset && cursor === null) return;
    const generation = principalGeneration;
    set((current) => ({
      loadingByChannelId: { ...current.loadingByChannelId, [channelId]: true },
      loadErrorCodeByChannelId: omitKey(current.loadErrorCodeByChannelId, channelId),
    }));
    try {
      const page = await api.listMessages(channelId, { cursor, limit: 100 });
      if (generation !== principalGeneration || !get().channelsById[channelId]) return;
      get().mergeMessagePage(channelId, page, reset);
    } catch (error) {
      if (generation !== principalGeneration || !get().channelsById[channelId]) return;
      set((current) => ({
        loadErrorCodeByChannelId: {
          ...current.loadErrorCodeByChannelId,
          [channelId]: stableErrorCode(error),
        },
      }));
      throw error;
    } finally {
      if (generation === principalGeneration) {
        set((current) => {
          if (!current.loadingByChannelId[channelId]) return current;
          return { loadingByChannelId: omitKey(current.loadingByChannelId, channelId) };
        });
      }
    }
  };

  const mergeLatestMessagePage = (channelId: string, page: BotMessagePage): void => {
    set((state) => {
      if (!state.channelsById[channelId]) return state;
      const priorIds = state.messageIdsByChannelId[channelId] || [];
      const messagesById = { ...state.messagesById };
      let recordsChanged = false;
      let attachmentsChanged = false;
      for (const message of page.messages) {
        if (message.channelId !== channelId) continue;
        const current = state.messagesById[message.id];
        const value = preserveMessage(current, message);
        messagesById[message.id] = value;
        if (value !== current) {
          recordsChanged = true;
          if (!current || !sameStrings(current.body.attachmentIds, value.body.attachmentIds)) {
            attachmentsChanged = true;
          }
        }
      }
      const ids = sortedMessageIds(channelId, messagesById);
      const messageIds = sameStrings(priorIds, ids) ? priorIds : ids;
      const messageIdsByChannelId = messageIds === priorIds
        ? state.messageIdsByChannelId
        : { ...state.messageIdsByChannelId, [channelId]: messageIds };
      const currentAttachmentIds = state.attachmentIdsByChannelId[channelId] || [];
      const nextAttachmentIds = attachmentsChanged
        ? attachmentIdsForChannel(channelId, messageIdsByChannelId, messagesById)
        : currentAttachmentIds;
      const attachmentIds = sameStrings(currentAttachmentIds, nextAttachmentIds)
        ? currentAttachmentIds
        : nextAttachmentIds;
      const unconfirmedMessageIds = clearConfirmedMessages(
        state.unconfirmedMessageIds,
        page.messages,
      );
      if (!recordsChanged
        && messageIds === priorIds
        && attachmentIds === currentAttachmentIds
        && unconfirmedMessageIds === state.unconfirmedMessageIds) {
        return state;
      }
      return {
        messagesById: recordsChanged ? messagesById : state.messagesById,
        messageIdsByChannelId,
        attachmentIdsByChannelId: attachmentIds === currentAttachmentIds
          ? state.attachmentIdsByChannelId
          : { ...state.attachmentIdsByChannelId, [channelId]: attachmentIds },
        unconfirmedMessageIds,
      };
    });
  };

  const sendMessageContent = async ({
    channelId,
    text,
    attachmentIds,
  }: {
    channelId: string;
    text: string;
    attachmentIds: readonly string[];
  }): Promise<BotSendMessageResponse | null> => {
    const state = get();
    const channel = state.channelsById[channelId];
    if (!channel || !channel.canSend
      || (!text.trim() && attachmentIds.length === 0)
      || state.pendingMessageIdByChannelId[channelId]) {
      return null;
    }
    const messageId = uuid();
    const generation = principalGeneration;
    const idempotencyKey = `bot-message:${messageId}`;
    const optimistic: BotMessage = {
      id: messageId,
      channelId,
      runId: null,
      actorUserId: getPrincipalId(),
      role: 'user',
      assistantPhase: null,
      sequence: Math.max(
        channel.lastMessageSequence,
        ...(state.messageIdsByChannelId[channelId] || []).map(
          (id) => state.messagesById[id]?.sequence || 0,
        ),
      ) + 1,
      body: { text, attachmentIds: [...attachmentIds] },
      attachmentCount: attachmentIds.length,
      createdAt: now().toISOString(),
      finalizedAt: null,
    };
    const prewarmLeaseId = attachmentIds.length === 0
      ? takeBotPrewarmLease(channelId)
      : null;
    const request: BotSendMessageRequest = {
      messageId,
      idempotencyKey,
      text,
      attachmentIds,
      ...(prewarmLeaseId ? { prewarmLeaseId } : {}),
    };

    markBotPerformance('bot.submit');
    set((current) => {
      const messagesById = { ...current.messagesById, [messageId]: optimistic };
      const messageIds = sortedMessageIds(channelId, messagesById);
      const messageIdsByChannelId = {
        ...current.messageIdsByChannelId,
        [channelId]: messageIds,
      };
      const currentAttachmentIds = current.attachmentIdsByChannelId[channelId] || EMPTY_IDS;
      const projectedAttachmentIds = attachmentIds.length > 0
        ? attachmentIdsForChannel(channelId, messageIdsByChannelId, messagesById)
        : currentAttachmentIds;
      const nextAttachmentIds = sameStrings(currentAttachmentIds, projectedAttachmentIds)
        ? currentAttachmentIds
        : projectedAttachmentIds;
      return {
        messagesById,
        messageIdsByChannelId,
        attachmentIdsByChannelId: nextAttachmentIds === currentAttachmentIds
          ? current.attachmentIdsByChannelId
          : { ...current.attachmentIdsByChannelId, [channelId]: nextAttachmentIds },
        draftsByChannelId: omitKey(current.draftsByChannelId, channelId),
        pendingMessageIdByChannelId: {
          ...current.pendingMessageIdByChannelId,
          [channelId]: messageId,
        },
        unconfirmedMessageIds: omitKey(current.unconfirmedMessageIds, messageId),
        sendErrorCodeByChannelId: omitKey(current.sendErrorCodeByChannelId, channelId),
      };
    });

    const reconcileAccepted = (response: BotSendMessageResponse): BotSendMessageResponse => {
      markBotPerformance('bot.http-acceptance');
      if (generation !== principalGeneration || !get().channelsById[channelId]) return response;
      get().upsertMessage(response.message);
      onRunAccepted(response.run);
      set((current) => ({
        pendingMessageIdByChannelId: omitKey(current.pendingMessageIdByChannelId, channelId),
        unconfirmedMessageIds: omitKey(current.unconfirmedMessageIds, messageId),
        sendErrorCodeByChannelId: omitKey(current.sendErrorCodeByChannelId, channelId),
      }));
      return response;
    };

    const rollbackRejected = (error: unknown): void => {
      if (generation !== principalGeneration) return;
      set((current) => {
        const currentMessage = current.messagesById[messageId];
        const remainsOptimistic = currentMessage?.runId === null
          && currentMessage.finalizedAt === null;
        if (!remainsOptimistic) {
          return {
            pendingMessageIdByChannelId: omitKey(current.pendingMessageIdByChannelId, channelId),
            unconfirmedMessageIds: omitKey(current.unconfirmedMessageIds, messageId),
          };
        }
        const messagesById = omitKey(current.messagesById, messageId);
        const messageIds = (current.messageIdsByChannelId[channelId] || EMPTY_IDS)
          .filter((id) => id !== messageId);
        const messageIdsByChannelId = {
          ...current.messageIdsByChannelId,
          [channelId]: messageIds,
        };
        const currentAttachmentIds = current.attachmentIdsByChannelId[channelId] || EMPTY_IDS;
        const projectedAttachmentIds = attachmentIds.length > 0
          ? attachmentIdsForChannel(channelId, messageIdsByChannelId, messagesById)
          : currentAttachmentIds;
        const nextAttachmentIds = sameStrings(currentAttachmentIds, projectedAttachmentIds)
          ? currentAttachmentIds
          : projectedAttachmentIds;
        return {
          messagesById,
          messageIdsByChannelId,
          attachmentIdsByChannelId: nextAttachmentIds === currentAttachmentIds
            ? current.attachmentIdsByChannelId
            : { ...current.attachmentIdsByChannelId, [channelId]: nextAttachmentIds },
          draftsByChannelId: {
            ...current.draftsByChannelId,
            [channelId]: { text, attachmentIds: [...attachmentIds] },
          },
          pendingMessageIdByChannelId: omitKey(current.pendingMessageIdByChannelId, channelId),
          unconfirmedMessageIds: omitKey(current.unconfirmedMessageIds, messageId),
          sendErrorCodeByChannelId: {
            ...current.sendErrorCodeByChannelId,
            [channelId]: stableErrorCode(error),
          },
        };
      });
    };

    const reconcileAmbiguousAcceptance = async (
      firstError: unknown,
    ): Promise<BotSendMessageResponse | null> => {
      if (generation !== principalGeneration || !get().channelsById[channelId]) throw firstError;
      set((current) => ({
        unconfirmedMessageIds: { ...current.unconfirmedMessageIds, [messageId]: true },
        sendErrorCodeByChannelId: {
          ...current.sendErrorCodeByChannelId,
          [channelId]: 'bot_message_not_confirmed',
        },
      }));
      try {
        await get().refreshLatestMessages(channelId);
      } catch {
        // A failed snapshot does not prove rejection; retry the idempotent acceptance request.
      }
      if (generation !== principalGeneration || !get().channelsById[channelId]) throw firstError;
      const canonical = get().messagesById[messageId];
      if (canonical && (canonical.runId !== null || canonical.finalizedAt !== null)) {
        set((current) => ({
          pendingMessageIdByChannelId: omitKey(current.pendingMessageIdByChannelId, channelId),
          unconfirmedMessageIds: omitKey(current.unconfirmedMessageIds, messageId),
          sendErrorCodeByChannelId: omitKey(current.sendErrorCodeByChannelId, channelId),
        }));
        return null;
      }
      try {
        return reconcileAccepted(await api.sendMessage(channelId, request));
      } catch (retryError) {
        if (!isAmbiguousAcceptanceError(retryError)) {
          rollbackRejected(retryError);
          throw retryError;
        }
        set((current) => ({
          pendingMessageIdByChannelId: omitKey(current.pendingMessageIdByChannelId, channelId),
          unconfirmedMessageIds: { ...current.unconfirmedMessageIds, [messageId]: true },
          sendErrorCodeByChannelId: {
            ...current.sendErrorCodeByChannelId,
            [channelId]: 'bot_message_not_confirmed',
          },
        }));
        throw retryError;
      }
    };

    try {
      return reconcileAccepted(await api.sendMessage(channelId, request));
    } catch (error) {
      if (generation !== principalGeneration) throw error;
      if (isAmbiguousAcceptanceError(error)) return reconcileAmbiguousAcceptance(error);
      rollbackRejected(error);
      throw error;
    }
  };

  return {
    principalId: null,
    activeChannelId: null,
    channelsById: {},
    previewsByChannelId: {},
    messagesById: {},
    messageIdsByChannelId: {},
    attachmentIdsByChannelId: {},
    nextCursorByChannelId: {},
    loadingByChannelId: {},
    draftsByChannelId: {},
    pendingMessageIdByChannelId: {},
    unconfirmedMessageIds: {},
    sendErrorCodeByChannelId: {},
    loadErrorCodeByChannelId: {},
    openingOwnerChannelByBotId: {},
    ownerChannelErrorCodeByBotId: {},

    resetPrincipal(principalId) {
      principalGeneration += 1;
      set((state) => {
        if (
          state.principalId === principalId
          && state.activeChannelId === null
          && Object.keys(state.channelsById).length === 0
          && Object.keys(state.previewsByChannelId).length === 0
          && Object.keys(state.messagesById).length === 0
          && Object.keys(state.attachmentIdsByChannelId).length === 0
          && Object.keys(state.draftsByChannelId).length === 0
          && Object.keys(state.unconfirmedMessageIds).length === 0
          && Object.keys(state.openingOwnerChannelByBotId).length === 0
          && Object.keys(state.ownerChannelErrorCodeByBotId).length === 0
        ) return state;
        return {
          principalId,
          activeChannelId: null,
          channelsById: {},
          previewsByChannelId: {},
          messagesById: {},
          messageIdsByChannelId: {},
          attachmentIdsByChannelId: {},
          nextCursorByChannelId: {},
          loadingByChannelId: {},
          draftsByChannelId: {},
          pendingMessageIdByChannelId: {},
          unconfirmedMessageIds: {},
          sendErrorCodeByChannelId: {},
          loadErrorCodeByChannelId: {},
          openingOwnerChannelByBotId: {},
          ownerChannelErrorCodeByBotId: {},
        };
      });
      pendingOwnerChannels.clear();
      latestMessageRefreshes.clear();
    },

    setActiveChannel(channelId) {
      set((state) => state.activeChannelId === channelId ? state : { activeChannelId: channelId });
    },

    replaceSnapshot(snapshot) {
      set((state) => {
        const snapshotPreviews = snapshot.channelPreviews ?? EMPTY_PREVIEWS;
        const channelsById: Record<string, BotChannel> = {};
        let channelsChanged = Object.keys(state.channelsById).length !== snapshot.channels.length;
        for (const channel of snapshot.channels) {
          const value = preserveChannel(state.channelsById[channel.id], channel);
          channelsById[channel.id] = value;
          if (value !== state.channelsById[channel.id]) channelsChanged = true;
        }
        const resolvedChannels = channelsChanged ? channelsById : state.channelsById;
        const previewsByChannelId: Record<string, BotChannelPreview> = {};
        let previewsChanged = Object.keys(state.previewsByChannelId).length !== snapshotPreviews.length;
        for (const preview of snapshotPreviews) {
          if (!channelsById[preview.channelId]) continue;
          const current = state.previewsByChannelId[preview.channelId];
          const value = current && previewEqual(current, preview) ? current : preview;
          previewsByChannelId[preview.channelId] = value;
          if (value !== current) previewsChanged = true;
        }
        const resolvedPreviews = previewsChanged ? previewsByChannelId : state.previewsByChannelId;
        const removedIds = Object.keys(state.channelsById).filter((id) => !channelsById[id]);
        if (removedIds.length === 0) {
          if (resolvedChannels === state.channelsById && resolvedPreviews === state.previewsByChannelId) return state;
          return { channelsById: resolvedChannels, previewsByChannelId: resolvedPreviews };
        }
        let next: Partial<BotChannelState> = {
          channelsById: resolvedChannels,
          previewsByChannelId: resolvedPreviews,
        };
        let working = { ...state, ...next } as BotChannelState;
        for (const channelId of removedIds) {
          next = { ...next, ...removeChannelState(working, channelId) };
          working = { ...working, ...next } as BotChannelState;
        }
        return next;
      });
    },

    upsertChannel(channel) {
      set((state) => {
        const current = state.channelsById[channel.id];
        const value = preserveChannel(current, channel);
        if (value === current) return state;
        return { channelsById: { ...state.channelsById, [channel.id]: value } };
      });
    },

    upsertPreview(preview) {
      set((state) => {
        if (!state.channelsById[preview.channelId]) return state;
        const current = state.previewsByChannelId[preview.channelId];
        if (current && preview.sequence < current.sequence) return state;
        const value = current && previewEqual(current, preview) ? current : preview;
        if (value === current) return state;
        return {
          previewsByChannelId: {
            ...state.previewsByChannelId,
            [preview.channelId]: value,
          },
        };
      });
    },

    removeChannel(channelId) {
      set((state) => (
        state.channelsById[channelId] ? removeChannelState(state, channelId) : state
      ));
    },

    upsertMessage(message) {
      set((state) => {
        if (!state.channelsById[message.channelId]) return state;
        const current = state.messagesById[message.id];
        const value = preserveMessage(current, message);
        const unconfirmedMessageIds = clearConfirmedMessages(
          state.unconfirmedMessageIds,
          [message],
        );
        if (value === current) {
          return unconfirmedMessageIds === state.unconfirmedMessageIds
            ? state
            : { unconfirmedMessageIds };
        }
        const messagesById = { ...state.messagesById, [message.id]: value };
        const currentIds = state.messageIdsByChannelId[message.channelId] || [];
        const nextIds = sortedMessageIds(message.channelId, messagesById);
        const messageIds = sameStrings(currentIds, nextIds) ? currentIds : nextIds;
        const channel = state.channelsById[message.channelId];
        const lastMessageSequence = Math.max(channel.lastMessageSequence, message.sequence);
        const lastMessageAt = !channel.lastMessageAt || message.createdAt > channel.lastMessageAt
          ? message.createdAt
          : channel.lastMessageAt;
        const nextChannel = lastMessageSequence === channel.lastMessageSequence
          && lastMessageAt === channel.lastMessageAt
          ? channel
          : { ...channel, lastMessageSequence, lastMessageAt };
        const currentPreview = state.previewsByChannelId[message.channelId];
        const nextPreview: BotChannelPreview | undefined = (
          message.finalizedAt !== null
          && (message.role === 'user' || message.role === 'assistant')
          && message.assistantPhase !== 'acknowledgment'
          && (message.body.text.trim().length > 0 || message.attachmentCount > 0)
          && (!currentPreview || message.sequence >= currentPreview.sequence)
        ) ? {
            channelId: message.channelId,
            messageId: message.id,
            role: message.role,
            sequence: message.sequence,
            text: message.body.text,
            attachmentCount: message.attachmentCount,
            createdAt: message.createdAt,
            finalizedAt: message.finalizedAt,
          } : currentPreview;
        const preview = currentPreview && nextPreview && previewEqual(currentPreview, nextPreview)
          ? currentPreview
          : nextPreview;
        const attachmentIdsChanged = current
          ? !sameStrings(current.body.attachmentIds, message.body.attachmentIds)
          : message.body.attachmentIds.length > 0;
        const currentAttachmentIds = state.attachmentIdsByChannelId[message.channelId] || [];
        const nextAttachmentIds = attachmentIdsChanged
          ? attachmentIdsForChannel(message.channelId, {
            ...state.messageIdsByChannelId,
            [message.channelId]: messageIds,
          }, messagesById)
          : currentAttachmentIds;
        const attachmentIds = sameStrings(currentAttachmentIds, nextAttachmentIds)
          ? currentAttachmentIds
          : nextAttachmentIds;
        return {
          messagesById,
          messageIdsByChannelId: messageIds === currentIds
            ? state.messageIdsByChannelId
            : { ...state.messageIdsByChannelId, [message.channelId]: messageIds },
          attachmentIdsByChannelId: attachmentIds === currentAttachmentIds
            ? state.attachmentIdsByChannelId
            : { ...state.attachmentIdsByChannelId, [message.channelId]: attachmentIds },
          channelsById: nextChannel === channel
            ? state.channelsById
            : { ...state.channelsById, [message.channelId]: nextChannel },
          previewsByChannelId: preview === currentPreview
            ? state.previewsByChannelId
            : preview
              ? { ...state.previewsByChannelId, [message.channelId]: preview }
              : state.previewsByChannelId,
          unconfirmedMessageIds,
        };
      });
    },

    removeMessage(messageId) {
      set((state) => {
        const message = state.messagesById[messageId];
        if (!message) return state;
        const messagesById = omitKey(state.messagesById, messageId);
        const ids = (state.messageIdsByChannelId[message.channelId] || [])
          .filter((id) => id !== messageId);
        const messageIdsByChannelId = {
          ...state.messageIdsByChannelId,
          [message.channelId]: ids,
        };
        const currentAttachmentIds = state.attachmentIdsByChannelId[message.channelId] || [];
        const nextAttachmentIds = message.body.attachmentIds.length > 0
          ? attachmentIdsForChannel(message.channelId, messageIdsByChannelId, messagesById)
          : currentAttachmentIds;
        const attachmentIds = sameStrings(currentAttachmentIds, nextAttachmentIds)
          ? currentAttachmentIds
          : nextAttachmentIds;
        return {
          messagesById,
          messageIdsByChannelId,
          attachmentIdsByChannelId: attachmentIds === currentAttachmentIds
            ? state.attachmentIdsByChannelId
            : { ...state.attachmentIdsByChannelId, [message.channelId]: attachmentIds },
          unconfirmedMessageIds: omitKey(state.unconfirmedMessageIds, messageId),
        };
      });
    },

    mergeMessagePage(channelId, page, reset = false) {
      set((state) => {
        if (!state.channelsById[channelId]) return state;
        const priorIds = state.messageIdsByChannelId[channelId] || [];
        const incomingIds = new Set(page.messages.map((message) => message.id));
        const messagesById = { ...state.messagesById };
        let recordsChanged = false;
        let attachmentsChanged = false;
        if (reset) {
          for (const messageId of priorIds) {
            if (!incomingIds.has(messageId)) {
              if ((messagesById[messageId]?.body.attachmentIds.length || 0) > 0) attachmentsChanged = true;
              delete messagesById[messageId];
              recordsChanged = true;
            }
          }
        }
        for (const message of page.messages) {
          if (message.channelId !== channelId) continue;
          const current = state.messagesById[message.id];
          const value = preserveMessage(current, message);
          messagesById[message.id] = value;
          if (value !== current) {
            recordsChanged = true;
            if (!current || !sameStrings(current.body.attachmentIds, value.body.attachmentIds)) {
              attachmentsChanged = true;
            }
          }
        }
        const ids = sortedMessageIds(channelId, messagesById);
        const messageIds = sameStrings(priorIds, ids) ? priorIds : ids;
        const messageIdsByChannelId = messageIds === priorIds
          ? state.messageIdsByChannelId
          : { ...state.messageIdsByChannelId, [channelId]: messageIds };
        const currentAttachmentIds = state.attachmentIdsByChannelId[channelId] || [];
        const nextAttachmentIds = attachmentsChanged
          ? attachmentIdsForChannel(channelId, messageIdsByChannelId, messagesById)
          : currentAttachmentIds;
        const attachmentIds = sameStrings(currentAttachmentIds, nextAttachmentIds)
          ? currentAttachmentIds
          : nextAttachmentIds;
        const cursorUnchanged = state.nextCursorByChannelId[channelId] === page.nextCursor;
        const unconfirmedMessageIds = clearConfirmedMessages(
          state.unconfirmedMessageIds,
          page.messages,
        );
        if (
          !recordsChanged
          && messageIds === priorIds
          && attachmentIds === currentAttachmentIds
          && cursorUnchanged
          && unconfirmedMessageIds === state.unconfirmedMessageIds
        ) return state;
        return {
          messagesById: recordsChanged ? messagesById : state.messagesById,
          messageIdsByChannelId,
          attachmentIdsByChannelId: attachmentIds === currentAttachmentIds
            ? state.attachmentIdsByChannelId
            : { ...state.attachmentIdsByChannelId, [channelId]: attachmentIds },
          nextCursorByChannelId: cursorUnchanged
            ? state.nextCursorByChannelId
            : { ...state.nextCursorByChannelId, [channelId]: page.nextCursor },
          unconfirmedMessageIds,
        };
      });
    },

    loadInitialMessages: (channelId) => loadPage(channelId, true),
    loadOlderMessages: (channelId) => loadPage(channelId, false),
    refreshLatestMessages(channelId) {
      const existing = latestMessageRefreshes.get(channelId);
      if (existing) return existing;
      const generation = principalGeneration;
      const request = (async () => {
        if (!get().channelsById[channelId]) return;
        const page = await api.listMessages(channelId, { cursor: null, limit: 100 });
        if (generation !== principalGeneration || !get().channelsById[channelId]) return;
        mergeLatestMessagePage(channelId, page);
      })().finally(() => {
        if (latestMessageRefreshes.get(channelId) === request) {
          latestMessageRefreshes.delete(channelId);
        }
      });
      latestMessageRefreshes.set(channelId, request);
      return request;
    },

    ensureOwnerChannel(botId) {
      const principalId = getPrincipalId();
      const existing = Object.values(get().channelsById).find((channel) => (
        channel.botId === botId
        && channel.ownerUserId === principalId
        && channel.lifecycle === 'active'
      ));
      if (existing) return Promise.resolve(existing);
      const pending = pendingOwnerChannels.get(botId);
      if (pending) return pending;

      const generation = principalGeneration;
      set((state) => ({
        openingOwnerChannelByBotId: {
          ...state.openingOwnerChannelByBotId,
          [botId]: true,
        },
        ownerChannelErrorCodeByBotId: omitKey(state.ownerChannelErrorCodeByBotId, botId),
      }));
      const request = api.getOrCreateOwnerChannel(botId)
        .then(({ channel }) => {
          if (generation === principalGeneration) get().upsertChannel(channel);
          return channel;
        })
        .catch((error) => {
          if (generation === principalGeneration) {
            set((state) => ({
              ownerChannelErrorCodeByBotId: {
                ...state.ownerChannelErrorCodeByBotId,
                [botId]: stableErrorCode(error),
              },
            }));
          }
          throw error;
        })
        .finally(() => {
          if (pendingOwnerChannels.get(botId) === request) pendingOwnerChannels.delete(botId);
          if (generation === principalGeneration) {
            set((state) => ({
              openingOwnerChannelByBotId: omitKey(state.openingOwnerChannelByBotId, botId),
            }));
          }
        });
      pendingOwnerChannels.set(botId, request);
      return request;
    },

    setDraft(channelId, draft) {
      const normalized = { text: draft.text, attachmentIds: [...draft.attachmentIds] };
      set((state) => {
        const current = state.draftsByChannelId[channelId];
        if (current && draftEqual(current, normalized)) return state;
        return { draftsByChannelId: { ...state.draftsByChannelId, [channelId]: normalized } };
      });
    },

    clearDraft(channelId) {
      set((state) => (
        state.draftsByChannelId[channelId]
          ? { draftsByChannelId: omitKey(state.draftsByChannelId, channelId) }
          : state
      ));
    },

    async sendDraft(channelId) {
      const state = get();
      const draft = state.draftsByChannelId[channelId];
      if (!draft) return null;
      return sendMessageContent({
        channelId,
        text: draft.text,
        attachmentIds: draft.attachmentIds,
      });
    },

    async retryRun(runId) {
      const source = Object.values(get().messagesById).find((message) => (
        message.runId === runId && message.role === 'user'
      ));
      if (!source) return null;
      try {
        const response = await api.retryRun(runId);
        onRunAccepted(response.run);
        set((state) => ({
          sendErrorCodeByChannelId: omitKey(state.sendErrorCodeByChannelId, source.channelId),
        }));
        return response;
      } catch (error) {
        set((state) => ({
          sendErrorCodeByChannelId: {
            ...state.sendErrorCodeByChannelId,
            [source.channelId]: stableErrorCode(error),
          },
        }));
        throw error;
      }
    },
  };
});

export const useBotChannelStore = createBotChannelStore();

export const botChannelSelectors = Object.freeze({
  channel: (channelId: string) => (state: BotChannelState) => state.channelsById[channelId],
  messageIds: (channelId: string) => (state: BotChannelState) => (
    state.messageIdsByChannelId[channelId] || EMPTY_IDS
  ),
  attachmentIds: (channelId: string) => (state: BotChannelState) => (
    state.attachmentIdsByChannelId[channelId] || EMPTY_IDS
  ),
  preview: (channelId: string) => (state: BotChannelState) => state.previewsByChannelId[channelId],
  draft: (channelId: string) => (state: BotChannelState) => state.draftsByChannelId[channelId],
  pendingMessageId: (channelId: string) => (state: BotChannelState) => (
    state.pendingMessageIdByChannelId[channelId]
  ),
  ownerChannelId: (botId: string, principalId: string | null) => (state: BotChannelState) => (
    Object.values(state.channelsById).find((channel) => (
      channel.botId === botId
      && channel.ownerUserId === principalId
      && channel.lifecycle === 'active'
    ))?.id ?? null
  ),
});
