import { create } from 'zustand';

type FeatureFlagsStore = {
  planModeEnabled: boolean;
  setPlanModeEnabled: (enabled: boolean) => void;
  /**
   * Virtualize long chat transcripts (see MessageList). Default on; escape
   * hatch in case a scroll/anchoring regression shows up in the field.
   */
  messageListVirtualizationEnabled: boolean;
  setMessageListVirtualizationEnabled: (enabled: boolean) => void;
  /**
   * Adaptive first-page loading and bounded session intent prefetch. Default
   * on; disabling keeps the authoritative loader but restores 200-message
   * on-click pages and suppresses background prefetch.
   */
  sessionFastLoadEnabled: boolean;
  setSessionFastLoadEnabled: (enabled: boolean) => void;
};

export const useFeatureFlagsStore = create<FeatureFlagsStore>((set) => ({
  planModeEnabled: false,
  setPlanModeEnabled: (enabled) => set({ planModeEnabled: enabled }),
  messageListVirtualizationEnabled: true,
  setMessageListVirtualizationEnabled: (enabled) => set({ messageListVirtualizationEnabled: enabled }),
  sessionFastLoadEnabled: true,
  setSessionFastLoadEnabled: (enabled) => set({ sessionFastLoadEnabled: enabled }),
}));
