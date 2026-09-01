import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { opencodeClient } from "@/lib/opencode/client"
import { isVSCodeRuntime } from "@/lib/desktop"
import { useFeatureFlagsStore } from "@/stores/useFeatureFlagsStore"
import { streamPerfObserve } from "@/stores/utils/streamDebug"
import { reconcileSessionChangeAttribution } from "@/stores/useSessionChangeAttributionStore"
import { DEFAULT_MESSAGE_LIMIT } from "@/stores/types/sessionTypes"
import { retry } from "./retry"
import { stripMessageDiffSnapshots } from "./sanitize"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { mergeOptimisticPage, type OptimisticItem } from "./optimistic"
import { insertMessageChronologically, sortMessagesChronologically } from "./message-order"
import { hasMessageRecordInfo, normalizeMessageFetchLimit, unwrapMessageRecordsResult } from "./message-fetch"
import { updateSessionUserActivityFromMessages } from "./session-user-activity"
import { clearSessionPrefetch, getSessionPrefetch, setSessionPrefetch } from "./session-prefetch-cache"
import { clearSessionMessagePagination, setSessionMessagePagination } from "./message-pagination-store"
import { startSessionLoadPerformanceEvent } from "./session-load-performance"
import { dropSessionCaches } from "./session-cache"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const FAST_INITIAL_PAGE_SIZE = 50
const VSCODE_INITIAL_PAGE_SIZE = 30
const FAST_EXPANSION_LIMITS = [100, 150] as const
const VSCODE_EXPANSION_LIMITS = [50, 80, 120] as const
const TAIL_REFRESH_LIMIT = 30
const FRESHNESS_TTL_MS = 15_000

export type SessionMessageLoadKind = "initial" | "older" | "refresh" | "prefetch"
export type SessionMessageLoadStatus = "idle" | "loading" | "ready" | "error"

export type SessionMessageLoadState = {
  status: SessionMessageLoadStatus
  loadingKind: SessionMessageLoadKind | null
  error: Error | null
  resolved: boolean
  limit: number
  cursor: string | undefined
  complete: boolean
  generation: number
  updatedAt: number | undefined
}

export type SessionMessageTarget = {
  directory: string
  sessionID: string
}

type LoaderEntry = {
  snapshot: SessionMessageLoadState
  listeners: Set<() => void>
  inflight: Promise<void> | null
  queuedRefresh: Promise<void> | null
  optimistic: Map<string, OptimisticItem>
}

type FetchedPage = {
  session: Message[]
  partsByMessageID: Map<string, Part[]>
  cursor: string | undefined
  complete: boolean
}

const normalizeDirectory = (directory: string): string => {
  const normalized = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized || "/"
}

const isUserMessage = (message: Message): boolean => {
  const candidate = message as Message & { clientRole?: unknown; role?: unknown }
  return (typeof candidate.clientRole === "string" ? candidate.clientRole : candidate.role) === "user"
}

const createDefaultState = (): SessionMessageLoadState => ({
  status: "idle",
  loadingKind: null,
  error: null,
  resolved: false,
  limit: getInitialPageSize(),
  cursor: undefined,
  complete: false,
  generation: 0,
  updatedAt: undefined,
})

const getInitialPageSize = (): number => {
  if (!useFeatureFlagsStore.getState().sessionFastLoadEnabled) return DEFAULT_MESSAGE_LIMIT
  return isVSCodeRuntime() ? VSCODE_INITIAL_PAGE_SIZE : FAST_INITIAL_PAGE_SIZE
}

const getExpansionLimits = (): readonly number[] => (
  isVSCodeRuntime() ? VSCODE_EXPANSION_LIMITS : FAST_EXPANSION_LIMITS
)

export const EMPTY_SESSION_MESSAGE_LOAD_STATE: SessionMessageLoadState = Object.freeze(createDefaultState())

export class SessionMessageLoader {
  private readonly entries = new Map<string, LoaderEntry>()
  private readonly prefetched = new Map<string, SessionMessageTarget>()
  private activeKey: string | null = null
  private activePrefetchDirectory: string | null = null
  private disposed = false

  constructor(private readonly childStores: ChildStoreManager) {}

  activate(): void {
    this.disposed = false
  }

  setActivePrefetchDirectory(directory: string): void {
    const normalizedDirectory = normalizeDirectory(directory)
    if (normalizedDirectory === this.activePrefetchDirectory) return
    this.activePrefetchDirectory = normalizedDirectory
    for (const [key, entry] of this.entries) {
      if (entry.snapshot.loadingKind !== "prefetch" || key.startsWith(`${normalizedDirectory}\n`)) continue
      this.bumpGeneration(this.targetFromKey(key), entry)
      entry.inflight = null
      this.patchEntry(this.targetFromKey(key), entry, {
        status: "idle",
        loadingKind: null,
        error: null,
      })
    }
  }

  ensure(
    target: SessionMessageTarget,
    options?: { force?: boolean; reason?: "selected" | "reactive" | "force" },
  ): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (options?.reason === "selected") {
      const key = this.keyFor(normalized)
      this.activeKey = key
      this.prefetched.delete(key)
    }
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const materialization = getSessionMaterializationStatus(store.getState(), normalized.sessionID)

    if (!options?.force && materialization.renderable && entry.snapshot.resolved) {
      const stale = entry.snapshot.updatedAt === undefined
        || Date.now() - entry.snapshot.updatedAt >= FRESHNESS_TTL_MS
      if (options?.reason === "selected" && stale && !entry.inflight) {
        void this.refreshTail(normalized)
      }
      return entry.inflight ?? Promise.resolve()
    }

    if (entry.inflight) {
      if (options?.reason !== "reactive" && entry.snapshot.loadingKind === "prefetch") {
        this.patchEntry(normalized, entry, { loadingKind: "initial" })
      }
      return entry.inflight
    }

    if (options?.force) this.bumpGeneration(normalized, entry)
    const kind: SessionMessageLoadKind = options?.reason === "reactive" ? "initial" : "initial"
    return this.startLoad(normalized, entry, store, kind, async (isCurrent) => {
      await this.loadInitial(normalized, entry, store, isCurrent)
    })
  }

  prefetch(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (
      !normalized
      || this.disposed
      || normalized.directory !== this.activePrefetchDirectory
      || !useFeatureFlagsStore.getState().sessionFastLoadEnabled
    ) {
      return Promise.resolve()
    }
    const entry = this.getEntry(normalized)
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    if (getSessionMaterializationStatus(store.getState(), normalized.sessionID).renderable) {
      return Promise.resolve()
    }
    if (entry.inflight) return entry.inflight
    return this.startLoad(normalized, entry, store, "prefetch", async (isCurrent) => {
      await this.loadInitial(normalized, entry, store, isCurrent)
    }).then(() => this.retainPrefetched(normalized))
  }

  loadOlder(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) return entry.inflight.then(() => this.loadOlder(normalized))
    if (entry.snapshot.complete || !entry.snapshot.cursor) return Promise.resolve()
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const cursor = entry.snapshot.cursor
    return this.startLoad(normalized, entry, store, "older", async (isCurrent) => {
      const page = await this.fetchPage(normalized, DEFAULT_MESSAGE_LIMIT, cursor, "older")
      if (!isCurrent()) return
      const committed = this.commitPage(normalized, entry, store, page, "prepend", isCurrent)
      if (!committed) return
      this.patchEntry(normalized, entry, {
        status: "ready",
        loadingKind: null,
        error: null,
        resolved: true,
        limit: Math.max(entry.snapshot.limit, committed.length),
        cursor: page.cursor,
        complete: page.complete,
        updatedAt: Date.now(),
      })
      this.persistCoverage(normalized, entry.snapshot)
    })
  }

  refreshTail(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) {
      if (entry.queuedRefresh) return entry.queuedRefresh
      const currentInflight = entry.inflight
      const queued = currentInflight.then(() => {
        if (entry.queuedRefresh !== queued) return
        entry.queuedRefresh = null
        return this.refreshTail(normalized)
      })
      entry.queuedRefresh = queued
      return queued
    }
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const previousCoverage = entry.snapshot.resolved
      ? { cursor: entry.snapshot.cursor, complete: entry.snapshot.complete, limit: entry.snapshot.limit }
      : null
    this.bumpGeneration(normalized, entry)
    return this.startLoad(normalized, entry, store, "refresh", async (isCurrent) => {
      const page = await this.fetchPage(normalized, TAIL_REFRESH_LIMIT, undefined, "refresh")
      if (!isCurrent()) return
      const committed = this.commitPage(normalized, entry, store, page, "merge", isCurrent)
      if (!committed) return
      this.patchEntry(normalized, entry, {
        status: "ready",
        loadingKind: null,
        error: null,
        resolved: true,
        limit: previousCoverage?.limit ?? Math.max(entry.snapshot.limit, committed.length),
        cursor: previousCoverage?.cursor ?? page.cursor,
        complete: previousCoverage?.complete ?? page.complete,
        updatedAt: Date.now(),
      })
      this.persistCoverage(normalized, entry.snapshot)
    })
  }

  getSnapshot(target: SessionMessageTarget): SessionMessageLoadState {
    const normalized = this.normalizeTarget(target)
    return normalized ? this.getEntry(normalized).snapshot : EMPTY_SESSION_MESSAGE_LOAD_STATE
  }

  subscribe(target: SessionMessageTarget, listener: () => void): () => void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return () => undefined
    const entry = this.getEntry(normalized)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  hasOptimistic(target: SessionMessageTarget): boolean {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return false
    return (this.entries.get(this.keyFor(normalized))?.optimistic.size ?? 0) > 0
  }

  optimisticAdd(input: SessionMessageTarget & { message: Message; parts: Part[] }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    const entry = this.getEntry(target)
    entry.optimistic.set(input.message.id, {
      message: input.message,
      parts: input.parts.filter((part) => Boolean(part?.id)),
    })
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const messages = [...(current.message[target.sessionID] ?? [])]
    if (!messages.some((message) => message.id === input.message.id)) {
      messages.splice(0, messages.length, ...insertMessageChronologically(messages, input.message))
    }
    const message = { ...current.message, [target.sessionID]: messages }
    const part = { ...current.part, [input.message.id]: input.parts.filter((candidate) => Boolean(candidate?.id)) }
    const draft = { ...current, message, part, session_user_activity: current.session_user_activity }
    const activityChanged = updateSessionUserActivityFromMessages(draft, target.sessionID)
    store.setState({ message, part, ...(activityChanged ? { session_user_activity: draft.session_user_activity } : {}) })
  }

  optimisticRemove(input: SessionMessageTarget & { messageID: string }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    this.getEntry(target).optimistic.delete(input.messageID)
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const messages = (current.message[target.sessionID] ?? []).filter((message) => message.id !== input.messageID)
    const part = { ...current.part }
    delete part[input.messageID]
    const message = { ...current.message, [target.sessionID]: messages }
    const draft = { ...current, message, part, session_user_activity: current.session_user_activity }
    const activityChanged = updateSessionUserActivityFromMessages(draft, target.sessionID)
    store.setState({ message, part, ...(activityChanged ? { session_user_activity: draft.session_user_activity } : {}) })
  }

  invalidateSession(target: SessionMessageTarget): void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return
    const key = this.keyFor(normalized)
    this.prefetched.delete(key)
    const entry = this.entries.get(key)
    if (entry) {
      this.bumpGeneration(normalized, entry)
      entry.inflight = null
      entry.queuedRefresh = null
      entry.optimistic.clear()
      this.entries.delete(key)
      for (const listener of entry.listeners) listener()
    }
    clearSessionPrefetch(normalized.directory, [normalized.sessionID])
    clearSessionMessagePagination(normalized.directory, [normalized.sessionID])
  }

  invalidateDirectory(directory: string): void {
    const normalizedDirectory = normalizeDirectory(directory)
    const prefix = `${normalizedDirectory}\n`
    for (const key of this.prefetched.keys()) {
      if (key.startsWith(prefix)) this.prefetched.delete(key)
    }
    if (this.activeKey?.startsWith(prefix)) this.activeKey = null
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue
      entry.inflight = null
      entry.queuedRefresh = null
      entry.optimistic.clear()
      this.entries.delete(key)
      for (const listener of entry.listeners) listener()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.inflight = null
      entry.queuedRefresh = null
      entry.optimistic.clear()
      for (const listener of entry.listeners) listener()
    }
    this.entries.clear()
    this.prefetched.clear()
    this.activeKey = null
    this.activePrefetchDirectory = null
  }

  private normalizeTarget(target: SessionMessageTarget): SessionMessageTarget | null {
    const directory = normalizeDirectory(target.directory)
    if (!directory || !target.sessionID) return null
    return { directory, sessionID: target.sessionID }
  }

  private keyFor(target: SessionMessageTarget): string {
    return `${target.directory}\n${target.sessionID}`
  }

  private targetFromKey(key: string): SessionMessageTarget {
    const separator = key.lastIndexOf("\n")
    return { directory: key.slice(0, separator), sessionID: key.slice(separator + 1) }
  }

  private getEntry(target: SessionMessageTarget): LoaderEntry {
    const key = this.keyFor(target)
    const existing = this.entries.get(key)
    if (existing) return existing
    const prefetched = getSessionPrefetch(target.directory, target.sessionID)
    const snapshot = createDefaultState()
    if (prefetched) {
      snapshot.limit = prefetched.limit
      snapshot.cursor = prefetched.cursor
      snapshot.complete = prefetched.complete
      snapshot.updatedAt = prefetched.at
    }
    const entry: LoaderEntry = {
      snapshot,
      listeners: new Set(),
      inflight: null,
      queuedRefresh: null,
      optimistic: new Map(),
    }
    this.entries.set(key, entry)
    this.mirrorPagination(target, snapshot)
    return entry
  }

  private patchEntry(target: SessionMessageTarget, entry: LoaderEntry, patch: Partial<SessionMessageLoadState>): void {
    entry.snapshot = { ...entry.snapshot, ...patch }
    this.mirrorPagination(target, entry.snapshot)
    for (const listener of entry.listeners) listener()
  }

  private bumpGeneration(target: SessionMessageTarget, entry: LoaderEntry): number {
    const generation = entry.snapshot.generation + 1
    this.patchEntry(target, entry, { generation })
    return generation
  }

  private mirrorPagination(target: SessionMessageTarget, state: SessionMessageLoadState): void {
    setSessionMessagePagination(target.directory, target.sessionID, {
      limit: state.limit,
      cursor: state.cursor,
      complete: state.complete,
      loading: state.status === "loading",
      initialized: state.resolved,
    })
  }

  private startLoad(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: StoreApi<DirectoryStore>,
    kind: SessionMessageLoadKind,
    run: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    const generation = entry.snapshot.generation
    const finish = startSessionLoadPerformanceEvent({
      operation: kind === "prefetch" ? "prefetch" : `messages.${kind}`,
      caller: kind,
    })
    const isCurrent = () => (
      !this.disposed
      && entry.snapshot.generation === generation
      && this.childStores.getChild(target.directory) === store
    )
    this.patchEntry(target, entry, { status: "loading", loadingKind: kind, error: null })
    const promise = Promise.resolve()
      .then(() => run(isCurrent))
      .then(() => finish(isCurrent() ? "complete" : "stale"))
      .catch((error: unknown) => {
        if (!isCurrent()) {
          finish("stale")
          return
        }
        finish("error")
        this.patchEntry(target, entry, {
          status: "error",
          loadingKind: null,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      })
      .finally(() => {
        if (entry.inflight === promise) entry.inflight = null
      })
    entry.inflight = promise
    return promise
  }

  private async loadInitial(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: StoreApi<DirectoryStore>,
    isCurrent: () => boolean,
  ): Promise<void> {
    const firstLimit = getInitialPageSize()
    let page = await this.fetchPage(target, firstLimit, undefined, "initial")
    if (!isCurrent()) return

    if (
      useFeatureFlagsStore.getState().sessionFastLoadEnabled
      && !page.complete
      && !page.session.some(isUserMessage)
    ) {
      for (const limit of getExpansionLimits()) {
        if (limit <= firstLimit || !isCurrent()) continue
        page = await this.fetchPage(target, limit, undefined, "initial")
        if (!isCurrent() || page.complete || page.session.some(isUserMessage)) break
      }
    }

    const committed = this.commitPage(target, entry, store, page, "merge", isCurrent)
    if (!committed || !isCurrent()) return
    this.patchEntry(target, entry, {
      status: "ready",
      loadingKind: null,
      error: null,
      resolved: true,
      limit: Math.max(page.session.length, getInitialPageSize()),
      cursor: page.cursor,
      complete: page.complete,
      updatedAt: Date.now(),
    })
    this.persistCoverage(target, entry.snapshot)
  }

  private async fetchPage(
    target: SessionMessageTarget,
    limit: number,
    before: string | undefined,
    caller: "initial" | "older" | "refresh",
  ): Promise<FetchedPage> {
    const requestLimit = normalizeMessageFetchLimit(limit)
    const finish = startSessionLoadPerformanceEvent({
      operation: "messages.page",
      caller,
      requestLimit,
      cursorPresent: before !== undefined,
    })
    let attempts = 0
    let recordCount = 0
    try {
      const sdk = opencodeClient.getScopedSdkClient(target.directory)
      const result = await retry(async () => {
        attempts += 1
        return sdk.session.messages({ sessionID: target.sessionID, limit: requestLimit, before })
      })
      const records = unwrapMessageRecordsResult(result).filter(hasMessageRecordInfo)
      recordCount = records.length
      const session = records
        .map((record) => stripMessageDiffSnapshots(record.info))
      const orderedSession = sortMessagesChronologically(session)
      const partsByMessageID = new Map<string, Part[]>()
      for (const record of records) {
        partsByMessageID.set(record.info.id, (record.parts ?? []).filter((part) => Boolean(part?.id)))
      }
      const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
      const complete = !cursor || records.length < requestLimit
      finish("complete", { retryCount: Math.max(0, attempts - 1), recordCount })
      return { session: orderedSession, partsByMessageID, cursor: complete ? undefined : cursor, complete }
    } catch (error) {
      finish("error", { retryCount: Math.max(0, attempts - 1), recordCount })
      throw error
    }
  }

  private commitPage(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: StoreApi<DirectoryStore>,
    page: FetchedPage,
    mode: "merge" | "prepend",
    isCurrent: () => boolean,
  ): Message[] | null {
    if (!isCurrent()) return null
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now()
    const merged = mergeOptimisticPage({
      session: page.session,
      part: [...page.partsByMessageID].map(([id, part]) => ({ id, part })),
      cursor: page.cursor,
      complete: page.complete,
    }, [...entry.optimistic.values()])
    for (const messageID of merged.confirmed) entry.optimistic.delete(messageID)
    const mergedParts = new Map(merged.part.map((candidate) => [candidate.id, candidate.part] as const))
    const current = store.getState()
    const materialized = materializeSessionSnapshots(
      current,
      target.sessionID,
      merged.session.map((info) => ({ info, parts: mergedParts.get(info.id) ?? [] })),
      { skipPartTypes: SKIP_PARTS, mode },
    )
    if (!isCurrent()) return null
    const draft = {
      ...current,
      message: materialized.message,
      part: materialized.part,
      session_user_activity: current.session_user_activity,
    }
    const activityChanged = updateSessionUserActivityFromMessages(draft, target.sessionID)
    if (materialized.messagesChanged || materialized.partsChanged || materialized.sessionsChanged || activityChanged) {
      store.setState({
        ...(materialized.sessionsChanged && materialized.session ? { session: materialized.session } : {}),
        ...(materialized.messagesChanged ? { message: materialized.message } : {}),
        ...(materialized.partsChanged ? { part: materialized.part } : {}),
        ...(activityChanged ? { session_user_activity: draft.session_user_activity } : {}),
      })
    }
    reconcileSessionChangeAttribution(target.directory, target.sessionID, store.getState())
    const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now()
    streamPerfObserve("session.load.messages.materialize.duration_ms", Math.max(0, endedAt - startedAt))
    streamPerfObserve("session.load.messages.materialize.record_count", merged.session.length)
    return materialized.messages
  }

  private persistCoverage(target: SessionMessageTarget, state: SessionMessageLoadState): void {
    setSessionPrefetch({
      directory: target.directory,
      sessionID: target.sessionID,
      limit: state.limit,
      cursor: state.cursor,
      complete: state.complete,
      at: state.updatedAt,
    })
  }

  private retainPrefetched(target: SessionMessageTarget): void {
    const key = this.keyFor(target)
    if (key === this.activeKey || this.getEntry(target).snapshot.status !== "ready") return
    this.prefetched.delete(key)
    this.prefetched.set(key, target)
    const limit = isVSCodeRuntime() ? 1 : 2
    while (this.prefetched.size > limit) {
      const oldest = this.prefetched.entries().next().value as [string, SessionMessageTarget] | undefined
      if (!oldest) break
      this.prefetched.delete(oldest[0])
      if (oldest[0] === this.activeKey) continue
      const store = this.childStores.getChild(oldest[1].directory)
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
        dropSessionCaches(draft, [oldest[1].sessionID])
        store.setState(draft)
      }
      this.invalidateSession(oldest[1])
    }
  }
}
