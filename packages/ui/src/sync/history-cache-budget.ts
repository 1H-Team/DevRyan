import type { StoreApi } from "zustand"
import type { DirectoryStore } from "./child-store"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"

/** Estimated retained JS bytes, not a claim about browser RSS. Active work may exceed it. */
export const HISTORY_CACHE_BYTE_LIMIT = 128 * 1024 * 1024
const ACCOUNTING_DELAY_MS = 500

type Entry = { directory: string; sessionID: string; bytes: number; accessed: number }
type Options = {
  maxBytes?: number
  isProtected?: (directory: string, sessionID: string) => boolean
  onEvict?: (directory: string, sessionID: string) => void
}

/** One budget per renderer. Accounting is deferred off the event path and memoized
 * by immutable record identity; unchanged strings/records are never traversed again. */
export class HistoryCacheBudget {
  private readonly stores = new Map<string, StoreApi<DirectoryStore>>()
  private readonly unsubscribers = new Map<string, () => void>()
  private readonly entries = new Map<string, Map<string, Entry>>()
  private readonly dirty = new Set<string>()
  private sizes = new WeakMap<object, number>()
  private timer?: ReturnType<typeof setTimeout>
  private clock = 0
  private totalBytes = 0
  private sweeping = false
  readonly maxBytes: number

  constructor(private readonly options: Options = {}) {
    this.maxBytes = options.maxBytes ?? HISTORY_CACHE_BYTE_LIMIT
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0) throw new Error("Invalid history byte limit")
  }

  private size(value: unknown): number {
    if (typeof value === "string") return 16 + value.length * 2
    if (value === null || typeof value !== "object") return 8
    const cached = this.sizes.get(value)
    if (cached !== undefined) return cached
    // SDK records are JSON-shaped. The provisional value also bounds accidental cycles.
    this.sizes.set(value, 0)
    let bytes = 32
    for (const [key, child] of Object.entries(value)) bytes += 16 + key.length * 2 + this.size(child)
    this.sizes.set(value, bytes)
    return bytes
  }

  private schedule(directory: string) {
    this.dirty.add(directory)
    if (this.sweeping || this.timer) return
    this.timer = setTimeout(() => this.flush(), ACCOUNTING_DELAY_MS)
  }

  track(directory: string, store: StoreApi<DirectoryStore>) {
    this.removeDirectory(directory)
    this.stores.set(directory, store)
    this.unsubscribers.set(directory, store.subscribe((state, previous) => {
      if (state.message !== previous.message || state.part !== previous.part
        || state.session_status !== previous.session_status || state.permission !== previous.permission
        || state.question !== previous.question || state.revert_transaction !== previous.revert_transaction) {
        this.schedule(directory)
      }
    }))
    this.schedule(directory)
  }

  touch(directory: string, sessionID: string) {
    if (!this.stores.has(directory)) return
    const entries = this.entries.get(directory) ?? new Map<string, Entry>()
    const entry = entries.get(sessionID) ?? { directory, sessionID, bytes: 0, accessed: 0 }
    entry.accessed = ++this.clock
    entries.set(sessionID, entry)
    this.entries.set(directory, entries)
    this.schedule(directory)
  }

  private account(directory: string) {
    const state = this.stores.get(directory)?.getState()
    if (!state) return
    const previous = this.entries.get(directory) ?? new Map<string, Entry>()
    const bytes = new Map<string, number>()
    const owners = new Map<string, string>()
    for (const [sessionID, messages] of Object.entries(state.message)) {
      if (!messages) continue
      bytes.set(sessionID, this.size(messages) + sessionID.length * 2)
      for (const message of messages) owners.set(message.id, sessionID)
    }
    for (const [messageID, parts] of Object.entries(state.part)) {
      const sessionID = parts?.[0]?.sessionID ?? owners.get(messageID)
      if (!parts || !sessionID) continue
      bytes.set(sessionID, (bytes.get(sessionID) ?? 0) + this.size(parts) + messageID.length * 2)
    }
    for (const entry of previous.values()) this.totalBytes -= entry.bytes
    const next = new Map<string, Entry>()
    for (const [sessionID, size] of bytes) {
      next.set(sessionID, { directory, sessionID, bytes: size, accessed: previous.get(sessionID)?.accessed ?? ++this.clock })
      this.totalBytes += size
    }
    this.entries.set(directory, next)
  }

  /** Also used by deterministic fixtures; no wall-clock waiting is required. */
  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.sweeping) return
    this.sweeping = true
    try {
      for (const directory of this.dirty) this.account(directory)
      this.dirty.clear()
      if (this.totalBytes <= this.maxBytes) return
      const candidates = [...this.entries.values()].flatMap((entries) => [...entries.values()])
        .sort((a, b) => a.accessed - b.accessed)
      const protectedIds = new Map<string, Set<string>>()
      const evictions = new Map<string, string[]>()
      for (const entry of candidates) {
        if (this.totalBytes <= this.maxBytes) break
        const store = this.stores.get(entry.directory)
        if (!store) continue
        const state = store.getState()
        let protectedSessions = protectedIds.get(entry.directory)
        if (!protectedSessions) {
          protectedSessions = getProtectedSessionCacheIds(state)
          protectedIds.set(entry.directory, protectedSessions)
        }
        if (protectedSessions.has(entry.sessionID) || state.revert_transaction[entry.sessionID]?.status === "pending"
          || this.options.isProtected?.(entry.directory, entry.sessionID)) continue
        const stale = evictions.get(entry.directory) ?? []
        stale.push(entry.sessionID)
        evictions.set(entry.directory, stale)
        this.entries.get(entry.directory)?.delete(entry.sessionID)
        this.totalBytes -= entry.bytes
      }
      for (const [directory, sessionIDs] of evictions) {
        const store = this.stores.get(directory)
        if (!store) continue
        // Invalidate coverage before subscribers can start a reload.
        for (const sessionID of sessionIDs) this.options.onEvict?.(directory, sessionID)
        const state = store.getState()
        const patch = {
          message: { ...state.message }, part: { ...state.part }, todo: { ...state.todo },
          session_diff: { ...state.session_diff }, session_status: { ...state.session_status },
          permission: { ...state.permission }, question: { ...state.question },
          revert_transaction: { ...state.revert_transaction },
        }
        dropSessionCaches(patch, sessionIDs)
        for (const sessionID of sessionIDs) delete patch.revert_transaction[sessionID]
        store.setState(patch)
      }
      // Eviction itself dirties directories; retain that work for the next sweep.
    } finally {
      this.sweeping = false
      if (this.dirty.size > 0 && !this.timer) this.timer = setTimeout(() => this.flush(), ACCOUNTING_DELAY_MS)
    }
  }

  snapshot() {
    return { estimatedBytes: this.totalBytes, maxBytes: this.maxBytes, overBudgetBytes: Math.max(0, this.totalBytes - this.maxBytes) }
  }

  removeDirectory(directory: string) {
    this.unsubscribers.get(directory)?.()
    this.unsubscribers.delete(directory)
    this.stores.delete(directory)
    for (const entry of this.entries.get(directory)?.values() ?? []) this.totalBytes -= entry.bytes
    this.entries.delete(directory)
    this.dirty.delete(directory)
    if (this.dirty.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  dispose() {
    for (const directory of this.stores.keys()) this.removeDirectory(directory)
    this.sizes = new WeakMap()
  }
}
