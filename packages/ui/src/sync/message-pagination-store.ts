import { createStore } from "zustand/vanilla"
import { useStore } from "zustand"

export type SessionMessagePagination = {
  limit: number
  cursor: string | undefined
  complete: boolean
  loading: boolean
  initialized: boolean
}

export const DEFAULT_SESSION_MESSAGE_PAGINATION: SessionMessagePagination = Object.freeze({
  limit: 200,
  cursor: undefined,
  complete: false,
  loading: false,
  initialized: false,
})

type PaginationState = {
  byKey: Map<string, SessionMessagePagination>
}

const paginationStore = createStore<PaginationState>(() => ({ byKey: new Map() }))
const inflight = new Map<string, Promise<boolean>>()
const activeTokens = new Map<string, number>()
let nextToken = 1

const normalizeDirectory = (directory: string): string => {
  const trimmed = directory.trim().replace(/\\/g, "/")
  return trimmed.replace(/\/+$/, "") || "/"
}

const keyFor = (directory: string, sessionID: string): string => (
  `${normalizeDirectory(directory)}\n${sessionID}`
)

const paginationEqual = (
  left: SessionMessagePagination,
  right: SessionMessagePagination,
): boolean => (
  left.limit === right.limit
  && left.cursor === right.cursor
  && left.complete === right.complete
  && left.loading === right.loading
  && left.initialized === right.initialized
)

export function getSessionMessagePagination(
  directory: string,
  sessionID: string,
): SessionMessagePagination {
  return paginationStore.getState().byKey.get(keyFor(directory, sessionID))
    ?? DEFAULT_SESSION_MESSAGE_PAGINATION
}

export function setSessionMessagePagination(
  directory: string,
  sessionID: string,
  patch: Partial<SessionMessagePagination>,
): SessionMessagePagination {
  const key = keyFor(directory, sessionID)
  const current = paginationStore.getState().byKey.get(key)
    ?? DEFAULT_SESSION_MESSAGE_PAGINATION
  const next = { ...current, ...patch }
  if (paginationEqual(current, next)) return current

  paginationStore.setState((state) => {
    const byKey = new Map(state.byKey)
    byKey.set(key, next)
    return { byKey }
  })
  return next
}

export function useSessionMessagePagination(
  directory: string,
  sessionID: string | null | undefined,
): SessionMessagePagination {
  const key = sessionID ? keyFor(directory, sessionID) : null
  return useStore(
    paginationStore,
    (state) => (key ? state.byKey.get(key) : undefined) ?? DEFAULT_SESSION_MESSAGE_PAGINATION,
  )
}

export function runSessionMessageLoad(input: {
  directory: string
  sessionID: string
  task: (token: number) => Promise<boolean>
}): Promise<boolean> {
  const key = keyFor(input.directory, input.sessionID)
  const pending = inflight.get(key)
  if (pending) return pending

  const token = nextToken
  nextToken += 1
  activeTokens.set(key, token)
  const promise = Promise.resolve().then(() => input.task(token)).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
    if (activeTokens.get(key) === token) activeTokens.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

export function isSessionMessageLoadCurrent(
  directory: string,
  sessionID: string,
  token: number,
): boolean {
  return activeTokens.get(keyFor(directory, sessionID)) === token
}

export function clearSessionMessagePagination(
  directory: string,
  sessionIDs: Iterable<string>,
): void {
  const keys = new Set<string>()
  for (const sessionID of sessionIDs) {
    if (sessionID) keys.add(keyFor(directory, sessionID))
  }
  if (keys.size === 0) return

  for (const key of keys) {
    inflight.delete(key)
    activeTokens.delete(key)
  }
  paginationStore.setState((state) => {
    let byKey: Map<string, SessionMessagePagination> | undefined
    for (const key of keys) {
      if (!state.byKey.has(key)) continue
      byKey ??= new Map(state.byKey)
      byKey.delete(key)
    }
    return byKey ? { byKey } : state
  })
}

export function clearSessionMessagePaginationDirectory(directory: string): void {
  const prefix = `${normalizeDirectory(directory)}\n`
  const keys = new Set([
    ...paginationStore.getState().byKey.keys(),
    ...inflight.keys(),
    ...activeTokens.keys(),
  ])
  clearSessionMessagePagination(
    directory,
    [...keys]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  )
}

export function getSessionMessagePaginationStoreForTest() {
  return paginationStore
}

export function resetSessionMessagePaginationStoreForTest(): void {
  paginationStore.setState({ byKey: new Map() })
  inflight.clear()
  activeTokens.clear()
  nextToken = 1
}
