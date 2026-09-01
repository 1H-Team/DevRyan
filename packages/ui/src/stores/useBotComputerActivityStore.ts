import { create } from 'zustand';

export type BotComputerActivity = Readonly<{
  botId: string;
  channelId: string;
  runId: string;
  revision: number;
  state: 'active' | 'waiting' | 'idle';
}>;

type State = {
  byBotId: Readonly<Record<string, BotComputerActivity>>;
  manualByBotId: Readonly<Record<string, { channelId: string; request: number }>>;
  reset(): void;
  upsert(activity: BotComputerActivity): void;
  replace(activities: readonly BotComputerActivity[]): void;
  removeBot(botId: string): void;
  removeChannel(channelId: string): void;
  show(botId: string, channelId: string): void;
  hide(botId: string): void;
};

const withoutKey = <T,>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> => {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

export const useBotComputerActivityStore = create<State>((set) => ({
  byBotId: {}, manualByBotId: {},
  reset: () => set({ byBotId: {}, manualByBotId: {} }),
  upsert: (activity) => set((state) => {
    if ((state.byBotId[activity.botId]?.revision ?? -1) >= activity.revision) return state;
    return { byBotId: { ...state.byBotId, [activity.botId]: activity } };
  }),
  replace: (activities) => set({ byBotId: Object.fromEntries(activities.map((a) => [a.botId, a])) }),
  removeBot: (botId) => set((state) => ({
    byBotId: withoutKey(state.byBotId, botId), manualByBotId: withoutKey(state.manualByBotId, botId),
  })),
  removeChannel: (channelId) => set((state) => ({
    byBotId: Object.fromEntries(Object.entries(state.byBotId).filter(([, a]) => a.channelId !== channelId)),
    manualByBotId: Object.fromEntries(Object.entries(state.manualByBotId).filter(([, a]) => a.channelId !== channelId)),
  })),
  show: (botId, channelId) => set((state) => ({
    manualByBotId: { ...state.manualByBotId, [botId]: { channelId, request: (state.manualByBotId[botId]?.request ?? 0) + 1 } },
  })),
  hide: (botId) => set((state) => ({ manualByBotId: withoutKey(state.manualByBotId, botId) })),
}));
