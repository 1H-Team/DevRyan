import { create, type StoreApi, type UseBoundStore } from 'zustand';

import type { BotChannel, BotSharedFile } from '@/lib/botsApi';

const EMPTY_IDS: readonly string[] = Object.freeze([]);

export type BotSharedFilesState = {
  principalId: string | null;
  filesById: Readonly<Record<string, BotSharedFile>>;
  fileIdsByChannelId: Readonly<Record<string, readonly string[]>>;
  fileIdsByMessageId: Readonly<Record<string, readonly string[]>>;
  resetPrincipal(principalId: string | null): void;
  replaceSnapshot(channels: readonly BotChannel[]): void;
  replaceChannel(channelId: string, files: readonly BotSharedFile[]): void;
  upsertFile(file: BotSharedFile): void;
  removeChannel(channelId: string): void;
  removeBot(botId: string): void;
};

export type BotSharedFilesStore = UseBoundStore<StoreApi<BotSharedFilesState>>;

const fileEqual = (left: BotSharedFile, right: BotSharedFile): boolean => (
  left.id === right.id
  && left.botId === right.botId
  && left.channelId === right.channelId
  && left.messageId === right.messageId
  && left.objectId === right.objectId
  && left.senderUserId === right.senderUserId
  && left.direction === right.direction
  && left.filename === right.filename
  && left.contentType === right.contentType
  && left.sha256 === right.sha256
  && left.size === right.size
  && left.computerPath === right.computerPath
  && left.copyState === right.copyState
  && left.errorCode === right.errorCode
  && left.createdAt === right.createdAt
  && left.updatedAt === right.updatedAt
);

const sameIds = (left: readonly string[], right: readonly string[]): boolean => (
  left === right
  || (left.length === right.length && left.every((value, index) => value === right[index]))
);

const orderedIds = (
  channelId: string,
  filesById: Readonly<Record<string, BotSharedFile>>,
): readonly string[] => Object.values(filesById)
  .filter((file) => file.channelId === channelId)
  .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
  .map((file) => file.id);

const indexByMessage = (
  filesById: Readonly<Record<string, BotSharedFile>>,
): Readonly<Record<string, readonly string[]>> => {
  const grouped: Record<string, string[]> = {};
  for (const file of Object.values(filesById)) {
    (grouped[file.messageId] ||= []).push(file.id);
  }
  for (const ids of Object.values(grouped)) ids.sort();
  return grouped;
};

const removeChannels = (state: BotSharedFilesState, channelIds: ReadonlySet<string>) => {
  if (channelIds.size === 0) return state;
  const filesById = Object.fromEntries(Object.entries(state.filesById)
    .filter(([, file]) => !channelIds.has(file.channelId)));
  const fileIdsByChannelId = Object.fromEntries(Object.entries(state.fileIdsByChannelId)
    .filter(([channelId]) => !channelIds.has(channelId)));
  return { filesById, fileIdsByChannelId, fileIdsByMessageId: indexByMessage(filesById) };
};

export const createBotSharedFilesStore = (): BotSharedFilesStore => create<BotSharedFilesState>((set) => ({
  principalId: null,
  filesById: {},
  fileIdsByChannelId: {},
  fileIdsByMessageId: {},

  resetPrincipal(principalId) {
    set((state) => {
      if (state.principalId === principalId
        && Object.keys(state.filesById).length === 0
        && Object.keys(state.fileIdsByChannelId).length === 0
        && Object.keys(state.fileIdsByMessageId).length === 0) return state;
      return { principalId, filesById: {}, fileIdsByChannelId: {}, fileIdsByMessageId: {} };
    });
  },

  replaceSnapshot(channels) {
    const allowed = new Set(channels.map((channel) => channel.id));
    set((state) => {
      const removed = new Set(Object.keys(state.fileIdsByChannelId)
        .filter((channelId) => !allowed.has(channelId)));
      return removeChannels(state, removed);
    });
  },

  replaceChannel(channelId, files) {
    const incoming = files.filter((file) => file.channelId === channelId);
    set((state) => {
      const filesById = { ...state.filesById };
      for (const id of state.fileIdsByChannelId[channelId] || EMPTY_IDS) delete filesById[id];
      for (const file of incoming) {
        const current = state.filesById[file.id];
        filesById[file.id] = current && fileEqual(current, file) ? current : file;
      }
      const ids = orderedIds(channelId, filesById);
      const currentIds = state.fileIdsByChannelId[channelId] || EMPTY_IDS;
      const fileIdsByChannelId = sameIds(currentIds, ids)
        ? state.fileIdsByChannelId
        : { ...state.fileIdsByChannelId, [channelId]: ids };
      const unchangedFiles = Object.keys(filesById).length === Object.keys(state.filesById).length
        && Object.entries(filesById).every(([id, file]) => state.filesById[id] === file);
      if (unchangedFiles && fileIdsByChannelId === state.fileIdsByChannelId) return state;
      return {
        filesById: unchangedFiles ? state.filesById : filesById,
        fileIdsByChannelId,
        fileIdsByMessageId: unchangedFiles
          ? state.fileIdsByMessageId
          : indexByMessage(filesById),
      };
    });
  },

  upsertFile(file) {
    set((state) => {
      const current = state.filesById[file.id];
      if (current && fileEqual(current, file)) return state;
      const filesById = { ...state.filesById, [file.id]: file };
      const currentIds = state.fileIdsByChannelId[file.channelId] || EMPTY_IDS;
      const ids = orderedIds(file.channelId, filesById);
      return {
        filesById,
        fileIdsByMessageId: indexByMessage(filesById),
        fileIdsByChannelId: sameIds(currentIds, ids)
          ? state.fileIdsByChannelId
          : { ...state.fileIdsByChannelId, [file.channelId]: ids },
      };
    });
  },

  removeChannel(channelId) {
    set((state) => removeChannels(state, new Set([channelId])));
  },

  removeBot(botId) {
    set((state) => removeChannels(state, new Set(Object.values(state.filesById)
      .filter((file) => file.botId === botId)
      .map((file) => file.channelId))));
  },
}));

export const useBotSharedFilesStore = createBotSharedFilesStore();

export const botSharedFilesSelectors = Object.freeze({
  fileIds: (channelId: string) => (state: BotSharedFilesState) => (
    state.fileIdsByChannelId[channelId] || EMPTY_IDS
  ),
  file: (fileId: string) => (state: BotSharedFilesState) => state.filesById[fileId],
  messageFileIds: (messageId: string) => (state: BotSharedFilesState) => (
    state.fileIdsByMessageId[messageId] || EMPTY_IDS
  ),
});
