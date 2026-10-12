import { create } from "zustand"
import type { GlobalState } from "./types"
import { INITIAL_GLOBAL_STATE } from "./types"

export type GlobalSyncStore = GlobalState & {
  /** Bumped by startup Retry to replace bootstrap and its event subscription. */
  bootstrapEpoch: number
  eventStreamReady: boolean
  actions: {
    set: (patch: Partial<GlobalState>) => void
    reset: () => void
    retryBootstrap: () => void
  }
}

export const useGlobalSyncStore = create<GlobalSyncStore>()((set) => ({
  ...INITIAL_GLOBAL_STATE,
  bootstrapEpoch: 0,
  eventStreamReady: false,
  actions: {
    set: (patch) => set(patch),
    reset: () => set({ ...INITIAL_GLOBAL_STATE, eventStreamReady: false }),
    // Explicit startup Retry also replaces a connected stream that never acknowledged readiness.
    retryBootstrap: () => set((state) => ({ error: undefined, ready: false, bootstrapEpoch: state.bootstrapEpoch + 1 })),
  },
}))

// Fine-grained selectors — use these in components for minimal re-renders
export const selectReady = (s: GlobalSyncStore) => s.ready
export const selectProjects = (s: GlobalSyncStore) => s.projects
export const selectProviders = (s: GlobalSyncStore) => s.providers
export const selectConfig = (s: GlobalSyncStore) => s.config
export const selectPath = (s: GlobalSyncStore) => s.path
export const selectReload = (s: GlobalSyncStore) => s.reload
export const selectSessionTodo = (s: GlobalSyncStore) => s.sessionTodo
