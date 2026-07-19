import { create } from 'zustand';

interface AgentRuntimeWarmupState {
  warmingDirectory: string | null;
  setWarmingDirectory: (directory: string | null) => void;
}

export const useAgentRuntimeWarmupStore = create<AgentRuntimeWarmupState>((set) => ({
  warmingDirectory: null,
  setWarmingDirectory: (directory) => {
    const normalized = typeof directory === 'string' && directory.trim() ? directory.trim() : null;
    set((state) => (state.warmingDirectory === normalized ? state : { warmingDirectory: normalized }));
  },
}));
