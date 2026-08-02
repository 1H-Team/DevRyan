import { create } from "zustand"

import {
  haveSameProviderStallFingerprint,
  type ProviderStallFingerprint,
} from "@/sync/reconnect-recovery"

export type ProviderStallInput = ProviderStallFingerprint & {
  directory: string
  confirmedAt: number
}

export type ProviderStallRecord = ProviderStallInput & {
  pending: boolean
  actionError: string | null
}

type ProviderStallStore = {
  stallsBySessionId: Readonly<Record<string, ProviderStallRecord>>
  offerStall(stall: ProviderStallInput): void
  setActionState(sessionID: string, pending: boolean, actionError: string | null): void
  clearStall(sessionID: string, expected?: ProviderStallFingerprint): void
  clearDirectory(directory: string): void
  reset(): void
}

const emptyStalls = () => ({} as Readonly<Record<string, ProviderStallRecord>>)

export const useProviderStallStore = create<ProviderStallStore>()((set) => ({
  stallsBySessionId: emptyStalls(),
  offerStall(stall) {
    set((state) => {
      const previous = state.stallsBySessionId[stall.sessionID]
      if (
        previous
        && haveSameProviderStallFingerprint(previous, stall)
        && previous.directory === stall.directory
      ) {
        return state
      }
      return {
        stallsBySessionId: {
          ...state.stallsBySessionId,
          [stall.sessionID]: {
            ...stall,
            pending: false,
            actionError: null,
          },
        },
      }
    })
  },
  setActionState(sessionID, pending, actionError) {
    set((state) => {
      const previous = state.stallsBySessionId[sessionID]
      if (!previous) return state
      if (previous.pending === pending && previous.actionError === actionError) return state
      return {
        stallsBySessionId: {
          ...state.stallsBySessionId,
          [sessionID]: { ...previous, pending, actionError },
        },
      }
    })
  },
  clearStall(sessionID, expected) {
    set((state) => {
      const previous = state.stallsBySessionId[sessionID]
      if (!previous) return state
      if (expected && !haveSameProviderStallFingerprint(previous, expected)) return state
      const stallsBySessionId = { ...state.stallsBySessionId }
      delete stallsBySessionId[sessionID]
      return { stallsBySessionId }
    })
  },
  clearDirectory(directory) {
    set((state) => {
      const entries = Object.entries(state.stallsBySessionId)
      if (!entries.some(([, record]) => record.directory === directory)) return state
      return {
        stallsBySessionId: Object.fromEntries(
          entries.filter(([, record]) => record.directory !== directory),
        ),
      }
    })
  },
  reset() {
    set({ stallsBySessionId: emptyStalls() })
  },
}))

export const providerStallSelector = (sessionID: string) => (state: ProviderStallStore) => (
  state.stallsBySessionId[sessionID]
)
