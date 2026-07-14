/**
 * Sync refs — imperative access to sync state from non-React code.
 *
 * SyncProvider sets these refs on mount. Store actions (session-ui-store,
 * session-actions) use them to read child-store domain data without hooks.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import type { ChildStoreManager } from "./child-store"
import { getSessionMaterializationStatus } from "./materialization"
import type { SessionUIState } from "./session-ui-store"
import type { State } from "./types"

let _sdk: OpencodeClient | null = null
let _childStores: ChildStoreManager | null = null
let _directory: string = ""
let _registerSessionDirectory: ((sessionID: string, directory: string) => void) | null = null
let _sessionUIStore: StoreApi<SessionUIState> | null = null

export function setSessionUIStoreRef(store: StoreApi<SessionUIState>): void {
  _sessionUIStore = store
}

export function clearSessionUIStoreRef(store: StoreApi<SessionUIState>): boolean {
  if (_sessionUIStore !== store) return false
  _sessionUIStore = null
  return true
}

export function getSessionUIStore(): StoreApi<SessionUIState> {
  if (!_sessionUIStore) throw new Error("Session UI store not initialized")
  return _sessionUIStore
}

export function setSyncRefs(
  sdk: OpencodeClient,
  childStores: ChildStoreManager,
  directory: string,
  registerSessionDirectory?: (sessionID: string, directory: string) => void,
) {
  _sdk = sdk
  _childStores = childStores
  _directory = directory
  if (registerSessionDirectory) {
    _registerSessionDirectory = registerSessionDirectory
  }
}

export function clearSyncRefs(childStores: ChildStoreManager): boolean {
  if (_childStores !== childStores) return false
  _sdk = null
  _childStores = null
  _directory = ""
  _registerSessionDirectory = null
  return true
}

/** Pre-register a session→directory mapping in the routing index.
 *  Called from session-actions when creating sessions so SSE events
 *  arriving before session.created can be routed correctly. */
export function registerSessionDirectory(sessionID: string, directory: string) {
  _registerSessionDirectory?.(sessionID, directory)
}

export function getSyncSDK(): OpencodeClient {
  if (!_sdk) throw new Error("SDK not initialized — is SyncProvider mounted?")
  return _sdk
}

export function getSyncChildStores(): ChildStoreManager {
  if (!_childStores) throw new Error("ChildStoreManager not initialized — is SyncProvider mounted?")
  return _childStores
}

export function getSyncDirectory(): string {
  return _directory
}

/** Read current directory's child store state. Returns undefined if not bootstrapped. */
export function getDirectoryState(directory?: string): State | undefined {
  const stores = _childStores
  if (!stores) return undefined
  const dir = directory || _directory
  if (!dir) return undefined
  return stores.getState(dir)
}

/** Read sessions from current directory's child store */
export function getSyncSessions(directory?: string) {
  return getDirectoryState(directory)?.session ?? []
}

/** Read sessions across all initialized child stores */
export function getAllSyncSessions() {
  const stores = _childStores
  if (!stores) return []

  const deduped = new Map<string, State["session"][number]>()
  for (const store of stores.children.values()) {
    for (const session of store.getState().session) {
      if (!session?.id) continue
      deduped.set(session.id, session)
    }
  }
  return Array.from(deduped.values())
}

/** Read messages for a session from current directory's child store */
export function getSyncMessages(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.message[sessionId] ?? []
}

/** Read renderability of a session snapshot from current directory's child store */
export function getSyncSessionMaterializationStatus(sessionId: string, directory?: string) {
  const state = getDirectoryState(directory)
  if (!state) return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  return getSessionMaterializationStatus(state, sessionId)
}

/** Read parts for a message from current directory's child store */
export function getSyncParts(messageId: string, directory?: string) {
  return getDirectoryState(directory)?.part[messageId] ?? []
}

/** Read session status from current directory's child store */
export function getSyncSessionStatus(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.session_status[sessionId]
}

/** Read all known session statuses across initialized child stores. */
export function getAllSyncSessionStatuses() {
  const stores = _childStores
  const statuses: State["session_status"] = {}
  if (!stores) return statuses

  for (const store of stores.children.values()) {
    const state = store.getState()
    for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
      if (!status) continue
      statuses[sessionId] = status
    }
  }
  return statuses
}

/** Read a session status from the session's own initialized directory when known. */
export function getSyncSessionStatusAnyDirectory(sessionId: string) {
  const stores = _childStores
  if (!stores) return undefined

  for (const store of stores.children.values()) {
    const status = store.getState().session_status?.[sessionId]
    if (status) return status
  }
  return undefined
}

/** Resolve a session's initialized directory from sessions, statuses, or messages. */
export function getSyncSessionDirectoryAnyDirectory(sessionId: string) {
  const stores = _childStores
  if (!stores) return undefined

  for (const [directory, store] of stores.children.entries()) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.hasOwn(state.session_status ?? {}, sessionId)
      || Object.hasOwn(state.message ?? {}, sessionId)
    ) {
      return directory
    }
  }
  return undefined
}

/** Read permissions for a session from current directory's child store */
export function getSyncPermissions(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.permission[sessionId] ?? []
}

/** Read questions for a session from current directory's child store */
export function getSyncQuestions(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.question[sessionId] ?? []
}

export function getSyncBlockingRequestCountAnyDirectory(sessionId: string) {
  const stores = _childStores
  if (!stores) return 0

  let count = 0
  for (const store of stores.children.values()) {
    const state = store.getState()
    count += state.permission?.[sessionId]?.length ?? 0
    count += state.question?.[sessionId]?.length ?? 0
  }
  return count
}
