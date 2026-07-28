import { create } from 'zustand'

import {
  areSessionChangeAttributionsEqual,
  projectSessionChangeAttribution,
  type SessionChangeAttribution,
} from '@/lib/sessionChangeAttribution'
import type { State } from '@/sync/types'

type SessionChangeAttributionStore = {
  entries: Map<string, SessionChangeAttribution>
}

const normalizeDirectory = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}

export const getSessionChangeAttributionKey = (directory: string, sessionID: string): string =>
  `${normalizeDirectory(directory)}\0${sessionID}`

export const useSessionChangeAttributionStore = create<SessionChangeAttributionStore>(() => ({
  entries: new Map(),
}))

export const reconcileSessionChangeAttribution = (
  directory: string,
  sessionID: string,
  state: State,
): void => {
  if (!directory || !sessionID) return
  const key = getSessionChangeAttributionKey(directory, sessionID)
  const next = projectSessionChangeAttribution(state, sessionID, directory)

  useSessionChangeAttributionStore.setState((current) => {
    const previous = current.entries.get(key)
    if (areSessionChangeAttributionsEqual(previous, next)) return current

    const entries = new Map(current.entries)
    if (next.paths.length === 0 && !next.hasUnattributedMutations) {
      entries.delete(key)
    } else {
      entries.set(key, next)
    }
    return { entries }
  })
}

export const clearSessionChangeAttribution = (directory: string, sessionID: string): void => {
  if (!directory || !sessionID) return
  const key = getSessionChangeAttributionKey(directory, sessionID)
  useSessionChangeAttributionStore.setState((current) => {
    if (!current.entries.has(key)) return current
    const entries = new Map(current.entries)
    entries.delete(key)
    return { entries }
  })
}

export const clearDirectorySessionChangeAttributions = (directory: string): void => {
  if (!directory) return
  const prefix = `${normalizeDirectory(directory)}\0`
  useSessionChangeAttributionStore.setState((current) => {
    if (![...current.entries.keys()].some((key) => key.startsWith(prefix))) return current
    const entries = new Map(current.entries)
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) entries.delete(key)
    }
    return { entries }
  })
}
