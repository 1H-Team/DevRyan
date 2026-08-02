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
};

export const useFeatureFlagsStore = create<FeatureFlagsStore>((set) => ({
  planModeEnabled: false,
  setPlanModeEnabled: (enabled) => set({ planModeEnabled: enabled }),
  messageListVirtualizationEnabled: true,
  setMessageListVirtualizationEnabled: (enabled) => set({ messageListVirtualizationEnabled: enabled }),
}));
