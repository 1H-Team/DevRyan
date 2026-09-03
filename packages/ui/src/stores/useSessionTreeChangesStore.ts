import { create } from 'zustand'

import { opencodeClient, type SessionTreeChangedFile, type SessionTreeChanges } from '@/lib/opencode/client'
import { sessionEvents } from '@/lib/sessionEvents'

/**
 * Files changed by a session tree (root + every sub-agent session that worked
 * for it), as reported by `GET /api/openchamber/session/:id/changes`.
 *
 * Keyed by `${directory}\0${rootSessionID}`. Refreshes are debounced (500 ms)
 * and every response is checked against the latest request for its key so a
 * slow, superseded fetch can never overwrite fresher data.
 */
export type SessionTreeChangesEntry = {
  files: SessionTreeChangedFile[]
  sessionCount: number
  hasUnattributedMutations: boolean
  firstUserMessageID: string | null
  fetchedAt: number
  loading: boolean
  error: string | null
}

type SessionTreeChangesStore = {
  entries: Map<string, SessionTreeChangesEntry>
}

export type SessionTreeChangesFetcher = (
  rootSessionID: string,
  directory: string,
  signal: AbortSignal,
) => Promise<SessionTreeChanges>

export const SESSION_TREE_CHANGES_DEBOUNCE_MS = 500

const EMPTY_FILES: SessionTreeChangedFile[] = []

const normalizeDirectory = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}

export const getSessionTreeChangesKey = (directory: string, rootSessionID: string): string =>
  `${normalizeDirectory(directory)}\0${rootSessionID}`

const splitKey = (key: string): { directory: string; rootSessionID: string } => {
  const separator = key.indexOf('\0')
  return separator < 0
    ? { directory: key, rootSessionID: '' }
    : { directory: key.slice(0, separator), rootSessionID: key.slice(separator + 1) }
}

export const useSessionTreeChangesStore = create<SessionTreeChangesStore>(() => ({
  entries: new Map(),
}))

const defaultFetcher: SessionTreeChangesFetcher = (rootSessionID, directory, signal) =>
  opencodeClient.getSessionTreeChanges(rootSessionID, directory, { signal })

let fetcher: SessionTreeChangesFetcher = defaultFetcher
let debounceMs = SESSION_TREE_CHANGES_DEBOUNCE_MS

/** Test seam: swap the network fetcher; pass `null` to restore the default. */
export const setSessionTreeChangesFetcher = (next: SessionTreeChangesFetcher | null): void => {
  fetcher = next ?? defaultFetcher
}

/** Test seam: shorten the debounce; pass `null` to restore the default. */
export const setSessionTreeChangesDebounceForTests = (ms: number | null): void => {
  debounceMs = ms ?? SESSION_TREE_CHANGES_DEBOUNCE_MS
}

// Per-key bookkeeping lives outside the store so it never causes renders.
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const requestSequence = new Map<string, number>()
const inFlightControllers = new Map<string, AbortController>()
const subscriberCounts = new Map<string, number>()
const workingByKey = new Map<string, boolean>()

const patchEntry = (key: string, patch: Partial<SessionTreeChangesEntry>): void => {
  useSessionTreeChangesStore.setState((current) => {
    const previous = current.entries.get(key)
    const next: SessionTreeChangesEntry = {
      files: previous?.files ?? EMPTY_FILES,
      sessionCount: previous?.sessionCount ?? 0,
      hasUnattributedMutations: previous?.hasUnattributedMutations ?? false,
      firstUserMessageID: previous?.firstUserMessageID ?? null,
      fetchedAt: previous?.fetchedAt ?? 0,
      loading: previous?.loading ?? false,
      error: previous?.error ?? null,
      ...patch,
    }
    const entries = new Map(current.entries)
    entries.set(key, next)
    return { entries }
  })
}

const areFilesEqual = (left: SessionTreeChangedFile[], right: SessionTreeChangedFile[]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (
      a.path !== b.path
      || a.status !== b.status
      || a.additions !== b.additions
      || a.deletions !== b.deletions
      || a.sessions.length !== b.sessions.length
      || a.sessions.some((id, sessionIndex) => id !== b.sessions[sessionIndex])
    ) {
      return false
    }
  }
  return true
}

/** Fetch now, ignoring the debounce. Superseded responses are dropped. */
export async function refreshSessionTreeChanges(directory: string, rootSessionID: string): Promise<void> {
  if (!directory || !rootSessionID) return
  const key = getSessionTreeChangesKey(directory, rootSessionID)

  const pendingTimer = debounceTimers.get(key)
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer)
    debounceTimers.delete(key)
  }

  inFlightControllers.get(key)?.abort()
  const controller = new AbortController()
  inFlightControllers.set(key, controller)

  const sequence = (requestSequence.get(key) ?? 0) + 1
  requestSequence.set(key, sequence)

  patchEntry(key, { loading: true })

  let result: SessionTreeChanges | null = null
  let failure: string | null = null
  try {
    result = await fetcher(rootSessionID, directory, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) return
    failure = error instanceof Error ? error.message : String(error)
  }

  // A newer request for the same key owns the entry now.
  if (requestSequence.get(key) !== sequence) return
  if (inFlightControllers.get(key) === controller) {
    inFlightControllers.delete(key)
  }

  if (!result) {
    patchEntry(key, { loading: false, error: failure })
    return
  }

  const previous = useSessionTreeChangesStore.getState().entries.get(key)
  patchEntry(key, {
    files: previous && areFilesEqual(previous.files, result.files) ? previous.files : result.files,
    sessionCount: result.sessionCount,
    hasUnattributedMutations: result.hasUnattributedMutations,
    firstUserMessageID: result.firstUserMessageID,
    fetchedAt: Date.now(),
    loading: false,
    error: null,
  })
}

/** Debounced refresh (500 ms). Multiple triggers within the window coalesce. */
export function requestSessionTreeChangesRefresh(
  directory: string,
  rootSessionID: string,
  options: { immediate?: boolean } = {},
): void {
  if (!directory || !rootSessionID) return
  if (options.immediate) {
    void refreshSessionTreeChanges(directory, rootSessionID)
    return
  }
  const key = getSessionTreeChangesKey(directory, rootSessionID)
  const existing = debounceTimers.get(key)
  if (existing !== undefined) clearTimeout(existing)
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key)
    void refreshSessionTreeChanges(directory, rootSessionID)
  }, debounceMs))
}

/**
 * Record the tree's live activity. A working → idle edge (of the root or any
 * descendant, folded into one flag by the caller) schedules a refresh.
 */
export function observeSessionTreeActivity(directory: string, rootSessionID: string, isWorking: boolean): void {
  if (!directory || !rootSessionID) return
  const key = getSessionTreeChangesKey(directory, rootSessionID)
  const previous = workingByKey.get(key)
  workingByKey.set(key, isWorking)
  if (previous === true && !isWorking) {
    requestSessionTreeChangesRefresh(directory, rootSessionID)
  }
}

/**
 * Keep a key live: fetches immediately on first subscription and re-fetches on
 * git refresh hints for its directory while at least one subscriber remains.
 */
export function subscribeSessionTreeChanges(directory: string, rootSessionID: string): () => void {
  if (!directory || !rootSessionID) return () => {}
  const key = getSessionTreeChangesKey(directory, rootSessionID)
  const count = (subscriberCounts.get(key) ?? 0) + 1
  subscriberCounts.set(key, count)
  if (count === 1 || !useSessionTreeChangesStore.getState().entries.has(key)) {
    void refreshSessionTreeChanges(directory, rootSessionID)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (subscriberCounts.get(key) ?? 1) - 1
    if (remaining <= 0) {
      subscriberCounts.delete(key)
      workingByKey.delete(key)
    } else {
      subscriberCounts.set(key, remaining)
    }
  }
}

export const isSessionTreeChangesSubscribed = (directory: string, rootSessionID: string): boolean =>
  (subscriberCounts.get(getSessionTreeChangesKey(directory, rootSessionID)) ?? 0) > 0

export function clearSessionTreeChanges(directory: string, rootSessionID: string): void {
  if (!directory || !rootSessionID) return
  const key = getSessionTreeChangesKey(directory, rootSessionID)
  const timer = debounceTimers.get(key)
  if (timer !== undefined) {
    clearTimeout(timer)
    debounceTimers.delete(key)
  }
  inFlightControllers.get(key)?.abort()
  inFlightControllers.delete(key)
  requestSequence.set(key, (requestSequence.get(key) ?? 0) + 1)
  workingByKey.delete(key)
  useSessionTreeChangesStore.setState((current) => {
    if (!current.entries.has(key)) return current
    const entries = new Map(current.entries)
    entries.delete(key)
    return { entries }
  })
}

export function clearDirectorySessionTreeChanges(directory: string): void {
  if (!directory) return
  const prefix = `${normalizeDirectory(directory)}\0`
  for (const key of [...useSessionTreeChangesStore.getState().entries.keys(), ...debounceTimers.keys()]) {
    if (!key.startsWith(prefix)) continue
    const { rootSessionID } = splitKey(key)
    clearSessionTreeChanges(directory, rootSessionID)
  }
}

/** Test seam: drop every entry, timer, and subscription. */
export function resetSessionTreeChangesForTests(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
  for (const controller of inFlightControllers.values()) controller.abort()
  inFlightControllers.clear()
  requestSequence.clear()
  subscriberCounts.clear()
  workingByKey.clear()
  useSessionTreeChangesStore.setState({ entries: new Map() })
}

// Shell commands and tool edits already broadcast git refresh hints; the same
// hint keeps every subscribed tree in that directory fresh.
sessionEvents.onGitRefreshHint(({ directory }) => {
  const prefix = `${normalizeDirectory(directory)}\0`
  for (const key of subscriberCounts.keys()) {
    if (!key.startsWith(prefix)) continue
    const { rootSessionID } = splitKey(key)
    requestSessionTreeChangesRefresh(directory, rootSessionID)
  }
})
