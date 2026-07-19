import { create, type StoreApi } from "zustand"
import type { DirState, State } from "./types"
import { INITIAL_STATE, MAX_DIR_STORES, DIR_IDLE_TTL_MS } from "./types"
import { pickDirectoriesToEvict, canDisposeDirectory, hasPendingBlockingRequests } from "./eviction"
import { readDirCache, persistVcs, persistProjectMeta, persistIcon, persistSessions } from "./persist-cache"

export type DirectoryStore = State & {
  /** Apply a partial state update */
  patch: (partial: Partial<State>) => void
  /** Replace state wholesale (used during bootstrap) */
  replace: (next: State) => void
}

const getDirectorySubscriptionKey = (value?: string | null): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  return normalized.toLowerCase()
}

export const shouldBootstrapDirectorySubscription = (
  requestedDirectory: string | undefined,
  activeDirectory: string,
): boolean => {
  const activeKey = getDirectorySubscriptionKey(activeDirectory)
  const requestedKey = getDirectorySubscriptionKey(requestedDirectory ?? activeDirectory)
  return activeKey !== null && requestedKey !== null && activeKey === requestedKey
}

export const getActiveDirectoryStoreKeys = (
  directories: Iterable<string>,
  activeDirectory: string,
): string[] => Array.from(directories).filter((directory) => (
  shouldBootstrapDirectorySubscription(directory, activeDirectory)
))

function createDirectoryStore(directory: string): StoreApi<DirectoryStore> {
  // Restore cached metadata from localStorage
  const cached = readDirCache(directory)

  // Stale-while-revalidate: seed the session list from cache so the sidebar
  // paints chats instantly. Bootstrap phase-3 loadSessions overwrites with the
  // fresh list (its empty-list race guard preserves these until then).
  const cachedSessions = cached.sessions ?? INITIAL_STATE.session

  const store = create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    vcs: cached.vcs ?? INITIAL_STATE.vcs,
    projectMeta: cached.projectMeta ?? INITIAL_STATE.projectMeta,
    icon: cached.icon ?? INITIAL_STATE.icon,
    session: cachedSessions,
    sessionTotal: cachedSessions.length,
    limit: Math.max(cachedSessions.length, INITIAL_STATE.limit),
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))

  // Subscribe to persist metadata changes back to localStorage
  store.subscribe((state, prev) => {
    if (state.vcs !== prev.vcs) persistVcs(directory, state.vcs)
    if (state.projectMeta !== prev.projectMeta) persistProjectMeta(directory, state.projectMeta)
    if (state.icon !== prev.icon) persistIcon(directory, state.icon)
    if (state.session !== prev.session) persistSessions(directory, state.session)
  })

  return store
}

export class ChildStoreManager {
  readonly children = new Map<string, StoreApi<DirectoryStore>>()
  private readonly lifecycle = new Map<string, DirState>()
  private readonly pins = new Map<string, number>()
  private readonly disposers = new Map<string, Set<() => void>>()
  private readonly registrySubscribers = new Set<() => void>()

  private onBootstrap?: (directory: string) => void
  private onDispose?: (directory: string, snapshot: State) => void
  private isBooting?: (directory: string) => boolean
  private isLoadingSessions?: (directory: string) => boolean

  private notifyRegistrySubscribers() {
    for (const subscriber of this.registrySubscribers) {
      subscriber()
    }
  }

  configure(callbacks: {
    onBootstrap?: (directory: string) => void
    onDispose?: (directory: string, snapshot: State) => void
    isBooting?: (directory: string) => boolean
    isLoadingSessions?: (directory: string) => boolean
  }) {
    this.onBootstrap = callbacks.onBootstrap
    this.onDispose = callbacks.onDispose
    this.isBooting = callbacks.isBooting
    this.isLoadingSessions = callbacks.isLoadingSessions
  }

  mark(directory: string) {
    if (!directory) return
    this.lifecycle.set(directory, { lastAccessAt: Date.now() })
    this.runEviction(directory)
  }

  pin(directory: string) {
    if (!directory) return
    this.pins.set(directory, (this.pins.get(directory) ?? 0) + 1)
    this.mark(directory)
  }

  unpin(directory: string) {
    if (!directory) return
    const next = (this.pins.get(directory) ?? 0) - 1
    if (next > 0) {
      this.pins.set(directory, next)
      return
    }
    this.pins.delete(directory)
    this.runEviction()
  }

  pinned(directory: string) {
    return (this.pins.get(directory) ?? 0) > 0
  }

  ensureChild(directory: string, options?: { bootstrap?: boolean }): StoreApi<DirectoryStore> {
    if (!directory) throw new Error("No directory provided to ensureChild")

    let store = this.children.get(directory)
    if (!store) {
      store = createDirectoryStore(directory)
      this.children.set(directory, store)
      this.notifyRegistrySubscribers()
    }

    this.mark(directory)

    const shouldBootstrap = options?.bootstrap ?? true
    if (shouldBootstrap && store.getState().status !== "complete") {
      this.onBootstrap?.(directory)
    }

    return store
  }

  getChild(directory: string): StoreApi<DirectoryStore> | undefined {
    return this.children.get(directory)
  }

  registerDisposer(directory: string, disposer: () => void): () => void {
    if (!directory || !this.children.has(directory)) {
      return () => undefined
    }

    const registered = this.disposers.get(directory) ?? new Set<() => void>()
    registered.add(disposer)
    this.disposers.set(directory, registered)

    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.disposers.get(directory)
      current?.delete(disposer)
      if (current?.size === 0) {
        this.disposers.delete(directory)
      }
    }
  }

  private releaseDirectory(directory: string, notify = true): boolean {
    const store = this.children.get(directory)
    if (!store) return false

    const snapshot = store.getState()
    const disposers = [...(this.disposers.get(directory) ?? [])]
    this.disposers.delete(directory)
    this.children.delete(directory)
    this.lifecycle.delete(directory)
    this.pins.delete(directory)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        console.error("[sync] directory disposer failed", { directory, error })
      }
    }
    try {
      this.onDispose?.(directory, snapshot)
    } catch (error) {
      console.error("[sync] directory ownership callback failed", { directory, error })
    }

    if (notify) {
      this.notifyRegistrySubscribers()
    }
    return true
  }

  disposeDirectory(directory: string): boolean {
    if (
      !canDisposeDirectory({
        directory,
        hasStore: this.children.has(directory),
        pinned: this.pinned(directory),
        booting: this.isBooting?.(directory) ?? false,
        loadingSessions: this.isLoadingSessions?.(directory) ?? false,
        hasPendingBlockingRequests: this.hasPendingBlockingRequestsForDirectory(directory),
      })
    ) {
      return false
    }

    return this.releaseDirectory(directory)
  }

  runEviction(skip?: string) {
    const stores = [...this.children.keys()]
    if (stores.length === 0) return
    const list = pickDirectoriesToEvict({
      stores,
      state: this.lifecycle,
      pins: new Set(stores.filter((d) => this.pinned(d))),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      now: Date.now(),
      hasPendingBlockingRequests: (dir) => this.hasPendingBlockingRequestsForDirectory(dir),
    }).filter((d) => d !== skip)
    for (const directory of list) {
      this.disposeDirectory(directory)
    }
  }

  hasPendingBlockingRequestsForDirectory(directory: string): boolean {
    return hasPendingBlockingRequests(this.children.get(directory)?.getState())
  }

  /** Apply a state mutation to a directory's store */
  update(directory: string, fn: (state: State) => Partial<State>) {
    const store = this.children.get(directory)
    if (!store) return
    const current = store.getState()
    const patch = fn(current)
    store.setState(patch)
  }

  /** Get current state of a directory store (snapshot) */
  getState(directory: string): State | undefined {
    return this.children.get(directory)?.getState()
  }

  disposeAll() {
    for (const directory of [...this.children.keys()]) {
      this.releaseDirectory(directory, false)
    }
    this.notifyRegistrySubscribers()
    this.lifecycle.clear()
    this.pins.clear()
    this.disposers.clear()
  }

  subscribeRegistry(listener: () => void): () => void {
    this.registrySubscribers.add(listener)
    return () => {
      this.registrySubscribers.delete(listener)
    }
  }

  subscribeAll(listener: () => void): () => void {
    const storeUnsubscribers = new Map<string, () => void>()

    const syncStoreSubscriptions = () => {
      const activeDirectories = new Set(this.children.keys())

      for (const [directory, unsubscribe] of storeUnsubscribers.entries()) {
        if (activeDirectories.has(directory)) {
          continue
        }
        unsubscribe()
        storeUnsubscribers.delete(directory)
      }

      for (const [directory, store] of this.children.entries()) {
        if (storeUnsubscribers.has(directory)) {
          continue
        }
        storeUnsubscribers.set(directory, store.subscribe(listener))
      }
    }

    syncStoreSubscriptions()
    const unsubscribeRegistry = this.subscribeRegistry(() => {
      syncStoreSubscriptions()
      listener()
    })

    return () => {
      unsubscribeRegistry()
      for (const unsubscribe of storeUnsubscribers.values()) {
        unsubscribe()
      }
      storeUnsubscribers.clear()
    }
  }

  subscribeSessionStatuses(listener: () => void): () => void {
    const storeUnsubscribers = new Map<string, () => void>()

    const syncStoreSubscriptions = () => {
      const activeDirectories = new Set(this.children.keys())

      for (const [directory, unsubscribe] of storeUnsubscribers.entries()) {
        if (activeDirectories.has(directory)) continue
        unsubscribe()
        storeUnsubscribers.delete(directory)
      }

      for (const [directory, store] of this.children.entries()) {
        if (storeUnsubscribers.has(directory)) continue
        storeUnsubscribers.set(directory, store.subscribe((state, previous) => {
          if (state.session_status !== previous.session_status) {
            listener()
          }
        }))
      }
    }

    syncStoreSubscriptions()
    const unsubscribeRegistry = this.subscribeRegistry(() => {
      syncStoreSubscriptions()
      listener()
    })

    return () => {
      unsubscribeRegistry()
      for (const unsubscribe of storeUnsubscribers.values()) {
        unsubscribe()
      }
      storeUnsubscribers.clear()
    }
  }
}
