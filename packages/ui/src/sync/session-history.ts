import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import type { SessionMessageLoader, SessionMessageTarget } from "./session-message-loader"
import { Binary } from "./binary"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT } from "./types"
import { dropSessionCaches, getProtectedSessionCacheIds, pickSessionCacheEvictions } from "./session-cache"
import { unwrapSdkResult } from "./sdk-result"
import {
  normalizeChatOwnedDiffSummary,
  stripUntrustedSessionDiffSummary,
  type SessionSummaryDiffStats,
} from "@/lib/sessionDiffStats"
import { getBackgroundTrimLimit } from "@/stores/types/sessionTypes"
import { markSessionNavigationLoaderStarted, startSessionLoadPerformanceEvent } from "./session-load-performance"
import { mergeSessionPreservingMeaningfulTitle } from "@/lib/sessionTitles"

// Debounce for the background-session message trim so rapid session flips
// don't thrash trim/reload cycles.
const BACKGROUND_TRIM_DEBOUNCE_MS = 5_000
const MAX_SEEN_DIRS = 30
export const ARCHIVED_OFFLOAD_TTL_MS = 20 * 60 * 1000

export type SessionMaterializationLevel = "unmaterialized" | "hydrating" | "firstPageLoaded" | "summaryOnly" | "error"

export type SessionMaterializationState = {
  level: SessionMaterializationLevel
  archived: boolean
  updatedAt: number
  error?: string
}

export type SessionHistoryEnsureOptions = {
  force?: boolean
  reason?: "selected" | "reactive" | "force"
}

const keyFor = (target: SessionMessageTarget) => `${target.directory}\n${target.sessionID}`

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

const deletePrefixed = <T>(map: Map<string, T>, prefix: string, onDelete?: (value: T) => void) => {
  for (const [key, value] of map) {
    if (!key.startsWith(prefix)) continue
    onDelete?.(value)
    map.delete(key)
  }
}

/**
 * Provider-owned session history: metadata hydration, cache LRU, background
 * trim, archived offload and materialization state for every managed
 * directory, keyed by exact `(directory, session ID)`. `SyncProvider` creates
 * one; `useSync()` consumers and sidebar rows hold no history state of their
 * own. Cleanup, timers and late responses only read existing child stores;
 * only explicit loads may create a passive store.
 */
export class SessionHistory {
  private readonly seen = new Map<string, Set<string>>()
  // The in-flight entry is the metadata publication fence: offloading or
  // retiring the session, or releasing its directory, removes it, so a late
  // `session.get` response cannot republish.
  private readonly metadataInflight = new Map<string, Promise<void>>()
  private readonly trimTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly materialization = new Map<string, SessionMaterializationState>()
  private readonly archivedOffloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(private readonly options: {
    childStores: ChildStoreManager
    loader: SessionMessageLoader
    getSdk: (directory: string) => OpencodeClient
  }) {}

  activate(): void {
    this.disposed = false
  }

  // Selected-session hydration. Metadata and messages are independent and
  // start together; the message loader is shared by every caller.
  async ensureRenderable(target: SessionMessageTarget, options: SessionHistoryEnsureOptions = {}): Promise<boolean> {
    const { directory, sessionID } = target
    if (!directory || !sessionID || this.disposed) return false
    const force = options.force === true
    const reason = options.reason ?? (force ? "force" : "reactive")
    if (reason === "selected") markSessionNavigationLoaderStarted(sessionID, directory)
    const store = this.options.childStores.ensureChild(directory, { bootstrap: false })
    this.touch(target, store)
    this.scheduleBackgroundTrim(directory)

    const hasSession = Binary.search(store.getState().session, sessionID, (session) => session.id).found
    let metadata = this.metadataInflight.get(keyFor(target))
    if ((!hasSession || force) && !metadata) metadata = this.startMetadata(target, store, reason)

    await Promise.all([
      metadata ?? Promise.resolve(),
      this.options.loader.ensure(target, { force, reason }),
    ])
    return this.options.loader.getSnapshot(target).status !== "error"
  }

  async loadMore(target: SessionMessageTarget): Promise<void> {
    if (!target.directory || !target.sessionID || this.disposed) return
    const store = this.options.childStores.ensureChild(target.directory, { bootstrap: false })
    this.touch(target, store)
    this.scheduleBackgroundTrim(target.directory)
    if (!this.options.loader.getSnapshot(target).resolved) {
      await this.ensureRenderable(target, { force: true, reason: "force" })
      return
    }
    await this.options.loader.loadOlder(target)
  }

  hasMore(target: SessionMessageTarget): boolean {
    const state = this.options.loader.getSnapshot(target)
    return !state.complete && Boolean(state.cursor)
  }

  isLoading(target: SessionMessageTarget): boolean {
    return this.options.loader.getSnapshot(target).status === "loading"
  }

  hasPaginationMetadata(target: SessionMessageTarget): boolean {
    return this.options.loader.getSnapshot(target).resolved
  }

  async prefetch(target: SessionMessageTarget): Promise<void> {
    if (!target.directory || !target.sessionID || this.disposed) return
    await this.options.loader.prefetch(target)
    const store = this.options.childStores.getChild(target.directory)
    if (store && this.options.loader.getSnapshot(target).status === "ready") {
      this.touch(target, store)
      this.scheduleBackgroundTrim(target.directory)
    }
  }

  optimisticAdd(input: SessionMessageTarget & { message: Message; parts: Part[] }): void {
    this.options.loader.optimisticAdd(input)
  }

  optimisticRemove(input: SessionMessageTarget & { messageID: string }): void {
    this.options.loader.optimisticRemove(input)
  }

  /** Drops the transcript caches and fences pending loads; the session summary stays. */
  offloadHistory(target: SessionMessageTarget): void {
    this.evict(target.directory, [target.sessionID])
  }

  /** Forgets a permanently deleted session; its store membership is removed by the caller. */
  retireSession(target: SessionMessageTarget): void {
    if (!target.directory || !target.sessionID) return
    const key = keyFor(target)
    this.metadataInflight.delete(key)
    this.seen.get(target.directory)?.delete(target.sessionID)
    this.materialization.delete(key)
    this.cancelArchivedOffload(target)
  }

  getMaterializationState(target: SessionMessageTarget): SessionMaterializationState {
    return this.materialization.get(keyFor(target)) ?? nowState("unmaterialized", false)
  }

  async ensureFirstPage(target: SessionMessageTarget, options?: { force?: boolean }): Promise<void> {
    if (!target.directory || !target.sessionID || this.disposed) return
    const store = this.options.childStores.ensureChild(target.directory, { bootstrap: false })
    const isCurrent = () => !this.disposed && this.options.childStores.getChild(target.directory) === store
    this.setMaterializationState(target, nowState("hydrating", this.getMaterializationState(target).archived))
    let ok = false
    try {
      ok = await this.ensureRenderable(target, { force: Boolean(options?.force) })
    } catch (error) {
      if (isCurrent()) this.setMaterializationState(target, nowState("error", this.getMaterializationState(target).archived,
        error instanceof Error ? error.message : "Session materialization failed"))
      throw error
    }
    if (!isCurrent()) return
    const archived = this.getMaterializationState(target).archived
    if (!ok) {
      const message = `Failed to materialize session ${target.sessionID}`
      this.setMaterializationState(target, nowState("error", archived, message))
      throw new Error(message)
    }
    this.setMaterializationState(target, nowState("firstPageLoaded", archived))
  }

  markArchived(target: SessionMessageTarget): void {
    if (!target.sessionID || !this.options.childStores.getChild(target.directory)) return
    const current = this.getMaterializationState(target)
    this.setMaterializationState(target, nowState(current.level, true, current.error))
    this.scheduleArchivedOffload(target)
  }

  markUnarchived(target: SessionMessageTarget): void {
    if (!target.sessionID) return
    this.cancelArchivedOffload(target)
    if (!this.options.childStores.getChild(target.directory)) return
    const current = this.getMaterializationState(target)
    this.setMaterializationState(target, nowState(current.level === "summaryOnly" ? "unmaterialized" : current.level, false, current.error))
    void this.ensureFirstPage(target).catch(() => undefined)
  }

  offloadArchivedSessionNow(target: SessionMessageTarget): void {
    this.cancelArchivedOffload(target)
    this.offloadHistory(target)
    if (this.options.childStores.getChild(target.directory)) {
      this.setMaterializationState(target, nowState("summaryOnly", true))
    }
  }

  cancelArchivedOffload(target: SessionMessageTarget): void {
    const key = keyFor(target)
    const timer = this.archivedOffloadTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    this.archivedOffloadTimers.delete(key)
  }

  releaseDirectory(directory: string): void {
    if (!directory) return
    const prefix = `${directory}\n`
    deletePrefixed(this.metadataInflight, prefix)
    deletePrefixed(this.materialization, prefix)
    deletePrefixed(this.archivedOffloadTimers, prefix, clearTimeout)
    this.seen.delete(directory)
    const trim = this.trimTimers.get(directory)
    if (trim) clearTimeout(trim)
    this.trimTimers.delete(directory)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.trimTimers.values()) clearTimeout(timer)
    for (const timer of this.archivedOffloadTimers.values()) clearTimeout(timer)
    this.trimTimers.clear()
    this.archivedOffloadTimers.clear()
    this.metadataInflight.clear()
    this.materialization.clear()
    this.seen.clear()
  }

  getRetainedCountsForTest(directory: string) {
    const prefix = `${directory}\n`
    const count = (map: Map<string, unknown>) => [...map.keys()].filter((key) => key.startsWith(prefix)).length
    return {
      seen: this.seen.get(directory)?.size ?? 0,
      metadata: count(this.metadataInflight),
      states: count(this.materialization),
      timers: count(this.archivedOffloadTimers) + (this.trimTimers.has(directory) ? 1 : 0),
    }
  }

  private setMaterializationState(target: SessionMessageTarget, state: SessionMaterializationState): void {
    this.materialization.set(keyFor(target), state)
  }

  private scheduleArchivedOffload(target: SessionMessageTarget): void {
    const store = this.options.childStores.getChild(target.directory)
    if (!store) return
    this.cancelArchivedOffload(target)
    const key = keyFor(target)
    const timer = setTimeout(() => {
      if (this.archivedOffloadTimers.get(key) !== timer) return
      this.archivedOffloadTimers.delete(key)
      if (this.disposed || this.options.childStores.getChild(target.directory) !== store) return
      this.offloadHistory(target)
      this.setMaterializationState(target, nowState("summaryOnly", true))
    }, ARCHIVED_OFFLOAD_TTL_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.archivedOffloadTimers.set(key, timer)
  }

  private startMetadata(
    target: SessionMessageTarget,
    store: StoreApi<DirectoryStore>,
    reason: "selected" | "reactive" | "force",
  ): Promise<void> {
    const key = keyFor(target)
    const finishMetadata = startSessionLoadPerformanceEvent({ operation: "session.metadata", caller: reason })
    const sdk = this.options.getSdk(target.directory)
    const promise: Promise<void> = retry(() =>
      sdk.session.get({ sessionID: target.sessionID }).then((response) => unwrapSdkResult(response, "session.get")),
    ).then((result) => {
      if (
        this.disposed
        || this.metadataInflight.get(key) !== promise
        || this.options.childStores.getChild(target.directory) !== store
        || !result
      ) {
        finishMetadata("stale")
        return
      }
      const state = store.getState()
      const sessions = [...state.session]
      const idx = Binary.search(sessions, target.sessionID, (session) => session.id)
      const cachedMessages = state.message[target.sessionID]
      const normalized = cachedMessages
        ? normalizeChatOwnedDiffSummary(
          result as Session & { summary?: SessionSummaryDiffStats | null },
          cachedMessages as Array<Message & { summary?: SessionSummaryDiffStats | null }>,
        ) as Session
        : stripUntrustedSessionDiffSummary(
          result as Session & { summary?: SessionSummaryDiffStats | null },
        ) as Session
      if (idx.found) sessions[idx.index] = mergeSessionPreservingMeaningfulTitle(sessions[idx.index], normalized)
      else sessions.splice(idx.index, 0, normalized)
      store.setState({ session: sessions })
      finishMetadata("complete")
    }).catch((error) => {
      finishMetadata("error")
      console.error("[sync] failed to fetch session", target.sessionID, error)
    }).finally(() => {
      if (this.metadataInflight.get(key) === promise) this.metadataInflight.delete(key)
    })
    this.metadataInflight.set(key, promise)
    return promise
  }

  // Session cache eviction — two levels of LRU:
  // (1) across directories (MAX_SEEN_DIRS), (2) within a directory (SESSION_CACHE_LIMIT).
  private touch(target: SessionMessageTarget, store: StoreApi<DirectoryStore>): void {
    this.options.childStores.historyBudget.touch(target.directory, target.sessionID)
    const stale = pickSessionCacheEvictions({
      seen: this.seenFor(target.directory),
      keep: target.sessionID,
      limit: SESSION_CACHE_LIMIT,
      preserve: getProtectedSessionCacheIds(store.getState()),
    })
    this.evict(target.directory, stale)
  }

  // LRU reorder on access. Evicts the oldest directory's caches past MAX_SEEN_DIRS.
  private seenFor(directory: string): Set<string> {
    const existing = this.seen.get(directory)
    if (existing) {
      this.seen.delete(directory)
      this.seen.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    this.seen.set(directory, created)
    while (this.seen.size > MAX_SEEN_DIRS) {
      const first = this.seen.keys().next().value
      if (!first) break
      const staleSessionIds = [...(this.seen.get(first) ?? [])]
      this.seen.delete(first)
      this.evict(first, staleSessionIds)
    }
    return created
  }

  // Drops cached transcripts from an existing store only; never creates one.
  private evict(directory: string, sessionIDs: string[]): void {
    if (!directory || sessionIDs.length === 0) return
    for (const sessionID of sessionIDs) this.metadataInflight.delete(keyFor({ directory, sessionID }))
    const store = this.options.childStores.getChild(directory)
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
      dropSessionCaches(draft, sessionIDs)
      for (const id of sessionIDs) delete draft.revert_transaction[id]
      store.setState(draft)
    }
    for (const sessionID of sessionIDs) this.options.loader.invalidateSession({ directory, sessionID })
  }

  // Background-session message trim — the limit MemoryDebugPanel advertises.
  // Debounced after every touch: sessions other than the current one keep at
  // most getBackgroundTrimLimit() newest messages in memory. Trimmed sessions
  // reset pagination (complete: false, no cursor) so Load More rehydrates
  // older history on demand. Never trims the current session, protected
  // sessions, sessions with optimistic entries, or sessions with a load in flight.
  private scheduleBackgroundTrim(directory: string): void {
    const existing = this.trimTimers.get(directory)
    if (existing) clearTimeout(existing)
    this.trimTimers.set(directory, setTimeout(() => {
      this.trimTimers.delete(directory)
      if (this.disposed) return
      void this.runBackgroundTrim(directory).catch(() => {})
    }, BACKGROUND_TRIM_DEBOUNCE_MS))
  }

  private async runBackgroundTrim(directory: string): Promise<void> {
    const store = this.options.childStores.getChild(directory)
    if (!store) return
    const { useSessionUIStore } = await import("./session-ui-store")
    if (this.disposed || this.options.childStores.getChild(directory) !== store) return
    const currentSessionId = useSessionUIStore.getState().currentSessionId
    const state = store.getState()
    const protectedIds = getProtectedSessionCacheIds(state)
    const trimLimit = getBackgroundTrimLimit()
    const loader = this.options.loader
    let message = state.message
    let part = state.part
    let changed = false
    for (const sessionID of Object.keys(state.message)) {
      if (sessionID === currentSessionId) continue
      if (protectedIds.has(sessionID)) continue
      if (loader.hasOptimistic({ directory, sessionID })) continue
      if (loader.getSnapshot({ directory, sessionID }).status === "loading") continue
      const messages = message[sessionID]
      if (!messages || messages.length <= trimLimit) continue
      const removed = messages.slice(0, messages.length - trimLimit)
      const kept = messages.slice(messages.length - trimLimit)
      if (!changed) {
        message = { ...message }
        part = { ...part }
        changed = true
      }
      message[sessionID] = kept
      for (const msg of removed) {
        if (msg?.id) delete part[msg.id]
      }
      loader.invalidateSession({ directory, sessionID })
    }
    if (changed) store.setState({ message, part })
  }
}
