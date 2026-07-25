/**
 * Session actions — SDK-calling operations for session management.
 * Replaces the action methods from the old useSessionStore.
 */

import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import { Binary } from "./binary"
import {
  getSessionComposerRevision,
  useInputStore,
  type RestoredAttachment,
} from "./input-store"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { opencodeClient } from "@/lib/opencode/client"
import {
  beginGlobalSessionMembershipMutation,
  queueGlobalSessionsRefreshAfterMutation,
  settleGlobalSessionMembershipMutation,
  useGlobalSessionsStore,
} from "@/stores/useGlobalSessionsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { getSessionUIStore, registerSessionDirectory } from "./sync-refs"
import { registerGitGenerationSession } from "@/lib/git/gitGenerationSessions"
import { isSyntheticPart } from "@/lib/messages/synthetic"
import { materializeSessionSnapshots } from "./materialization"
import { stripMessageDiffSnapshots } from "./sanitize"
import {
  updateSessionUserActivityFromMessage,
  updateSessionUserActivityFromMessages,
} from "./session-user-activity"
import { postTurnTimingMark, streamDebugMark } from "@/stores/utils/streamDebug"
import { markArchived, markUnarchived } from "./session-materializer"
import type { RevertTransaction } from "./revert-transactions"
import {
  beginCommittedRevertResend,
  endCommittedRevertResend,
} from "./revert-transactions"
import { hasMessageRecordInfo, unwrapMessageRecordsResult } from "./message-fetch"
import { isSessionWorkingFromState } from "./session-working"
import { isTransientError, retry } from "./retry"
import { useManagedOrchestrationStore } from "@/stores/useManagedOrchestrationStore"
import { createClientMessageId } from "./client-message-id"
import { useProviderRecoveryStore } from "@/stores/useProviderRecoveryStore"
import {
  clearAbortGuard,
  registerManualAbortGuard,
  setAbortGuardExecutor,
} from "./abort-retry-guard"
import { areSessionRecordsEqual, isStrictlyOlderSession } from "./session-recency"

const MESSAGE_REFETCH_LIMIT = 200
const MESSAGE_REFETCH_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const BULK_SESSION_MUTATION_CONCURRENCY = 6
const QUEUED_SEND_INTERRUPT_IDLE_WAIT_MS = 300
const QUEUED_SEND_INTERRUPT_IDLE_POLL_MS = 25
const SESSION_CREATE_RETRY_ATTEMPTS = 6
const SESSION_CREATE_RETRY_DELAY_MS = 250
const SESSION_CREATE_RETRY_MAX_DELAY_MS = 1000
let revertTransactionVersion = 0
type UnexpectedAbortReconcileOwner = {
  promise: Promise<void>
  token: symbol
}
const unexpectedAbortReconcileInFlight = new Map<string, UnexpectedAbortReconcileOwner>()
const failedRevertReconcileOwners = new Map<string, symbol>()

const unexpectedAbortReconcileKey = (directory: string | undefined, sessionId: string): string => (
  `${directory ?? ""}\0${sessionId}`
)

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted", "AbortError")
  }
  const error = new Error("Aborted")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

// Reference set by SyncProvider — allows actions to access SDK and stores
let _sdk: OpencodeClient | null = null
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""
let _optimisticAdd: ((input: { sessionID: string; message: Message; parts: Part[]; directory?: string | null }) => void) | null = null
let _optimisticRemove: ((input: { sessionID: string; messageID: string; directory?: string | null }) => void) | null = null

export function setActionRefs(
  sdk: OpencodeClient,
  childStores: ChildStoreManager,
  getDirectory: () => string,
) {
  _sdk = sdk
  _childStores = childStores
  _getDirectory = getDirectory
}

export function clearActionRefs(childStores: ChildStoreManager): boolean {
  if (_childStores !== childStores) return false
  _sdk = null
  _childStores = null
  _getDirectory = () => ""
  _optimisticAdd = null
  _optimisticRemove = null
  failedRevertReconcileOwners.clear()
  return true
}

export function releaseSessionActionDirectory(directory: string): void {
  if (!directory) return
  const prefix = `${directory}\0`
  for (const key of unexpectedAbortReconcileInFlight.keys()) {
    if (key.startsWith(prefix)) {
      unexpectedAbortReconcileInFlight.delete(key)
    }
  }
  for (const key of failedRevertReconcileOwners.keys()) {
    if (key.startsWith(prefix)) {
      failedRevertReconcileOwners.delete(key)
    }
  }
}

export function releaseSessionActionSession(directory: string, sessionId: string): void {
  if (!directory || !sessionId) return
  unexpectedAbortReconcileInFlight.delete(unexpectedAbortReconcileKey(directory, sessionId))
  failedRevertReconcileOwners.delete(unexpectedAbortReconcileKey(directory, sessionId))
}

export function setOptimisticRefs(
  add: (input: { sessionID: string; message: Message; parts: Part[]; directory?: string | null }) => void,
  remove: (input: { sessionID: string; messageID: string; directory?: string | null }) => void,
) {
  _optimisticAdd = add
  _optimisticRemove = remove
}

function sdk() {
  if (!_sdk) throw new Error("SDK not initialized — is SyncProvider mounted?")
  return _sdk
}

// Re-abort executor for the abort-retry guard: when a stopped session's
// server-side retry loop fires another attempt, the guard re-issues abort at
// the moment it can actually take effect (an in-flight request exists).
setAbortGuardExecutor(async (sessionId, directory) => {
  if (!_sdk) return
  const targetDirectory = directory || getSessionDirectory(sessionId)
  postAbortRequestedMark(sessionId, targetDirectory)
  await _sdk.session.abort({ sessionID: sessionId, directory: targetDirectory })
})

function directoryStore(directory?: string) {
  if (!_childStores) throw new Error("Child stores not initialized")
  const d = directory || _getDirectory()
  if (!d) throw new Error("No current directory")
  return _childStores.ensureChild(d)
}

function dir() {
  return _getDirectory() || undefined
}

function connectionLostError(): Error {
  const { hasEverConnected, lastDisconnectReason } = useConfigStore.getState()
  const suffix = lastDisconnectReason
    ? ` (${lastDisconnectReason})`
    : hasEverConnected
      ? ""
      : " (never connected)"
  return new Error(`Connection lost${suffix}. Please wait for reconnection.`)
}

// Wait briefly for the pipeline to re-establish connection before failing a
// send. Transient reconnects (heartbeat race, WS→SSE fallback, brief network
// blip) otherwise surface as a hard "Connection lost" toast even though the
// pipeline recovers within a second. While waiting, run bounded health probes
// inside the same grace window so stale disconnected state can recover quickly.
const CONNECTION_GRACE_MS = 2000
export async function waitForConnectionOrThrow(): Promise<void> {
  const deadline = Date.now() + CONNECTION_GRACE_MS
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(500, remainingMs) })) return
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
}

function getSessionDirectory(sessionId: string): string | undefined {
  return getSessionUIStore().getState().getDirectoryForSession(sessionId) || dir()
}

const mirrorSessionIntoDirectoryStore = (session: Session, directory: string | undefined): void => {
  if (!directory || !_childStores) return
  const store = _childStores.children.get(directory)
  if (!store) return

  store.setState((state) => {
    const result = Binary.search(state.session, session.id, (candidate) => candidate.id)
    if (result.found) {
      const current = state.session[result.index]
      if (isStrictlyOlderSession(session, current)) return state
      const merged = {
        ...current,
        ...session,
        time: { ...current.time, ...session.time },
      } as Session
      if (areSessionRecordsEqual(current, merged)) return state
      const next = [...state.session]
      next[result.index] = merged
      return { session: next }
    }

    const next = [...state.session]
    next.splice(result.index, 0, session)
    return {
      session: next,
      ...(!session.parentID ? { sessionTotal: state.sessionTotal + 1 } : {}),
    }
  })
}

function getSessionStatusForAction(sessionId: string, directoryOverride?: string) {
  try {
    return directoryStore(directoryOverride).getState().session_status[sessionId]
  } catch {
    return undefined
  }
}

function hasPendingSessionRevert(store: StoreApi<DirectoryStore>, sessionId: string): boolean {
  return store.getState().revert_transaction[sessionId]?.status === "pending"
}

export function assertSessionRevertMutationAllowed(
  sessionId: string,
  directoryOverride: string | undefined,
  mutation: "send" | "undo" | "redo",
): void {
  const store = directoryStore(directoryOverride)
  if (!hasPendingSessionRevert(store, sessionId)) return
  throw new Error(`Cannot ${mutation} while this chat is being reverted`)
}

async function waitForSessionIdleAfterQueuedInterrupt(sessionId: string, directoryOverride?: string): Promise<void> {
  const deadline = Date.now() + QUEUED_SEND_INTERRUPT_IDLE_WAIT_MS
  while (Date.now() < deadline) {
    const status = getSessionStatusForAction(sessionId, directoryOverride)
    if (!status || status.type === "idle") return

    const sleepMs = Math.min(QUEUED_SEND_INTERRUPT_IDLE_POLL_MS, Math.max(0, deadline - Date.now()))
    if (sleepMs <= 0) return
    await new Promise((resolve) => setTimeout(resolve, sleepMs))
  }
}

function getLatestAssistantMessageId(sessionId: string, directoryOverride?: string): string | undefined {
  try {
    const messages = directoryStore(directoryOverride).getState().message[sessionId] ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === "assistant" && typeof message.id === "string" && message.id.length > 0) {
        return message.id
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function getRestorableText(parts: Part[]): string {
  const textParts = parts.filter((part) => part.type === "text" && !isSyntheticPart(part))
  return textParts
    .map((part: Record<string, unknown>) => (part as { text?: string }).text || (part as { content?: string }).content || "")
    .join("\n")
    .trim()
}

function getRestorableFileAttachments(parts: Part[]): RestoredAttachment[] {
  const attachments: RestoredAttachment[] = []
  for (const part of parts) {
    if (part.type !== "file" || isSyntheticPart(part)) continue
    const record = part as Record<string, unknown>
    const url = typeof record.url === "string" ? record.url.trim() : ""
    const filename = typeof record.filename === "string" ? record.filename.trim() : ""
    if (!url || !filename) continue
    const mimeType = typeof record.mime === "string" && record.mime.trim()
      ? record.mime.trim()
      : "application/octet-stream"
    attachments.push({ url, mimeType, filename })
  }
  return attachments
}

function restoreUserMessageInput(parts: Part[], messageText: string): void {
  const attachments = getRestorableFileAttachments(parts)
  if (!messageText && attachments.length === 0) return

  const input = useInputStore.getState()
  input.clearAttachedFiles()
  for (const attachment of attachments) {
    input.addRestoredAttachment(attachment)
  }
  if (messageText) {
    input.setPendingInputText(messageText, "replace")
  }
}

function queueRevertedUserMessageInput(
  sessionId: string,
  parts: Part[],
  messageText: string,
  expectedComposerRevision: number,
): void {
  const attachments = getRestorableFileAttachments(parts)
  if (!messageText && attachments.length === 0) return
  useInputStore.getState().queueRestoredInput({
    sessionId,
    text: messageText,
    attachments,
    expectedComposerRevision,
  })
}

type AbortDisplayReason = "manual" | "steered"

function markSessionAbort(sessionId: string, reason: AbortDisplayReason, messageId?: string): void {
  getSessionUIStore().setState((state) => {
    const flags = new Map(state.sessionAbortFlags)
    const record: { timestamp: number; acknowledged: boolean; reason: AbortDisplayReason; id?: string } = {
      reason,
      timestamp: Date.now(),
      acknowledged: false,
    }
    if (messageId) {
      record.id = messageId
    }
    flags.set(sessionId, record)
    return { sessionAbortFlags: flags }
  })
}

function markManualAbort(sessionId: string, messageId?: string): void {
  markSessionAbort(sessionId, "manual", messageId)
}

function postAbortRequestedMark(sessionId: string, directory?: string): void {
  postTurnTimingMark({
    sessionId,
    assistantMessageId: getLatestAssistantMessageId(sessionId, directory),
    mark: "cursor_abort_requested",
    directory,
    metadata: { source: "user_abort" },
  })
}

type RevertCommitRollback = {
  sessionIndex: number
  previousRevert: Session["revert"] | undefined
  hadPreviousRevert: boolean
  previousTransaction: RevertTransaction | undefined
  committedMessageID?: string
}

function commitRevertBeforeNewSend(
  store: StoreApi<DirectoryStore>,
  sessionId: string,
): RevertCommitRollback | null {
  const state = store.getState()
  const sessionIndex = state.session.findIndex((session) => session.id === sessionId)
  const session = sessionIndex >= 0
    ? state.session[sessionIndex] as Session & { revert?: unknown }
    : undefined
  const hadPreviousRevert = Boolean(session && Object.prototype.hasOwnProperty.call(session, "revert"))
  const previousRevert = session?.revert
  const previousTransaction = state.revert_transaction[sessionId]

  if (!hadPreviousRevert && !previousTransaction) {
    return null
  }

  const patch: Partial<DirectoryStore> = {}
  if (sessionIndex >= 0 && hadPreviousRevert) {
    const sessions = [...state.session]
    const nextSession = { ...sessions[sessionIndex] } as Session & { revert?: unknown }
    delete nextSession.revert
    sessions[sessionIndex] = nextSession
    patch.session = sessions
  }

  if (previousTransaction) {
    const revertTransactions = { ...state.revert_transaction }
    delete revertTransactions[sessionId]
    patch.revert_transaction = revertTransactions
  }

  store.setState(patch)

  return {
    sessionIndex,
    previousRevert,
    hadPreviousRevert,
    previousTransaction,
    committedMessageID: previousTransaction?.messageID
      ?? (typeof previousRevert?.messageID === "string" ? previousRevert.messageID : undefined),
  }
}

function rollbackRevertCommit(
  store: StoreApi<DirectoryStore>,
  sessionId: string,
  rollback: RevertCommitRollback | null,
): void {
  if (!rollback) {
    return
  }

  const state = store.getState()
  const currentTransaction = state.revert_transaction[sessionId]
  if (currentTransaction && currentTransaction !== rollback.previousTransaction) {
    return
  }
  const patch: Partial<DirectoryStore> = {}
  if (rollback.sessionIndex >= 0 && state.session[rollback.sessionIndex]?.id === sessionId) {
    const sessions = [...state.session]
    const restored = { ...sessions[rollback.sessionIndex] } as Session & { revert?: unknown }
    if (rollback.hadPreviousRevert) {
      restored.revert = rollback.previousRevert
    } else {
      delete restored.revert
    }
    sessions[rollback.sessionIndex] = restored
    patch.session = sessions
  }

  const revertTransactions = { ...state.revert_transaction }
  if (rollback.previousTransaction) {
    revertTransactions[sessionId] = rollback.previousTransaction
  } else {
    delete revertTransactions[sessionId]
  }
  patch.revert_transaction = revertTransactions

  store.setState(patch)
}

type OptimisticSessionRemovalSnapshot = {
  directory: string
  session: Session[]
}

type OptimisticSessionUnarchiveEntry = {
  sessionId: string
  original: Session
  optimistic: Session
}

type OptimisticSessionUnarchiveSnapshot = {
  directory: string
  entries: OptimisticSessionUnarchiveEntry[]
}

type BulkMutationResult<K extends string> = Record<K, string[]> & { failedIds: string[] }
type SessionWithHierarchy = Session & {
  parentID?: string | null
  directory?: string | null
  project?: { worktree?: string | null } | null
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index])
    }
  })

  await Promise.all(workers)
  return results
}

const uniqueSessionIds = (sessionIds: Iterable<string>): string[] => {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const id of sessionIds) {
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function getSessionDirectoryFromSnapshot(session: Session): string | null {
  const snapshot = session as SessionWithHierarchy
  return snapshot.directory ?? snapshot.project?.worktree ?? null
}

function collectKnownSessionHierarchy(): {
  sessions: Session[]
  directoryById: Map<string, string>
} {
  const sessionsById = new Map<string, Session>()
  const directoryById = new Map<string, string>()

  const addSession = (session: Session, directory?: string | null) => {
    if (!sessionsById.has(session.id)) {
      sessionsById.set(session.id, session)
    }
    const snapshotDirectory = getSessionDirectoryFromSnapshot(session)
    const resolvedDirectory = directory ?? snapshotDirectory
    if (resolvedDirectory && !directoryById.has(session.id)) {
      directoryById.set(session.id, resolvedDirectory)
    }
  }

  if (_childStores) {
    for (const [directory, store] of _childStores.children) {
      for (const session of store.getState().session) {
        addSession(session, directory)
      }
    }
  }

  const globalState = useGlobalSessionsStore.getState()
  for (const session of globalState.activeSessions ?? []) {
    addSession(session)
  }
  for (const session of globalState.archivedSessions ?? []) {
    addSession(session)
  }

  return { sessions: Array.from(sessionsById.values()), directoryById }
}

export function getSessionIdsWithDescendants(sessionIds: string[]): string[] {
  const selectedIds = uniqueSessionIds(sessionIds)
  if (selectedIds.length === 0) {
    return []
  }

  // Keep the hierarchy lookup in the sync layer instead of the sidebar so all
  // session-switch paths share the same loaded-session source of truth.
  const { sessions } = collectKnownSessionHierarchy()
  const childrenByParentId = new Map<string, string[]>()
  for (const session of sessions) {
    const parentID = (session as SessionWithHierarchy).parentID
    if (!parentID) {
      continue
    }
    const children = childrenByParentId.get(parentID) ?? []
    children.push(session.id)
    childrenByParentId.set(parentID, children)
  }

  const expandedIds: string[] = []
  const seen = new Set<string>()
  const visiting = new Set<string>()
  const visit = (sessionId: string) => {
    if (seen.has(sessionId)) {
      return
    }
    expandedIds.push(sessionId)
    seen.add(sessionId)
    if (visiting.has(sessionId)) {
      return
    }
    visiting.add(sessionId)
    for (const childId of childrenByParentId.get(sessionId) ?? []) {
      visit(childId)
    }
    visiting.delete(sessionId)
  }

  for (const sessionId of selectedIds) {
    visit(sessionId)
  }

  return expandedIds
}

function expandSessionIdsWithDescendants(sessionIds: string[]): {
  ids: string[]
  directoryById: Map<string, string>
} {
  const ids = getSessionIdsWithDescendants(sessionIds)
  if (ids.length === 0) {
    return { ids: [], directoryById: new Map() }
  }

  const { directoryById } = collectKnownSessionHierarchy()
  return { ids, directoryById }
}

function getSessionDepths(sessionIds: Iterable<string>): Map<string, number> {
  const idSet = new Set(sessionIds)
  if (idSet.size === 0) {
    return new Map()
  }

  const { sessions } = collectKnownSessionHierarchy()
  const parentById = new Map<string, string>()
  for (const session of sessions) {
    const parentID = (session as SessionWithHierarchy).parentID
    if (parentID) {
      parentById.set(session.id, parentID)
    }
  }

  const depthById = new Map<string, number>()
  const resolveDepth = (sessionId: string, visiting: Set<string>): number => {
    const cached = depthById.get(sessionId)
    if (cached !== undefined) {
      return cached
    }
    if (visiting.has(sessionId)) {
      return 0
    }

    visiting.add(sessionId)
    const parentID = parentById.get(sessionId)
    const depth = parentID ? resolveDepth(parentID, visiting) + 1 : 0
    visiting.delete(sessionId)
    depthById.set(sessionId, depth)
    return depth
  }

  for (const sessionId of idSet) {
    resolveDepth(sessionId, new Set())
  }

  return depthById
}

function getKnownSessionSnapshots(sessionIds: Iterable<string>): Session[] {
  const idSet = new Set(sessionIds)
  if (idSet.size === 0) {
    return []
  }

  const { sessions } = collectKnownSessionHierarchy()
  const snapshots: Session[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (!idSet.has(session.id) || seen.has(session.id)) {
      continue
    }
    seen.add(session.id)
    snapshots.push(session)
  }
  return snapshots
}

function filterSnapshotsById(snapshots: Session[], ids: Iterable<string>): Session[] {
  const idSet = new Set(ids)
  if (idSet.size === 0) {
    return []
  }
  return snapshots.filter((session) => idSet.has(session.id))
}

function markSnapshotUnarchived(session: Session): Session {
  const time = { ...session.time }
  delete time.archived
  return { ...session, time }
}

function markSnapshotsUnarchived(snapshots: Session[]): Session[] {
  return snapshots.map(markSnapshotUnarchived)
}

function getSessionDirectoryForMutation(sessionId: string, knownDirectoryById?: Map<string, string>): string | undefined {
  return knownDirectoryById?.get(sessionId) ?? getSessionDirectory(sessionId)
}

function optimisticallyUnarchiveDirectorySessions(
  sessionIds: string[],
  knownDirectoryById: Map<string, string | undefined>,
): OptimisticSessionUnarchiveSnapshot[] {
  if (!_childStores || sessionIds.length === 0) {
    return []
  }

  const pendingIds = new Set(sessionIds)
  const idsByDirectory = new Map<string, Set<string>>()
  const snapshots: OptimisticSessionUnarchiveSnapshot[] = []

  for (const sessionId of sessionIds) {
    const directory = knownDirectoryById.get(sessionId)
    if (!directory) {
      continue
    }
    const ids = idsByDirectory.get(directory) ?? new Set<string>()
    ids.add(sessionId)
    idsByDirectory.set(directory, ids)
  }

  const unarchiveInDirectory = (directory: string, ids: Set<string>) => {
    const store = _childStores?.children.get(directory)
    if (!store || ids.size === 0) {
      return
    }

    const current = store.getState().session
    let next = current
    const entries: OptimisticSessionUnarchiveEntry[] = []

    for (let index = 0; index < current.length; index += 1) {
      const session = current[index]
      if (!ids.has(session.id)) {
        continue
      }

      pendingIds.delete(session.id)
      if (!session.time?.archived) {
        continue
      }

      if (next === current) {
        next = [...current]
      }
      const optimistic = markSnapshotUnarchived(session)
      next[index] = optimistic
      entries.push({ sessionId: session.id, original: session, optimistic })
    }

    if (next === current) {
      return
    }

    store.setState({ session: next })
    snapshots.push({ directory, entries })
  }

  for (const [directory, ids] of idsByDirectory) {
    unarchiveInDirectory(directory, ids)
  }

  if (pendingIds.size > 0) {
    for (const [directory, store] of _childStores.children) {
      const idsInDirectory = new Set<string>()
      for (const session of store.getState().session) {
        if (pendingIds.has(session.id)) {
          idsInDirectory.add(session.id)
        }
      }
      unarchiveInDirectory(directory, idsInDirectory)
      if (pendingIds.size === 0) {
        break
      }
    }
  }

  return snapshots
}

function restoreOptimisticallyUnarchivedDirectorySessions(
  snapshots: OptimisticSessionUnarchiveSnapshot[],
  sessionIds: Iterable<string>,
): void {
  if (!_childStores || snapshots.length === 0) {
    return
  }

  const ids = new Set(sessionIds)
  if (ids.size === 0) {
    return
  }

  for (const snapshot of snapshots) {
    const store = _childStores.children.get(snapshot.directory)
    if (!store) {
      continue
    }

    const current = store.getState().session
    let next = current
    for (const entry of snapshot.entries) {
      if (!ids.has(entry.sessionId)) {
        continue
      }
      const index = current.findIndex((session) => session.id === entry.sessionId)
      if (index < 0 || current[index] !== entry.optimistic) {
        continue
      }
      if (next === current) {
        next = [...current]
      }
      next[index] = entry.original
    }

    if (next !== current) {
      store.setState({ session: next })
    }
  }
}

const makeBulkResult = <K extends string>(successKey: K, successfulIds: string[], failedIds: string[]): BulkMutationResult<K> => {
  return {
    [successKey]: successfulIds,
    failedIds,
  } as BulkMutationResult<K>
}

function optimisticRemoveSessions(
  sessionIds: string[],
  knownDirectoryById?: Map<string, string>,
): OptimisticSessionRemovalSnapshot[] {
  if (!_childStores || sessionIds.length === 0) {
    return []
  }

  const pendingIds = new Set(sessionIds)
  const snapshots: OptimisticSessionRemovalSnapshot[] = []
  const idsByDirectory = new Map<string, Set<string>>()

  for (const sessionId of sessionIds) {
    const directory = getSessionDirectoryForMutation(sessionId, knownDirectoryById) || _getDirectory()
    if (!directory) {
      continue
    }
    const ids = idsByDirectory.get(directory) ?? new Set<string>()
    ids.add(sessionId)
    idsByDirectory.set(directory, ids)
  }

  const removeFromDirectory = (directory: string, ids: Set<string>) => {
    if (ids.size === 0) {
      return
    }
    const store = _childStores?.ensureChild(directory)
    if (!store) {
      return
    }
    const current = store.getState().session
    const next = current.filter((session) => !ids.has(session.id))
    if (next.length === current.length) {
      return
    }
    snapshots.push({ directory, session: current })
    for (const session of current) {
      if (ids.has(session.id)) {
        pendingIds.delete(session.id)
      }
    }
    store.setState({ session: next })
  }

  for (const [directory, ids] of idsByDirectory) {
    try {
      removeFromDirectory(directory, ids)
    } catch {
      // A child store can disappear during directory changes. Fall through to
      // the cross-store search below so rollback remains best-effort.
    }
  }

  if (pendingIds.size > 0) {
    for (const [directory, store] of _childStores.children.entries()) {
      const idsInDirectory = new Set<string>()
      const current = store.getState().session
      for (const session of current) {
        if (pendingIds.has(session.id)) {
          idsInDirectory.add(session.id)
        }
      }
      if (idsInDirectory.size === 0) {
        continue
      }
      removeFromDirectory(directory, idsInDirectory)
      if (pendingIds.size === 0) {
        break
      }
    }
  }

  return snapshots
}

function restoreOptimisticallyRemovedSessions(
  snapshots: OptimisticSessionRemovalSnapshot[],
  sessionIds: Iterable<string>,
) {
  if (!_childStores || snapshots.length === 0) {
    return
  }

  const ids = new Set(sessionIds)
  if (ids.size === 0) {
    return
  }

  for (const snapshot of snapshots) {
    const sessionsToRestore = snapshot.session.filter((session) => ids.has(session.id))
    if (sessionsToRestore.length === 0) {
      continue
    }

    try {
      const store = _childStores.ensureChild(snapshot.directory)
      const next = [...store.getState().session]
      let changed = false
      for (const session of sessionsToRestore) {
        const result = Binary.search(next, session.id, (candidate) => candidate.id)
        if (result.found) {
          continue
        }
        Binary.insert(next, session, (candidate) => candidate.id)
        changed = true
      }
      if (changed) {
        store.setState({ session: next })
      }
    } catch {
      // The directory store may have been disposed since the optimistic update.
      // Authoritative sync/global refresh will repair that state.
    }
  }
}

async function mutateSessionsInParallel(
  sessionIds: string[],
  mutate: (sessionId: string) => Promise<void>,
  logLabel: string,
): Promise<{ successfulIds: string[]; failedIds: string[] }> {
  const results = await runWithConcurrency(
    sessionIds,
    BULK_SESSION_MUTATION_CONCURRENCY,
    async (sessionId) => {
      try {
        await mutate(sessionId)
        return { sessionId, ok: true as const }
      } catch (error) {
        console.error(`[session-actions] ${logLabel} failed for ${sessionId}`, error)
        return { sessionId, ok: false as const }
      }
    },
  )

  const successfulIds: string[] = []
  const failedIds: string[] = []
  for (const result of results) {
    if (result.ok) {
      successfulIds.push(result.sessionId)
    } else {
      failedIds.push(result.sessionId)
    }
  }
  return { successfulIds, failedIds }
}

async function abortWorkingSessionsBeforeRemoval(
  sessionIds: string[],
  knownDirectoryById?: Map<string, string>,
): Promise<void> {
  if (!_childStores || sessionIds.length === 0) {
    return
  }

  const depthById = getSessionDepths(sessionIds)
  const idsByDepth = new Map<number, string[]>()
  for (const sessionId of sessionIds) {
    const depth = depthById.get(sessionId) ?? 0
    const ids = idsByDepth.get(depth) ?? []
    ids.push(sessionId)
    idsByDepth.set(depth, ids)
  }

  const depths = Array.from(idsByDepth.keys()).sort((a, b) => b - a)
  for (const depth of depths) {
    for (const sessionId of idsByDepth.get(depth) ?? []) {
      const directory = getSessionDirectoryForMutation(sessionId, knownDirectoryById)
      if (!directory) {
        continue
      }

      let store: StoreApi<DirectoryStore>
      try {
        store = directoryStore(directory)
      } catch {
        continue
      }

      const state = store.getState()
      const status = state.session_status[sessionId]
      const isWorking = isSessionWorkingFromState({
        status,
        permissions: state.permission[sessionId] ?? [],
        messages: state.message[sessionId] ?? [],
      })
      if (!isWorking) {
        continue
      }

      try {
        postAbortRequestedMark(sessionId, directory)
        registerManualAbortGuard(sessionId, directory, status)
        await sdk().session.abort({ sessionID: sessionId, directory })
        markManualAbort(sessionId, getLatestAssistantMessageId(sessionId, directory))
      } catch (error) {
        clearAbortGuard(sessionId)
        console.error(`[session-actions] abort before removal failed for ${sessionId}`, error)
      }
    }
  }
}

async function mutateSessionsInDepthOrder(
  sessionIds: string[],
  depthById: Map<string, number>,
  mutate: (sessionId: string) => Promise<void>,
  logLabel: string,
): Promise<{ successfulIds: string[]; failedIds: string[] }> {
  const idsByDepth = new Map<number, string[]>()
  for (const sessionId of sessionIds) {
    const depth = depthById.get(sessionId) ?? 0
    const ids = idsByDepth.get(depth) ?? []
    ids.push(sessionId)
    idsByDepth.set(depth, ids)
  }

  const successful = new Set<string>()
  const failed = new Set<string>()
  const depths = Array.from(idsByDepth.keys()).sort((a, b) => b - a)
  for (const depth of depths) {
    const idsAtDepth = idsByDepth.get(depth) ?? []
    const result = await mutateSessionsInParallel(idsAtDepth, mutate, logLabel)
    result.successfulIds.forEach((sessionId) => successful.add(sessionId))
    result.failedIds.forEach((sessionId) => failed.add(sessionId))
  }

  return {
    successfulIds: sessionIds.filter((sessionId) => successful.has(sessionId)),
    failedIds: sessionIds.filter((sessionId) => failed.has(sessionId)),
  }
}

function getSessionReplyClient(sessionId?: string): OpencodeClient {
  const directory = sessionId
    ? getSessionUIStore().getState().getDirectoryForSession(sessionId)
    : null
  if (directory) {
    return opencodeClient.getScopedSdkClient(directory)
  }
  return sdk()
}

function resolveDirectoryForBlockingRequest(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): string | null {
  const stores = _childStores
  if (!stores || !requestId) {
    return null
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    const requestMap = type === "permission" ? state.permission : state.question
    for (const requests of Object.values(requestMap) as Array<Array<{ id: string }> | undefined>) {
      if (requests?.some((request) => request.id === requestId)) {
        return directory
      }
    }
  }

  const sessionDirectory = getSessionUIStore().getState().getDirectoryForSession(sessionId)
  if (sessionDirectory) {
    return sessionDirectory
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

function getRequestReplyClient(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): OpencodeClient {
  const requestDirectory = resolveDirectoryForBlockingRequest(type, sessionId, requestId)
  if (requestDirectory) {
    return opencodeClient.getScopedSdkClient(requestDirectory)
  }
  return getSessionReplyClient(sessionId)
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

let lastCreateSessionError: unknown = null

export function consumeLastCreateSessionError(): unknown {
  const error = lastCreateSessionError
  lastCreateSessionError = null
  return error
}

type SessionCreatePayload = {
  directory?: string
  title?: string
  parentID?: string
}

type SessionCreateResult = {
  data?: Session | null
  error?: unknown
  response?: {
    status?: number
  }
}

function readErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }
  const candidate = error as {
    status?: unknown
    response?: { status?: unknown }
    cause?: { status?: unknown; response?: { status?: unknown } }
  }
  const status = candidate.status
    ?? candidate.response?.status
    ?? candidate.cause?.status
    ?? candidate.cause?.response?.status
  return typeof status === "number" ? status : undefined
}

function stringifyErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) {
      return message
    }
  }
  return String(error)
}

function createSessionCreateError(error: unknown, status?: number): Error {
  const message = stringifyErrorMessage(error)
  const formatted = new Error(status ? `session.create failed (${status}): ${message}` : `session.create failed: ${message}`)
  if (status !== undefined) {
    (formatted as Error & { status?: number }).status = status
  }
  return formatted
}

function isTransientSessionCreateError(error: unknown): boolean {
  const status = readErrorStatus(error)
  if (typeof status === "number" && status >= 500 && status < 600) {
    return true
  }
  const message = stringifyErrorMessage(error).toLowerCase()
  return message.includes("opencode is restarting") || isTransientError(error)
}

async function createSessionViaSdk(payload: SessionCreatePayload): Promise<Session> {
  const result = await sdk().session.create(payload) as SessionCreateResult
  if (result.error) {
    throw createSessionCreateError(result.error, result.response?.status ?? readErrorStatus(result.error))
  }
  if (!result.data) {
    throw createSessionCreateError("returned no data", result.response?.status)
  }
  return result.data
}

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  parentID?: string | null,
): Promise<Session | null> {
  const session = await createSessionRecord(title, directoryOverride, parentID)
  if (!session) return null

  const sessionDirectory = directoryOverride ?? (session as { directory?: string }).directory ?? null
  getSessionUIStore().getState().setCurrentSession(session.id, sessionDirectory)
  return session
}

export async function createSessionRecord(
  title?: string,
  directoryOverride?: string | null,
  parentID?: string | null,
  options?: { isGitGenerationSession?: boolean; isDraftPrewarmSession?: boolean },
): Promise<Session | null> {
  try {
    lastCreateSessionError = null
    const session = await retry(
      () => createSessionViaSdk({
        directory: directoryOverride ?? dir(),
        title,
        parentID: parentID ?? undefined,
      }),
      {
        attempts: SESSION_CREATE_RETRY_ATTEMPTS,
        delay: SESSION_CREATE_RETRY_DELAY_MS,
        maxDelay: SESSION_CREATE_RETRY_MAX_DELAY_MS,
        retryIf: isTransientSessionCreateError,
      },
    )

    const sessionDirectory = directoryOverride ?? (session as { directory?: string }).directory ?? null
    // Register hidden-session intent BEFORE upserting into the global store so
    // sidebar/list selectors that filter on `isGitGenerationSession` never see
    // the session even for a frame.
    const isHiddenCreatedSession = options?.isGitGenerationSession === true || options?.isDraftPrewarmSession === true
    if (options?.isGitGenerationSession) {
      registerGitGenerationSession(session.id)
      const removalDirectory = sessionDirectory ?? directoryOverride ?? dir()
      optimisticRemoveSessions(
        [session.id],
        removalDirectory ? new Map([[session.id, removalDirectory]]) : undefined,
      )
    }

    // Pre-populate routing index so SSE events arriving before session.created
    // can be routed to the correct child store.
    if (sessionDirectory) {
      registerSessionDirectory(session.id, sessionDirectory)
      getSessionUIStore().getState().setSessionDirectory(session.id, sessionDirectory)
    }
    getSessionUIStore().getState().markSessionAsOpenChamberCreated(session.id)
    if (!isHiddenCreatedSession) {
      useGlobalSessionsStore.getState().upsertSession(session)
    }
    return session
  } catch (error) {
    lastCreateSessionError = error
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function deleteSession(sessionId: string, _options?: Record<string, unknown>): Promise<boolean> {
  const result = await deleteSessions([sessionId])
  return result.deletedIds.includes(sessionId)
}

export async function deleteSessions(sessionIds: string[]): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  // Deletion cascades like archive/unarchive so parent deletes cannot leave
  // hidden child sessions behind, including when invoked from archived search.
  const { ids, directoryById: knownDirectoryById } = expandSessionIdsWithDescendants(sessionIds)
  if (ids.length === 0) {
    return { deletedIds: [], failedIds: [] }
  }

  if (!useConfigStore.getState().isConnected) {
    try {
      await waitForConnectionOrThrow()
    } catch {
      return { deletedIds: [], failedIds: ids }
    }
  }

  const directoryById = new Map(ids.map((sessionId) => [sessionId, getSessionDirectoryForMutation(sessionId, knownDirectoryById)]))
  const depthById = getSessionDepths(ids)
  const sessionSnapshots = getKnownSessionSnapshots(ids)
  await abortWorkingSessionsBeforeRemoval(ids, knownDirectoryById)
  const membershipMutation = beginGlobalSessionMembershipMutation({
    kind: "delete",
    sessionIds: ids,
  })
  const removalSnapshots = optimisticRemoveSessions(ids, knownDirectoryById)
  const ui = getSessionUIStore().getState()
  const previousCurrentSessionId = ui.currentSessionId
  const previousCurrentDirectory = previousCurrentSessionId ? directoryById.get(previousCurrentSessionId) : undefined
  if (previousCurrentSessionId && ids.includes(previousCurrentSessionId)) {
    ui.setCurrentSession(null)
  }

  const { successfulIds, failedIds } = await mutateSessionsInDepthOrder(
    ids,
    depthById,
    async (sessionId) => {
      await sdk().session.delete(
        { sessionID: sessionId, directory: directoryById.get(sessionId) },
        { throwOnError: true },
      )
    },
    "deleteSession",
  )

  settleGlobalSessionMembershipMutation(membershipMutation, { successfulIds, failedIds })
  restoreOptimisticallyRemovedSessions(removalSnapshots, failedIds)
  useGlobalSessionsStore.getState().restoreSessions(filterSnapshotsById(sessionSnapshots, failedIds))
  if (previousCurrentSessionId && failedIds.includes(previousCurrentSessionId)) {
    getSessionUIStore().getState().setCurrentSession(previousCurrentSessionId, previousCurrentDirectory ?? null)
  }
  if (successfulIds.length > 0) {
    void queueGlobalSessionsRefreshAfterMutation()
  }

  return makeBulkResult("deletedIds", successfulIds, failedIds)
}

/** Delete a session specifying which directory it lives in. Used by agent groups for cross-directory deletes. */
export async function deleteSessionInDirectory(sessionId: string, directory: string): Promise<boolean> {
  if (!_childStores) return false
  await abortWorkingSessionsBeforeRemoval([sessionId], new Map([[sessionId, directory]]))
  const sessionSnapshots = getKnownSessionSnapshots([sessionId])
  const membershipMutation = beginGlobalSessionMembershipMutation({
    kind: "delete",
    sessionIds: [sessionId],
  })
  const store = _childStores.ensureChild(directory)
  const current = store.getState()
  const sessions = [...current.session]
  const result = Binary.search(sessions, sessionId, (s) => s.id)
  let snapshot: Session[] | null = null
  if (result.found) {
    snapshot = current.session
    sessions.splice(result.index, 1)
    store.setState({ session: sessions })
  }
  const ui = getSessionUIStore().getState()
  if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
  try {
    await sdk().session.delete(
      { sessionID: sessionId, directory },
      { throwOnError: true },
    )
    settleGlobalSessionMembershipMutation(membershipMutation, {
      successfulIds: [sessionId],
      failedIds: [],
    })
    void queueGlobalSessionsRefreshAfterMutation()
    return true
  } catch (error) {
    console.error("[session-actions] deleteSessionInDirectory failed", error)
    settleGlobalSessionMembershipMutation(membershipMutation, {
      successfulIds: [],
      failedIds: [sessionId],
    })
    if (snapshot) {
      restoreOptimisticallyRemovedSessions([{ directory, session: snapshot }], [sessionId])
    }
    useGlobalSessionsStore.getState().restoreSessions(sessionSnapshots)
    return false
  }
}

export async function archiveSession(sessionId: string): Promise<boolean> {
  const result = await archiveSessions([sessionId])
  return result.archivedIds.includes(sessionId)
}

export async function archiveSessions(sessionIds: string[]): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  const { ids, directoryById: knownDirectoryById } = expandSessionIdsWithDescendants(sessionIds)
  if (ids.length === 0) {
    return { archivedIds: [], failedIds: [] }
  }

  if (!useConfigStore.getState().isConnected) {
    try {
      await waitForConnectionOrThrow()
    } catch {
      return { archivedIds: [], failedIds: ids }
    }
  }

  const archivedAt = Date.now()
  const directoryById = new Map(ids.map((sessionId) => [sessionId, getSessionDirectoryForMutation(sessionId, knownDirectoryById)]))
  const sessionSnapshots = getKnownSessionSnapshots(ids)
  await abortWorkingSessionsBeforeRemoval(ids, knownDirectoryById)
  const membershipMutation = beginGlobalSessionMembershipMutation({
    kind: "archive",
    sessionIds: ids,
    snapshots: sessionSnapshots,
    archivedAt,
  })
  const removalSnapshots = optimisticRemoveSessions(ids, knownDirectoryById)
  const ui = getSessionUIStore().getState()
  const previousCurrentSessionId = ui.currentSessionId
  const previousCurrentDirectory = previousCurrentSessionId ? directoryById.get(previousCurrentSessionId) : undefined
  if (previousCurrentSessionId && ids.includes(previousCurrentSessionId)) {
    ui.setCurrentSession(null)
  }

  const { successfulIds, failedIds } = await mutateSessionsInParallel(
    ids,
    async (sessionId) => {
      await sdk().session.update(
        { sessionID: sessionId, directory: directoryById.get(sessionId), time: { archived: archivedAt } },
        { throwOnError: true },
      )
    },
    "archiveSession",
  )

  settleGlobalSessionMembershipMutation(membershipMutation, { successfulIds, failedIds })
  if (successfulIds.length > 0) {
    for (const sessionId of successfulIds) {
      markArchived(sessionId, directoryById.get(sessionId))
    }
  }
  restoreOptimisticallyRemovedSessions(removalSnapshots, failedIds)
  useGlobalSessionsStore.getState().restoreSessions(filterSnapshotsById(sessionSnapshots, failedIds))
  if (previousCurrentSessionId && failedIds.includes(previousCurrentSessionId)) {
    getSessionUIStore().getState().setCurrentSession(previousCurrentSessionId, previousCurrentDirectory ?? null)
  }
  if (successfulIds.length > 0) {
    void queueGlobalSessionsRefreshAfterMutation()
  }

  return makeBulkResult("archivedIds", successfulIds, failedIds)
}

export async function unarchiveSession(sessionId: string): Promise<boolean> {
  const result = await unarchiveSessions([sessionId])
  return result.unarchivedIds.includes(sessionId)
}

export async function unarchiveSessions(sessionIds: string[]): Promise<{ unarchivedIds: string[]; failedIds: string[] }> {
  // Unarchive cascades for the same reason archive does: parent/child sessions
  // should return to the active sidebar as a coherent expandable hierarchy.
  const { ids, directoryById: knownDirectoryById } = expandSessionIdsWithDescendants(sessionIds)
  if (ids.length === 0) {
    return { unarchivedIds: [], failedIds: [] }
  }

  const directoryById = new Map(ids.map((sessionId) => [sessionId, getSessionDirectoryForMutation(sessionId, knownDirectoryById)]))
  const sessionSnapshots = getKnownSessionSnapshots(ids)
  const optimisticUnarchivedSnapshots = markSnapshotsUnarchived(sessionSnapshots)
  const optimisticIds = new Set(optimisticUnarchivedSnapshots.map((session) => session.id))
  const membershipMutation = beginGlobalSessionMembershipMutation({
    kind: "unarchive",
    sessionIds: ids,
    snapshots: sessionSnapshots,
  })
  const optimisticDirectorySnapshots = optimisticallyUnarchiveDirectorySessions(ids, directoryById)
  const { successfulIds, failedIds } = await mutateSessionsInParallel(
    ids,
    async (sessionId) => {
      await sdk().session.update(
        { sessionID: sessionId, directory: directoryById.get(sessionId), time: { archived: 0 } },
        { throwOnError: true },
      )
    },
    "unarchiveSession",
  )

  settleGlobalSessionMembershipMutation(membershipMutation, { successfulIds, failedIds })
  if (successfulIds.length > 0) {
    for (const sessionId of successfulIds) {
      markUnarchived(sessionId, directoryById.get(sessionId))
    }
  }
  if (failedIds.length > 0) {
    restoreOptimisticallyUnarchivedDirectorySessions(optimisticDirectorySnapshots, failedIds)
    const failedOptimisticIds = failedIds.filter((sessionId) => optimisticIds.has(sessionId))
    useGlobalSessionsStore.getState().removeSessions(failedOptimisticIds)
    useGlobalSessionsStore.getState().restoreSessions(filterSnapshotsById(sessionSnapshots, failedIds))
  }
  if (successfulIds.length > 0) {
    void queueGlobalSessionsRefreshAfterMutation()
  }

  return makeBulkResult("unarchivedIds", successfulIds, failedIds)
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.update({ sessionID: sessionId, directory: sessionDirectory, title })
  if (result.data) {
    mirrorSessionIntoDirectoryStore(result.data, sessionDirectory)
    useGlobalSessionsStore.getState().upsertSession(result.data)
  }
}

export async function shareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.share({ sessionID: sessionId, directory: sessionDirectory })
  if (result.data) {
    useGlobalSessionsStore.getState().upsertSession(result.data)
  }
  return result.data ?? null
}

export async function unshareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.unshare({ sessionID: sessionId, directory: sessionDirectory })
  if (result.data) {
    useGlobalSessionsStore.getState().upsertSession(result.data)
  }
  return result.data ?? null
}

// ---------------------------------------------------------------------------
// Optimistic message send — insert user message before API call, rollback on error
// ---------------------------------------------------------------------------

/**
 * Wraps an async send operation with optimistic user-message insertion.
 * Uses useSync()'s optimistic infrastructure — message + parts are inserted
 * into the store AND registered in the shadow Map. mergeOptimisticPage
 * handles deduplication when the server echoes back the real message.
 */
export async function optimisticSend(input: {
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  planMode?: boolean
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  directory?: string | null
  includeAssistantPlaceholder?: boolean
  /** The actual API call — receives the optimistic messageID so the server can use the same ID */
  send: (messageID: string) => Promise<void>
  onMessageID?: (messageID: string) => void
  onMessageRollback?: (messageID: string) => void
  signal?: AbortSignal
  preserveProviderRecovery?: boolean
  messageID?: string
}): Promise<void> {
  if (!_optimisticAdd || !_optimisticRemove) {
    throw new Error("Optimistic refs not set — is useSync() mounted?")
  }

  throwIfAborted(input.signal)
  await waitForConnectionOrThrow()
  throwIfAborted(input.signal)

  const messageDirectory = input.directory || getSessionUIStore().getState().getDirectoryForSession(input.sessionId) || dir()
  const storeForMessage = directoryStore(messageDirectory)
  assertSessionRevertMutationAllowed(input.sessionId, messageDirectory, "send")
  const messageID = input.messageID ?? createClientMessageId("msg")
  const textPartId = createClientMessageId("prt")

  const optimisticParts: Part[] = [
    { id: textPartId, type: "text", text: input.content } as Part,
  ]
  if (input.files) {
    for (const f of input.files) {
      optimisticParts.push({ id: createClientMessageId("prt"), type: "file", mime: f.mime, url: f.url, filename: f.filename } as Part)
    }
  }
  // Include the plan-mode synthetic instruction part so plan-card detection
  // ([isPlanModeUserMessage]) succeeds even if the recorded-plan-mode Set or
  // the optimistic `openchamberPlanMode` metadata don't survive (server may
  // not echo client-only metadata, persisted Set may be stale on reload).
  if (input.planMode === true) {
    optimisticParts.push({
      id: createClientMessageId("prt"),
      type: "text",
      text: "User has requested to enter plan mode.",
      synthetic: true,
    } as unknown as Part)
  }

  const optimisticMessage = {
    id: messageID,
    role: "user" as const,
    sessionID: input.sessionId,
    parentID: "",
    modelID: input.modelID,
    providerID: input.providerID,
    system: "",
    agent: input.agent ?? "",
    model: { providerID: input.providerID, modelID: input.modelID },
    metadata: input.planMode === true ? { openchamberPlanMode: true } as Record<string, unknown> : {} as Record<string, unknown>,
    time: { created: Date.now(), completed: 0 },
  } as unknown as Message
  const assistantPlaceholderID = `${messageID}_assistant`
  const optimisticAssistantMessage = input.includeAssistantPlaceholder === true
    ? {
        id: assistantPlaceholderID,
        role: "assistant" as const,
        sessionID: input.sessionId,
        parentID: messageID,
        modelID: input.modelID,
        providerID: input.providerID,
        system: "",
        agent: input.agent ?? "",
        model: { providerID: input.providerID, modelID: input.modelID },
        metadata: { optimisticAssistantPlaceholder: true } as Record<string, unknown>,
        time: { created: Date.now() + 1, completed: 0 },
      } as unknown as Message
    : null

  input.onMessageID?.(messageID)

  const revertRollback = commitRevertBeforeNewSend(storeForMessage, input.sessionId)
  beginCommittedRevertResend(input.sessionId, revertRollback?.committedMessageID)

  // Insert into store + register in shadow Map (for mergeOptimisticPage cleanup)
  _optimisticAdd({
    sessionID: input.sessionId,
    message: optimisticMessage,
    parts: optimisticParts,
    directory: messageDirectory,
  })
  if (optimisticAssistantMessage) {
    _optimisticAdd({
      sessionID: input.sessionId,
      message: optimisticAssistantMessage,
      parts: [],
      directory: messageDirectory,
    })
  }
  streamDebugMark("first-reply-optimistic-message-inserted", {
    sessionId: input.sessionId,
    messageID,
    directory: messageDirectory,
  })
  postTurnTimingMark({
    sessionId: input.sessionId,
    messageId: messageID,
    mark: "send_started",
    directory: messageDirectory,
    metadata: {
      providerID: input.providerID,
      modelID: input.modelID,
      agent: input.agent ?? null,
      planMode: input.planMode === true,
    },
  })

  // Decision: sidebar recency is updated optimistically only for root user
  // messages; helper filters subagent sessions so agent prompts do not reorder parents.
  storeForMessage.setState((state) => {
    const draft = { ...state, session_user_activity: state.session_user_activity }
    if (!updateSessionUserActivityFromMessage(draft, optimisticMessage)) return state
    return { session_user_activity: draft.session_user_activity }
  })

  // A new user-initiated turn supersedes any pending stop-during-retry guard —
  // its busy/retry statuses are authoritative again and must not be re-aborted.
  clearAbortGuard(input.sessionId)
  if (!input.preserveProviderRecovery) {
    useProviderRecoveryStore.getState().clearRecovery(input.sessionId)
  }

  // Set busy status
  const current = storeForMessage.getState()
  storeForMessage.setState({
    session_status: {
      ...current.session_status,
      [input.sessionId]: { type: "busy" as const },
    },
  })

  try {
    throwIfAborted(input.signal)
    await input.send(messageID)
  } catch (error) {
    // Rollback via optimistic infrastructure
    if (optimisticAssistantMessage) {
      _optimisticRemove({
        sessionID: input.sessionId,
        messageID: assistantPlaceholderID,
        directory: messageDirectory,
      })
    }
    _optimisticRemove({
      sessionID: input.sessionId,
      messageID,
      directory: messageDirectory,
    })
    input.onMessageRollback?.(messageID)
    rollbackRevertCommit(storeForMessage, input.sessionId, revertRollback)
    const s = storeForMessage.getState()
    storeForMessage.setState({
      session_status: {
        ...s.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
    })
    throw error
  } finally {
    endCommittedRevertResend(input.sessionId, revertRollback?.committedMessageID)
  }
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

async function cancelActiveManagedSubtasks(rootSessionId: string): Promise<void> {
  const state = useManagedOrchestrationStore.getState()
  const taskIds = state.taskIdsByRootId[rootSessionId] ?? []
  const activeTasks = taskIds
    .map((taskId) => state.tasksById[taskId])
    .filter((task) => task && (task.status === "queued" || task.status === "starting" || task.status === "running"))
  const activeTaskIds = new Set(activeTasks.map((task) => task.taskId))
  const cascadeRoots = activeTasks.filter((task) => !task.parentTaskId || !activeTaskIds.has(task.parentTaskId))

  const results = await Promise.allSettled(cascadeRoots.map((task) => state.cancelTask(task.taskId, {
    cascade: true,
    reason: "Parent session stopped",
  })))
  results.forEach((result) => {
    if (result.status === "rejected") {
      console.error("[session-actions] managed subtask cancellation failed", result.reason)
    }
  })
}

export async function abortCurrentOperationConfirmed(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  const status = getSessionStatusForAction(sessionId, sessionDirectory)
  getSessionUIStore().getState().abortPendingSend?.(sessionId)
  await cancelActiveManagedSubtasks(sessionId)
  try {
    postAbortRequestedMark(sessionId, sessionDirectory)
    registerManualAbortGuard(sessionId, sessionDirectory, status)
    const result = await sdk().session.abort(
      { sessionID: sessionId, directory: sessionDirectory },
      { throwOnError: true },
    )
    if (!result.data) {
      throw new Error("OpenCode did not confirm the session abort")
    }
    markManualAbort(sessionId, getLatestAssistantMessageId(sessionId, sessionDirectory))
    getSessionUIStore().getState().clearSessionTurnCompletion(sessionId)
    forceSessionIdleAfterManualAbort(sessionId, sessionDirectory)
    return true
  } catch (error) {
    // The stop never reached the server — do not mask live retry/busy state.
    clearAbortGuard(sessionId)
    console.error("[session-actions] abort failed", error)
    return false
  }
}

export async function abortCurrentOperation(sessionId: string): Promise<void> {
  await abortCurrentOperationConfirmed(sessionId)
}

/**
 * After a manual abort, OpenCode never emits an idle status while the session
 * sits in a provider retry loop (out of usage / rate limit) — abort during the
 * backoff sleep is ignored upstream. Optimistically settle a `retry` status to
 * idle so the UI unlocks; the abort-retry guard keeps stale `retry` statuses
 * from resurrecting it and cancels the loop server-side when the next attempt
 * fires. Plain `busy` aborts are left alone: the server confirms those with an
 * authoritative idle event.
 */
function forceSessionIdleAfterManualAbort(sessionId: string, directoryOverride?: string): void {
  let store: StoreApi<DirectoryStore>
  try {
    store = directoryStore(directoryOverride)
  } catch {
    return
  }

  store.setState((current) => {
    const status = current.session_status[sessionId]
    if (status?.type !== "retry") {
      return current
    }
    return {
      session_status: {
        ...current.session_status,
        [sessionId]: { type: "idle" as const },
      },
    }
  })
}

export async function interruptCurrentOperationForQueuedSend(sessionId: string): Promise<void> {
  await interruptCurrentOperationForSteeredSend(sessionId)
}

export async function interruptCurrentOperationForSteeredSend(sessionId: string): Promise<void> {
  if (!sessionId) return
  const sessionDirectory = getSessionDirectory(sessionId)
  const status = getSessionStatusForAction(sessionId, sessionDirectory)
  if (status?.type === "idle") return

  postAbortRequestedMark(sessionId, sessionDirectory)
  registerManualAbortGuard(sessionId, sessionDirectory, status)
  try {
    await sdk().session.abort({ sessionID: sessionId, directory: sessionDirectory })
  } catch (error) {
    // The interrupt never reached the server — do not mask live status.
    clearAbortGuard(sessionId)
    throw error
  }
  markSessionAbort(sessionId, "steered", getLatestAssistantMessageId(sessionId, sessionDirectory))
  forceSessionIdleAfterManualAbort(sessionId, sessionDirectory)
  await waitForSessionIdleAfterQueuedInterrupt(sessionId, sessionDirectory)
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  response: "once" | "always" | "reject",
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
    requestID: requestId,
    reply: response,
    ...(directory ? { directory } : {}),
  })
  if (!result.data) {
    throw new Error("Permission reply failed")
  }
}

export async function dismissPermission(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
    requestID: requestId,
    reply: "reject",
    ...(directory ? { directory } : {}),
  })
  if (!result.data) {
    throw new Error("Permission dismissal failed")
  }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function respondToQuestion(
  sessionId: string,
  requestId: string,
  answers: string[] | string[][],
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("question", sessionId, requestId).question.reply({
    requestID: requestId,
    answers: answers as Array<Array<string>>,
    ...(directory ? { directory } : {}),
  })
  if (!result.data) {
    throw new Error("Question reply failed")
  }
}

export async function rejectQuestion(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("question", sessionId, requestId).question.reject({
    requestID: requestId,
    ...(directory ? { directory } : {}),
  })
  if (!result.data) {
    throw new Error("Question rejection failed")
  }
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

/**
 * Revert to a specific user message.
 *
 * 1. Abort if session is busy
 * 2. Extract text from the target message for prompt restoration
 * 3. Optimistically set revert marker so messages hide immediately
 * 4. Call OpenChamber's scoped session revert and merge returned session
 * 5. Queue a session- and revision-owned composer restoration after acknowledgement
 */
export async function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  if (!messageId) {
    throw new Error("messageID is required")
  }

  const sessionDirectory = getSessionDirectory(sessionId)
  const store = directoryStore(sessionDirectory)
  const state = store.getState()

  const activeTransaction = state.revert_transaction[sessionId]
  if (activeTransaction && activeTransaction.status === "pending") {
    return
  }

  // Extract message text for prompt restoration (only non-synthetic text parts —
  // the server adds file content as synthetic text parts that should not be restored)
  const messages = state.message[sessionId] ?? []
  const targetMsg = messages.find((m) => m.id === messageId)
  const targetIndex = messages.findIndex((m) => m.id === messageId)
  if (targetIndex < 0) {
    throw new Error("Cannot revert: target message was not found")
  }
  let messageText = ""
  let targetParts: Part[] = []
  if (targetMsg && targetMsg.role === "user") {
    targetParts = state.part[messageId] ?? []
    messageText = getRestorableText(targetParts)
  }
  const expectedComposerRevision = getSessionComposerRevision(sessionId)

  // Optimistically remove reverted messages + set marker. The transaction is
  // committed before aborting any in-flight generation so abort-triggered SSE
  // cannot resurrect the suffix while the scoped revert request is pending.
  const prevRevert = (() => {
    const s = state.session.find((s) => s.id === sessionId)
    return (s as Session & { revert?: unknown })?.revert
  })()
  const prevTransaction = state.revert_transaction[sessionId]
  const sessions = [...state.session]
  const sessionIdx = sessions.findIndex((s) => s.id === sessionId)

  // Remove messages at and after the revert point from the store
  const prevMessages = state.message[sessionId] ?? []
  const prevPart = { ...state.part }
  const keptMessages = prevMessages.slice(0, targetIndex)
  const removedMessages = prevMessages.slice(targetIndex)
  const removedParts = Object.fromEntries(removedMessages.map((m) => [m.id, state.part[m.id] ?? []]))
  for (const m of removedMessages) {
    delete prevPart[m.id]
  }

  const transaction: RevertTransaction = {
    messageID: messageId,
    hiddenMessageIDs: new Set(removedMessages.map((message) => message.id)),
    version: ++revertTransactionVersion,
    status: "pending",
    startedAt: Date.now(),
  }

  const patch: Record<string, unknown> = {
    message: { ...state.message, [sessionId]: keptMessages },
    part: prevPart,
    revert_transaction: { ...state.revert_transaction, [sessionId]: transaction },
  }

  if (sessionIdx >= 0) {
    sessions[sessionIdx] = { ...sessions[sessionIdx], revert: { messageID: messageId } } as Session
    patch.session = sessions
  }

  store.setState(patch)
  store.setState((nextState) => {
    const draft = { ...nextState, session_user_activity: nextState.session_user_activity }
    if (!updateSessionUserActivityFromMessages(draft, sessionId)) return nextState
    return { session_user_activity: draft.session_user_activity }
  })

  // Abort if busy after the transaction marker is active.
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      registerManualAbortGuard(sessionId, sessionDirectory, status)
      await sdk().session.abort({ sessionID: sessionId, directory: sessionDirectory })
      store.setState((current) => {
        const currentTransaction = current.revert_transaction[sessionId]
        if (!currentTransaction || currentTransaction.version !== transaction.version) {
          return current
        }
        if (current.session_status[sessionId]?.type === "idle") {
          return current
        }
        return {
          session_status: {
            ...current.session_status,
            [sessionId]: { type: "idle" as const },
          },
        }
      })
    } catch {
      // ignore abort errors; scoped revert remains the authoritative operation.
      // The abort never reached the server, so stop masking live status.
      clearAbortGuard(sessionId)
    }
  }

  // Call SDK and merge authoritative result into store
  try {
    const result = await opencodeClient.revertSessionScoped(sessionId, messageId, sessionDirectory)
    if (result) {
      const current = store.getState()
      const currentTransaction = current.revert_transaction[sessionId]
      if (!currentTransaction || currentTransaction.version !== transaction.version) return
      const updated = [...current.session]
      const idx = updated.findIndex((s) => s.id === sessionId)
      const nextRevertTransactions = {
        ...current.revert_transaction,
        [sessionId]: { ...currentTransaction, status: "confirmed", serverAcknowledged: true } as RevertTransaction,
      }
      if (idx >= 0) {
        updated[idx] = result
        store.setState({
          session: updated,
          revert_transaction: nextRevertTransactions,
        })
      } else {
        store.setState({ revert_transaction: nextRevertTransactions })
      }
      // Restore reverted message text and non-synthetic file attachments only
      // after the safe scoped revert is acknowledged. If the server rejects the
      // revert, the visible messages and the user's existing draft stay aligned.
      queueRevertedUserMessageInput(sessionId, targetParts, messageText, expectedComposerRevision)
    }
  } catch (err) {
    // Rollback: restore removed messages + revert marker
    const current = store.getState()
    const currentTransaction = current.revert_transaction[sessionId]
    if (!currentTransaction || currentTransaction.version !== transaction.version) {
      throw err
    }
    const rollback = [...current.session]
    const idx = rollback.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      rollback[idx] = { ...rollback[idx], revert: prevRevert } as Session
    }
    const revertTransactions = { ...current.revert_transaction }
    if (prevTransaction) {
      revertTransactions[sessionId] = prevTransaction
    } else {
      delete revertTransactions[sessionId]
    }
    store.setState({
      session: rollback,
      revert_transaction: revertTransactions,
      message: { ...current.message, [sessionId]: prevMessages },
      part: { ...current.part, ...removedParts },
    })
    store.setState((nextState) => {
      const draft = { ...nextState, session_user_activity: nextState.session_user_activity }
      if (!updateSessionUserActivityFromMessages(draft, sessionId)) return nextState
      return { session_user_activity: draft.session_user_activity }
    })
    // The pending transaction intentionally suppresses suffix events. A second
    // client can add a message while even an initially idle revert is in
    // flight, so every failed revert launches a bounded authoritative refresh.
    // It is deliberately detached: rollback and the user-facing error must not
    // wait for a slow message fetch.
    scheduleFailedRevertReconciliation({
      sessionId,
      directory: sessionDirectory,
      expectedTransaction: prevTransaction,
      store,
    })
    throw err
  }
}

function scheduleFailedRevertReconciliation({
  sessionId,
  directory,
  expectedTransaction,
  store,
}: {
  sessionId: string
  directory?: string
  expectedTransaction: RevertTransaction | undefined
  store: StoreApi<DirectoryStore>
}): void {
  const key = unexpectedAbortReconcileKey(directory, sessionId)
  const token = Symbol(key)
  failedRevertReconcileOwners.set(key, token)

  void refetchSessionMessages(sessionId, directory, () => {
    if (failedRevertReconcileOwners.get(key) !== token) return false
    const currentTransaction = store.getState().revert_transaction[sessionId]
    return expectedTransaction
      ? currentTransaction?.version === expectedTransaction.version
      : currentTransaction === undefined
  }).catch(() => undefined).finally(() => {
    if (failedRevertReconcileOwners.get(key) === token) {
      failedRevertReconcileOwners.delete(key)
    }
  })
}

export async function refetchSessionMessages(
  sessionId: string,
  directoryOverride?: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const store = directoryStore(directoryOverride)
  const directory = directoryOverride || dir()
  const result = await sdk().session.messages({ sessionID: sessionId, directory, limit: MESSAGE_REFETCH_LIMIT })
  if (!isCurrent()) return
  const records = unwrapMessageRecordsResult(result).filter(hasMessageRecordInfo)
  if (records.length === 0) return

  store.setState((state) => {
    const materialized = materializeSessionSnapshots(
      state,
      sessionId,
      records.map((record) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
    )
    const draft = {
      ...state,
      message: materialized.message,
      part: materialized.part,
      session_user_activity: state.session_user_activity,
    }
    const activityChanged = updateSessionUserActivityFromMessages(draft, sessionId)
    return {
      ...(materialized.sessionsChanged && materialized.session ? { session: materialized.session } : {}),
      message: materialized.message,
      part: materialized.part,
      ...(activityChanged ? { session_user_activity: draft.session_user_activity } : {}),
    }
  })
}

export function reconcileUnexpectedAbort(sessionId: string, directoryOverride?: string): Promise<void> {
  const sessionDirectory = directoryOverride ?? getSessionDirectory(sessionId)
  const store = directoryStore(sessionDirectory)
  const state = store.getState()
  if (
    !state.session.some((session) => session.id === sessionId)
    && !Object.prototype.hasOwnProperty.call(state.message, sessionId)
  ) {
    return Promise.resolve()
  }

  const key = unexpectedAbortReconcileKey(sessionDirectory, sessionId)
  const existing = unexpectedAbortReconcileInFlight.get(key)
  if (existing) return existing.promise

  const token = Symbol(key)
  const promise = refetchSessionMessages(
    sessionId,
    sessionDirectory,
    () => unexpectedAbortReconcileInFlight.get(key)?.token === token,
  ).finally(() => {
    if (unexpectedAbortReconcileInFlight.get(key)?.token === token) {
      unexpectedAbortReconcileInFlight.delete(key)
    }
  })
  unexpectedAbortReconcileInFlight.set(key, { promise, token })
  return promise
}

/**
 * Unrevert — restore all previously reverted messages.
 * Restore all previously reverted messages. Aborts if busy, merges result.
 */
export async function unrevertSession(sessionId: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const store = directoryStore(sessionDirectory)
  const state = store.getState()

  assertSessionRevertMutationAllowed(sessionId, sessionDirectory, "redo")

  // Abort if busy
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      registerManualAbortGuard(sessionId, sessionDirectory, status)
      await sdk().session.abort({ sessionID: sessionId, directory: sessionDirectory })
    } catch {
      // ignore abort errors; the abort never reached the server, so stop
      // masking live status.
      clearAbortGuard(sessionId)
    }
  }

  const result = await sdk().session.unrevert({ sessionID: sessionId, directory: sessionDirectory })
  if (result.data) {
    const current = store.getState()
    const sessions = [...current.session]
    const revertTransactions = { ...current.revert_transaction }
    delete revertTransactions[sessionId]
    const idx = sessions.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      sessions[idx] = result.data
      store.setState({ session: sessions, revert_transaction: revertTransactions })
    } else {
      store.setState({ revert_transaction: revertTransactions })
    }
  }
  await refetchSessionMessages(sessionId, sessionDirectory)
}

/**
 * Fork from a user message.
 *
 * 1. Extract text from the message for input restoration
 * 2. Call SDK session.fork()
 * 3. Insert the new session into the child store (so sidebar updates immediately)
 * 4. Switch to new session and set pending input text
 */
export async function forkFromMessage(sessionId: string, messageId: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const store = directoryStore(sessionDirectory)
  const state = store.getState()

  // Extract message text for input restoration (only non-synthetic text parts —
  // the server adds file content as synthetic text parts that should not be restored)
  const parts = state.part[messageId] ?? []
  const sourceMessage = (state.message[sessionId] ?? []).find((message) => message.id === messageId)
  const shouldRestoreInput = sourceMessage?.role !== "assistant"
  const messageText = shouldRestoreInput ? getRestorableText(parts) : ""

  const result = await sdk().session.fork({ sessionID: sessionId, directory: sessionDirectory, messageID: messageId })
  if (!result.data) return

  const forkedSession = result.data

  // Insert new session into child store so sidebar updates immediately
  const current = store.getState()
  const sessions = [...current.session]
  const searchResult = Binary.search(sessions, forkedSession.id, (s) => s.id)
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, forkedSession)
    store.setState({ session: sessions })
  }

  // Switch to new session
  getSessionUIStore().getState().setCurrentSession(forkedSession.id)

  // Restore forked message text and non-synthetic file attachments to input.
  if (shouldRestoreInput) {
    restoreUserMessageInput(parts, messageText)
  }
}
