import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { botsApi, type BotsApi, type BotChannel, type BotSharedFile } from '@/lib/botsApi';

const EMPTY_IDS: readonly string[] = Object.freeze([]);

export type BotSharedFilesState = {
  principalId: string | null;
  filesById: Readonly<Record<string, BotSharedFile>>;
  fileIdsByChannelId: Readonly<Record<string, readonly string[]>>;
  fileIdsByMessageId: Readonly<Record<string, readonly string[]>>;
  captureScope(channelId: string): () => boolean;
  loadChannel(botId: string, channelId: string, api?: Pick<BotsApi, 'listSharedFiles'>): Promise<readonly BotSharedFile[]>;
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
  previous: Readonly<Record<string, readonly string[]>> = {},
): Readonly<Record<string, readonly string[]>> => {
  const grouped: Record<string, string[]> = {};
  for (const file of Object.values(filesById)) {
    (grouped[file.messageId] ||= []).push(file.id);
  }
  const result: Record<string, readonly string[]> = {};
  for (const [messageId, ids] of Object.entries(grouped)) {
    ids.sort();
    result[messageId] = previous[messageId] && sameIds(previous[messageId], ids) ? previous[messageId] : ids;
  }
  return Object.keys(result).length === Object.keys(previous).length
    && Object.entries(result).every(([id, ids]) => previous[id] === ids) ? previous : result;
};

const removeChannels = (state: BotSharedFilesState, channelIds: ReadonlySet<string>) => {
  if (channelIds.size === 0) return state;
  const filesById = Object.fromEntries(Object.entries(state.filesById)
    .filter(([, file]) => !channelIds.has(file.channelId)));
  const fileIdsByChannelId = Object.fromEntries(Object.entries(state.fileIdsByChannelId)
    .filter(([channelId]) => !channelIds.has(channelId)));
  return { filesById, fileIdsByChannelId, fileIdsByMessageId: indexByMessage(filesById, state.fileIdsByMessageId) };
};

export const createBotSharedFilesStore = (): BotSharedFilesStore => create<BotSharedFilesState>((set, get) => {
  let principalGeneration = 0;
  let mutationVersion = 0;
  let allowedChannels: Set<string> | null = null;
  const channelGenerations = new Map<string, number>();
  const mutations = new Map<string, number>();
  const requests = new Map<string, Promise<readonly BotSharedFile[]>>();
  const requestBotIds = new Map<string, string>();
  const invalidate = (channelId: string) => {
    channelGenerations.set(channelId, (channelGenerations.get(channelId) ?? 0) + 1);
    requests.delete(channelId);
    requestBotIds.delete(channelId);
  };
  return {
  principalId: null,
  filesById: {},
  fileIdsByChannelId: {},
  fileIdsByMessageId: {},

  captureScope(channelId) {
    const generation = principalGeneration;
    const channelGeneration = channelGenerations.get(channelId) ?? 0;
    return () => generation === principalGeneration
      && channelGeneration === (channelGenerations.get(channelId) ?? 0)
      && (allowedChannels === null || allowedChannels.has(channelId));
  },

  loadChannel(botId, channelId, api = botsApi) {
    const existing = requests.get(channelId);
    if (existing) return existing;
    if (allowedChannels && !allowedChannels.has(channelId)) return Promise.resolve([]);
    const generation = principalGeneration;
    const channelGeneration = channelGenerations.get(channelId) ?? 0;
    const version = mutationVersion;
    const request = api.listSharedFiles(botId, channelId).then(({ sharedFiles }) => {
      if (generation !== principalGeneration
        || channelGeneration !== (channelGenerations.get(channelId) ?? 0)
        || (allowedChannels && !allowedChannels.has(channelId))) return [];
      const state = get();
      const merged = new Map<string, BotSharedFile>();
      for (const file of sharedFiles) {
        if (file.channelId !== channelId || file.botId !== botId) continue;
        const current = state.filesById[file.id];
        merged.set(file.id, current && ((mutations.get(file.id) ?? 0) > version
          || current.updatedAt > file.updatedAt) ? current : file);
      }
      // Missing rows can mean deletion only for rows predating this snapshot.
      for (const id of state.fileIdsByChannelId[channelId] ?? []) {
        if ((mutations.get(id) ?? 0) > version) merged.set(id, state.filesById[id]);
      }
      get().replaceChannel(channelId, [...merged.values()]);
      return (get().fileIdsByChannelId[channelId] ?? []).map((id) => get().filesById[id]);
    }).finally(() => {
      if (requests.get(channelId) === request) {
        requests.delete(channelId);
        requestBotIds.delete(channelId);
      }
    });
    requests.set(channelId, request);
    requestBotIds.set(channelId, botId);
    return request;
  },

  resetPrincipal(principalId) {
    principalGeneration += 1;
    allowedChannels = null;
    channelGenerations.clear();
    requests.clear();
    requestBotIds.clear();
    mutations.clear();
    mutationVersion = 0;
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
    for (const channelId of new Set([...(allowedChannels ?? []), ...requests.keys(), ...Object.keys(get().fileIdsByChannelId)])) {
      if (!allowed.has(channelId)) invalidate(channelId);
    }
    allowedChannels = allowed;
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
          : indexByMessage(filesById, state.fileIdsByMessageId),
      };
    });
  },

  upsertFile(file) {
    if (allowedChannels && !allowedChannels.has(file.channelId)) return;
    mutations.set(file.id, ++mutationVersion);
    set((state) => {
      const current = state.filesById[file.id];
      if (current && (fileEqual(current, file) || current.updatedAt > file.updatedAt)) return state;
      const filesById = { ...state.filesById, [file.id]: file };
      const currentIds = state.fileIdsByChannelId[file.channelId] || EMPTY_IDS;
      const ids = orderedIds(file.channelId, filesById);
      return {
        filesById,
        fileIdsByMessageId: indexByMessage(filesById, state.fileIdsByMessageId),
        fileIdsByChannelId: sameIds(currentIds, ids)
          ? state.fileIdsByChannelId
          : { ...state.fileIdsByChannelId, [file.channelId]: ids },
      };
    });
  },

  removeChannel(channelId) {
    invalidate(channelId);
    allowedChannels?.delete(channelId);
    set((state) => removeChannels(state, new Set([channelId])));
  },

  removeBot(botId) {
    for (const [channelId, requestedBotId] of requestBotIds) {
      if (requestedBotId === botId) invalidate(channelId);
    }
    for (const file of Object.values(get().filesById)) {
      if (file.botId === botId) invalidate(file.channelId);
    }
    set((state) => removeChannels(state, new Set(Object.values(state.filesById)
      .filter((file) => file.botId === botId)
      .map((file) => file.channelId))));
  },
};
});

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
