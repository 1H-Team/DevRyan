import { create } from 'zustand';

export type BotOperationsNavigationTab = 'approvals';

type BotOperationsNavigationState = {
  botId: string | null;
  tab: BotOperationsNavigationTab;
  focusedActionId: string | null;
  focusAction(botId: string, tab: BotOperationsNavigationTab, actionId: string): void;
  selectTab(botId: string, tab: BotOperationsNavigationTab): void;
  clear(): void;
};

export const useBotOperationsNavigationStore = create<BotOperationsNavigationState>((set) => ({
  botId: null,
  tab: 'approvals',
  focusedActionId: null,
  focusAction: (botId, tab, focusedActionId) => set({ botId, tab, focusedActionId }),
  selectTab: (botId, tab) => set({ botId, tab, focusedActionId: null }),
  clear: () => set({ botId: null, tab: 'approvals', focusedActionId: null }),
}));
