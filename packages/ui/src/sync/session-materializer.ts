import type { ChildStoreManager } from "./child-store"
import { dropSessionCaches } from "./session-cache"

export const ARCHIVED_OFFLOAD_TTL_MS = 20 * 60 * 1000

export type SessionMaterializationLevel = "unmaterialized" | "hydrating" | "firstPageLoaded" | "summaryOnly" | "error"

export type SessionMaterializationState = {
  level: SessionMaterializationLevel
  archived: boolean
  updatedAt: number
  error?: string
}

type EnsureOptions = {
  force?: boolean
  reason?: string
}

type DirectoryMaterializerCallbacks = {
  ensureFirstPage: (sessionID: string, options?: EnsureOptions) => Promise<void>
  loadOlderMessages: (sessionID: string) => Promise<void>
  offloadSession: (sessionID: string) => void
}

const callbacksByDirectory = new Map<string, DirectoryMaterializerCallbacks>()
const materializationState = new Map<string, SessionMaterializationState>()
const archivedOffloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
let childStoresRef: ChildStoreManager | null = null

const keyFor = (directory: string | undefined, sessionID: string) => `${directory ?? ""}\n${sessionID}`

const nowState = (
  level: SessionMaterializationLevel,
  archived: boolean,
  error?: string,
): SessionMaterializationState => ({
  level,
  archived,
  updatedAt: Date.now(),
  ...(error ? { error } : {}),
})

function setMaterializationState(directory: string | undefined, sessionID: string, state: SessionMaterializationState) {
  if (!sessionID) return
  materializationState.set(keyFor(directory, sessionID), state)
}

function getCallbacks(directory?: string): DirectoryMaterializerCallbacks | undefined {
  if (!directory) return undefined
  return callbacksByDirectory.get(directory)
}

export function setSessionMaterializerChildStores(childStores: ChildStoreManager): void {
  childStoresRef = childStores
}

export function clearSessionMaterializerChildStores(childStores: ChildStoreManager): void {
  if (childStoresRef === childStores) {
    childStoresRef = null
  }
}

export function releaseSessionMaterializerDirectory(directory: string): void {
  if (!directory) return
  callbacksByDirectory.delete(directory)
  const prefix = `${directory}\n`
  for (const key of materializationState.keys()) {
    if (key.startsWith(prefix)) {
      materializationState.delete(key)
    }
  }
  for (const [key, timer] of archivedOffloadTimers) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(timer)
    archivedOffloadTimers.delete(key)
  }
}

export function getSessionMaterializerDirectoryRetainedCountsForTest(directory: string) {
  const prefix = `${directory}\n`
  return {
    callbacks: callbacksByDirectory.has(directory) ? 1 : 0,
    states: [...materializationState.keys()].filter((key) => key.startsWith(prefix)).length,
    timers: [...archivedOffloadTimers.keys()].filter((key) => key.startsWith(prefix)).length,
  }
}

function offloadSessionCaches(sessionID: string, directory?: string): void {
  if (!sessionID) return
  const store = directory ? childStoresRef?.getChild(directory) : undefined
  if (store) {
    const current = store.getState()
    const draft = {
      message: { ...current.message },
      part: { ...current.part },
      session_status: { ...current.session_status },
      session_diff: { ...current.session_diff },
      todo: { ...current.todo },
      permission: { ...current.permission },
      question: { ...current.question },
      revert_transaction: { ...current.revert_transaction },
    }
    dropSessionCaches(draft, [sessionID])
    delete draft.revert_transaction[sessionID]
    store.setState(draft)
    return
  }

  getCallbacks(directory)?.offloadSession(sessionID)
}

export function registerSessionMaterializer(
  directory: string,
  callbacks: DirectoryMaterializerCallbacks,
): () => void {
  if (!directory) return () => undefined
  callbacksByDirectory.set(directory, callbacks)
  return () => {
    if (callbacksByDirectory.get(directory) === callbacks) {
      callbacksByDirectory.delete(directory)
    }
  }
}

export function getMaterializationState(sessionID: string, directory?: string): SessionMaterializationState {
  return materializationState.get(keyFor(directory, sessionID))
    ?? nowState("unmaterialized", false)
}

export async function ensureFirstPage(
  sessionID: string,
  directory?: string,
  options?: EnsureOptions,
): Promise<void> {
  if (!sessionID) return
  const existing = getMaterializationState(sessionID, directory)
  setMaterializationState(directory, sessionID, nowState("hydrating", existing.archived))

  const callbacks = getCallbacks(directory)
  if (!callbacks) {
    setMaterializationState(directory, sessionID, nowState("error", existing.archived, "Session loader is not ready"))
    return
  }

  try {
    await callbacks.ensureFirstPage(sessionID, options)
    if (getCallbacks(directory) !== callbacks) return
    const latest = getMaterializationState(sessionID, directory)
    setMaterializationState(directory, sessionID, nowState("firstPageLoaded", latest.archived))
  } catch (error) {
    if (getCallbacks(directory) !== callbacks) return
    const latest = getMaterializationState(sessionID, directory)
    const message = error instanceof Error ? error.message : "Session materialization failed"
    setMaterializationState(directory, sessionID, nowState("error", latest.archived, message))
    throw error
  }
}

export async function ensureSessionMaterialized(
  sessionID: string,
  directory?: string,
  options?: EnsureOptions,
): Promise<void> {
  await ensureFirstPage(sessionID, directory, options)
}

export async function loadOlderMessages(sessionID: string, directory?: string): Promise<void> {
  if (!sessionID) return
  const callbacks = getCallbacks(directory)
  if (!callbacks) {
    await ensureSessionMaterialized(sessionID, directory, { reason: "load-older-no-loader" })
    return
  }
  await callbacks.loadOlderMessages(sessionID)
}

export function cancelArchivedOffload(sessionID: string, directory?: string): void {
  const key = keyFor(directory, sessionID)
  const timer = archivedOffloadTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    archivedOffloadTimers.delete(key)
  }
}

export function scheduleArchivedOffload(sessionID: string, directory?: string): void {
  if (!sessionID) return
  cancelArchivedOffload(sessionID, directory)
  const key = keyFor(directory, sessionID)
  const timer = setTimeout(() => {
    archivedOffloadTimers.delete(key)
    offloadSessionCaches(sessionID, directory)
    setMaterializationState(directory, sessionID, nowState("summaryOnly", true))
  }, ARCHIVED_OFFLOAD_TTL_MS)
  ;(timer as { unref?: () => void }).unref?.()
  archivedOffloadTimers.set(key, timer)
}

export function markArchived(sessionID: string, directory?: string): void {
  if (!sessionID) return
  const current = getMaterializationState(sessionID, directory)
  setMaterializationState(directory, sessionID, nowState(current.level, true, current.error))
  scheduleArchivedOffload(sessionID, directory)
}

export function markUnarchived(sessionID: string, directory?: string): void {
  if (!sessionID) return
  cancelArchivedOffload(sessionID, directory)
  const current = getMaterializationState(sessionID, directory)
  setMaterializationState(directory, sessionID, nowState(current.level === "summaryOnly" ? "unmaterialized" : current.level, false, current.error))
  void ensureSessionMaterialized(sessionID, directory, { reason: "unarchive" }).catch(() => undefined)
}

export function offloadArchivedSessionNow(sessionID: string, directory?: string): void {
  cancelArchivedOffload(sessionID, directory)
  offloadSessionCaches(sessionID, directory)
  setMaterializationState(directory, sessionID, nowState("summaryOnly", true))
}
