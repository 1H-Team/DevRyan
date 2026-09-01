import { create, type StoreApi, type UseBoundStore } from 'zustand';

export type BotComposerDraft = { text: string; attachmentIds: readonly string[] };
export type BotDraftState = {
  generation: number;
  draftsByChannelId: Readonly<Record<string, BotComposerDraft>>;
  setDraft(channelId: string, draft: BotComposerDraft): void;
  clearDraft(channelId: string): void;
  reset(): void;
};
export type BotDraftStore = UseBoundStore<StoreApi<BotDraftState>>;

// Keystrokes must never notify canonical transcript or roster subscribers.
export const createBotDraftStore = (): BotDraftStore => create<BotDraftState>((set) => ({
  generation: 0,
  draftsByChannelId: {},
  setDraft(channelId, draft) {
    set((state) => {
      const current = state.draftsByChannelId[channelId];
      if (current?.text === draft.text
        && current.attachmentIds.length === draft.attachmentIds.length
        && current.attachmentIds.every((id, index) => id === draft.attachmentIds[index])) return state;
      return { draftsByChannelId: {
        ...state.draftsByChannelId,
        [channelId]: { text: draft.text, attachmentIds: [...draft.attachmentIds] },
      } };
    });
  },
  clearDraft(channelId) {
    set((state) => {
      if (!state.draftsByChannelId[channelId]) return state;
      const draftsByChannelId = { ...state.draftsByChannelId };
      delete draftsByChannelId[channelId];
      return { draftsByChannelId };
    });
  },
  reset: () => set((state) => ({ generation: state.generation + 1, draftsByChannelId: {} })),
}));
