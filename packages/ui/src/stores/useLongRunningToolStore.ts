import { create } from "zustand"

import {
  haveSameLongRunningToolFingerprint,
  type LongRunningToolFingerprint,
} from "@/sync/reconnect-recovery"

export type LongRunningToolObservation = LongRunningToolFingerprint & {
  directory: string
  observedAt: number
  lastActivityAt: number
}

export type LongRunningToolRecord = LongRunningToolObservation & {
  confirmedAt: number | null
  diagnosticMarkedAt: number | null
  pending: boolean
  actionError: string | null
}

type LongRunningToolStore = {
  recordsBySessionId: Readonly<Record<string, LongRunningToolRecord>>
  observeTool(observation: LongRunningToolObservation, activityObserved?: boolean): void
  confirmTool(observation: LongRunningToolObservation, confirmedAt: number): boolean
  setActionState(sessionID: string, pending: boolean, actionError: string | null): void
  clearTool(sessionID: string, expected?: LongRunningToolFingerprint): void
  clearDirectory(directory: string): void
  reset(): void
}

const emptyRecords = () => ({} as Readonly<Record<string, LongRunningToolRecord>>)

export const useLongRunningToolStore = create<LongRunningToolStore>()((set) => ({
  recordsBySessionId: emptyRecords(),
  observeTool(observation, activityObserved = true) {
    set((state) => {
      const previous = state.recordsBySessionId[observation.sessionID]
      if (
        previous
        && haveSameLongRunningToolFingerprint(previous, observation)
        && previous.directory === observation.directory
      ) {
        if (!activityObserved || previous.lastActivityAt === observation.lastActivityAt) return state
        return {
          recordsBySessionId: {
            ...state.recordsBySessionId,
            [observation.sessionID]: {
              ...previous,
              lastActivityAt: observation.lastActivityAt,
              confirmedAt: null,
              pending: false,
              actionError: null,
            },
          },
        }
      }

      return {
        recordsBySessionId: {
          ...state.recordsBySessionId,
          [observation.sessionID]: {
            ...observation,
            confirmedAt: null,
            diagnosticMarkedAt: null,
            pending: false,
            actionError: null,
          },
        },
      }
    })
  },
  confirmTool(observation, confirmedAt) {
    let confirmed = false
    set((state) => {
      const current = state.recordsBySessionId[observation.sessionID]
      if (
        current
        && (!haveSameLongRunningToolFingerprint(current, observation) || current.directory !== observation.directory)
      ) {
        return state
      }
      if (current && current.confirmedAt !== null) return state
      confirmed = current?.diagnosticMarkedAt === null || !current
      return {
        recordsBySessionId: {
          ...state.recordsBySessionId,
          [observation.sessionID]: {
            ...(current ?? observation),
            confirmedAt,
            diagnosticMarkedAt: current?.diagnosticMarkedAt ?? confirmedAt,
            pending: false,
            actionError: null,
          },
        },
      }
    })
    return confirmed
  },
  setActionState(sessionID, pending, actionError) {
    set((state) => {
      const previous = state.recordsBySessionId[sessionID]
      if (!previous) return state
      if (previous.pending === pending && previous.actionError === actionError) return state
      return {
        recordsBySessionId: {
          ...state.recordsBySessionId,
          [sessionID]: { ...previous, pending, actionError },
        },
      }
    })
  },
  clearTool(sessionID, expected) {
    set((state) => {
      const previous = state.recordsBySessionId[sessionID]
      if (!previous) return state
      if (expected && !haveSameLongRunningToolFingerprint(previous, expected)) return state
      const recordsBySessionId = { ...state.recordsBySessionId }
      delete recordsBySessionId[sessionID]
      return { recordsBySessionId }
    })
  },
  clearDirectory(directory) {
    set((state) => {
      const entries = Object.entries(state.recordsBySessionId)
      if (!entries.some(([, record]) => record.directory === directory)) return state
      return {
        recordsBySessionId: Object.fromEntries(
          entries.filter(([, record]) => record.directory !== directory),
        ),
      }
    })
  },
  reset() {
    set({ recordsBySessionId: emptyRecords() })
  },
}))

export const longRunningToolSelector = (sessionID: string) => (state: LongRunningToolStore) => (
  state.recordsBySessionId[sessionID]
)
