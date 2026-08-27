import { useCallback, useEffect, useRef, useMemo } from "react"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import {
  useSyncSDK,
  useSyncDirectory,
  useChildStoreManager,
  useSyncResyncSession,
  useSessionMessageLoader,
} from "./sync-context"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"
import { registerSessionMaterializer } from "./session-materializer"
import { unwrapSdkResult } from "./sdk-result"
import { opencodeClient } from "@/lib/opencode/client"
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
const sessionMetadataInflight = new Map<string, Promise<void>>()

// ---------------------------------------------------------------------------
// useSync — message loading, pagination, optimistic updates
// Message loading, pagination, optimistic updates
// ---------------------------------------------------------------------------

export function useSync() {
  const sdk = useSyncSDK()
  const directory = useSyncDirectory()
  const childStores = useChildStoreManager()
  const resyncSession = useSyncResyncSession()
  const messageLoader = useSessionMessageLoader()

  // Refs for mutable tracking (no re-renders)
  const seen = useRef(new Map<string, Set<string>>())
  const directoryDisposerUnregisters = useRef(new Map<string, () => void>())

  const clearDirectoryTracking = useCallback((targetDirectory: string) => {
    const prefix = `${targetDirectory}\n`
    for (const key of sessionMetadataInflight.keys()) {
      if (key.startsWith(prefix)) sessionMetadataInflight.delete(key)
    }
    seen.current.delete(targetDirectory)
    directoryDisposerUnregisters.current.delete(targetDirectory)
  }, [])

  const registerDirectoryTracking = useCallback((targetDirectory: string) => {
    if (!targetDirectory || directoryDisposerUnregisters.current.has(targetDirectory)) return
    const unregister = childStores.registerDisposer(targetDirectory, () => {
      clearDirectoryTracking(targetDirectory)
    })
    directoryDisposerUnregisters.current.set(targetDirectory, unregister)
  }, [childStores, clearDirectoryTracking])

  useEffect(() => () => {
    for (const unregister of directoryDisposerUnregisters.current.values()) {
      unregister()
    }
    directoryDisposerUnregisters.current.clear()
  }, [])

  const resolveDirectory = useCallback((override?: string | null) => override || directory, [directory])

  const keyFor = useCallback(
    (sessionID: string, directoryOverride?: string | null) => `${resolveDirectory(directoryOverride)}\n${sessionID}`,
    [resolveDirectory],
  )

  // Session cache eviction — two levels of LRU:
  // (1) across directories (max 30), (2) within a directory (SESSION_CACHE_LIMIT).

  // Evict all cached session data for given IDs from a directory's store
  const evict = useCallback(
    (dir: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      const dirStore = childStores.getChild(dir)
      if (!dirStore) return

      const current = dirStore.getState()
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
      for (const id of sessionIDs) {
        delete draft.revert_transaction[id]
      }
      dirStore.setState(draft)

      for (const id of sessionIDs) {
        messageLoader.invalidateSession({ directory: dir, sessionID: id })
      }
    },
    [childStores, messageLoader],
  )

  // Get or create the seen-set for a directory. LRU reorder on access.
  // When seen directories exceed MAX_SEEN_DIRS, evict the oldest directory's caches.
  // LRU reorder on access. Evicts oldest directory when exceeding MAX_SEEN_DIRS.
  const seenFor = useCallback((directoryOverride?: string | null) => {
    const targetDirectory = resolveDirectory(directoryOverride)
    const existing = seen.current.get(targetDirectory)
    if (existing) {
      // LRU reorder: delete + re-insert moves to end (most recent)
      seen.current.delete(targetDirectory)
      seen.current.set(targetDirectory, existing)
      return existing
    }
    const created = new Set<string>()
    seen.current.set(targetDirectory, created)

    // Evict oldest directories if over limit
    while (seen.current.size > MAX_SEEN_DIRS) {
      const first = seen.current.keys().next().value
      if (!first) break
      const staleSessionIds = [...(seen.current.get(first) ?? [])]
      seen.current.delete(first)
      evict(first, staleSessionIds)
    }

    return created
  }, [resolveDirectory, evict])

  // Touch a session — triggers both directory-level and session-level eviction
  const touch = useCallback(
    (sessionID: string, directoryOverride?: string | null) => {
      const targetDirectory = resolveDirectory(directoryOverride)
      const targetStore = childStores.ensureChild(targetDirectory, { bootstrap: false })
      registerDirectoryTracking(targetDirectory)
      const s = seenFor(targetDirectory)
      const protectedIds = getProtectedSessionCacheIds(targetStore.getState())
      const stale = pickSessionCacheEvictions({
        seen: s,
        keep: sessionID,
        limit: SESSION_CACHE_LIMIT,
        preserve: protectedIds,
      })
      evict(targetDirectory, stale)
    },
    [childStores, resolveDirectory, seenFor, evict, registerDirectoryTracking],
  )

  // Background-session message trim — the limit MemoryDebugPanel advertises.
  // Debounced after every touch(): sessions other than the current one keep at
  // most getBackgroundTrimLimit() newest messages in memory. Trimmed sessions
  // reset pagination (complete: false, no cursor) so the existing Load More →
  // force-reload path rehydrates older history on demand. Never trims the
  // current session, protected sessions (streaming / pending permissions or
  // questions / incomplete assistant turn), sessions with optimistic entries,
  // or sessions with a load in flight.
  const trimTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const runBackgroundTrim = useCallback(async (targetDirectory: string) => {
    const targetStore = childStores.getChild(targetDirectory)
    if (!targetStore) return
    const { useSessionUIStore } = await import("./session-ui-store")
    if (childStores.getChild(targetDirectory) !== targetStore) return
    const currentSessionId = useSessionUIStore.getState().currentSessionId
    const state = targetStore.getState()
    const protectedIds = getProtectedSessionCacheIds(state)
    const trimLimit = getBackgroundTrimLimit()
    let message = state.message
    let part = state.part
    let changed = false
    for (const sessionID of Object.keys(state.message)) {
      if (sessionID === currentSessionId) continue
      if (protectedIds.has(sessionID)) continue
      if (messageLoader.hasOptimistic({ directory: targetDirectory, sessionID })) continue
      const meta = messageLoader.getSnapshot({ directory: targetDirectory, sessionID })
      if (meta.status === "loading") continue
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
      messageLoader.invalidateSession({ directory: targetDirectory, sessionID })
    }
    if (changed) targetStore.setState({ message, part })
  }, [childStores, messageLoader])

  const scheduleBackgroundTrim = useCallback((targetDirectory: string) => {
    const existing = trimTimers.current.get(targetDirectory)
    if (existing) clearTimeout(existing)
    trimTimers.current.set(targetDirectory, setTimeout(() => {
      trimTimers.current.delete(targetDirectory)
      void runBackgroundTrim(targetDirectory).catch(() => {})
    }, BACKGROUND_TRIM_DEBOUNCE_MS))
  }, [runBackgroundTrim])

  useEffect(() => {
    const timers = trimTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // Selected-session hydration. Metadata and messages are independent and
  // start together; the message loader is shared across every useSync caller.
  const syncSession = useCallback(
    async (
      sessionID: string,
      options?: boolean | {
        force?: boolean
        directory?: string | null
        reason?: "selected" | "reactive" | "force"
      },
    ) => {
      const force = typeof options === "boolean" ? options : options?.force === true
      const reason = typeof options === "object"
        ? options.reason ?? (force ? "force" : "reactive")
        : force ? "force" : "reactive"
      const targetDirectory = resolveDirectory(typeof options === "object" ? options.directory : null)
      if (reason === "selected") markSessionNavigationLoaderStarted(sessionID, targetDirectory)
      const targetStore = childStores.ensureChild(targetDirectory, { bootstrap: false })
      const key = keyFor(sessionID, targetDirectory)
      touch(sessionID, targetDirectory)
      scheduleBackgroundTrim(targetDirectory)

      const current = targetStore.getState()
      const hasSession = Binary.search(current.session, sessionID, (session) => session.id).found
      let metadataPromise = sessionMetadataInflight.get(key)
      if ((!hasSession || force) && !metadataPromise) {
        const finishMetadata = startSessionLoadPerformanceEvent({
          operation: "session.metadata",
          caller: reason,
        })
        const targetSdk = targetDirectory === directory ? sdk : opencodeClient.getScopedSdkClient(targetDirectory)
        metadataPromise = retry(() =>
          targetSdk.session.get({ sessionID }).then((response) => unwrapSdkResult(response, "session.get")),
        ).then((result) => {
          if (childStores.getChild(targetDirectory) !== targetStore || !result) {
            finishMetadata("stale")
            return
          }
          const state = targetStore.getState()
          const sessions = [...state.session]
          const idx = Binary.search(sessions, sessionID, (session) => session.id)
          const cachedMessages = state.message[sessionID]
          const normalized = cachedMessages
            ? normalizeChatOwnedDiffSummary(
              result as Session & { summary?: SessionSummaryDiffStats | null },
              cachedMessages as Array<Message & { summary?: SessionSummaryDiffStats | null }>,
            ) as Session
            : stripUntrustedSessionDiffSummary(
              result as Session & { summary?: SessionSummaryDiffStats | null },
            ) as Session
          if (idx.found) {
            sessions[idx.index] = mergeSessionPreservingMeaningfulTitle(
              sessions[idx.index],
              normalized,
            )
          }
          else sessions.splice(idx.index, 0, normalized)
          targetStore.setState({ session: sessions })
          finishMetadata("complete")
        }).catch((error) => {
          finishMetadata("error")
          console.error("[sync] failed to fetch session", sessionID, error)
        }).finally(() => {
          if (sessionMetadataInflight.get(key) === metadataPromise) {
            sessionMetadataInflight.delete(key)
          }
        })
        sessionMetadataInflight.set(key, metadataPromise)
      }

      await Promise.all([
        metadataPromise ?? Promise.resolve(),
        messageLoader.ensure(
          { directory: targetDirectory, sessionID },
          { force, reason },
        ),
      ])
      return messageLoader.getSnapshot({ directory: targetDirectory, sessionID }).status !== "error"
    },
    [childStores, directory, keyFor, messageLoader, resolveDirectory, scheduleBackgroundTrim, sdk, touch],
  )

  // Load more (pagination)
  const loadMore = useCallback(
    async (sessionID: string, options?: { directory?: string | null }) => {
      const targetDirectory = resolveDirectory(options?.directory)
      touch(sessionID, targetDirectory)
      scheduleBackgroundTrim(targetDirectory)
      const state = messageLoader.getSnapshot({ directory: targetDirectory, sessionID })
      if (!state.resolved) {
        await syncSession(sessionID, { directory: targetDirectory, force: true, reason: "force" })
        return
      }
      await messageLoader.loadOlder({ directory: targetDirectory, sessionID })
    },
    [messageLoader, resolveDirectory, scheduleBackgroundTrim, syncSession, touch],
  )

  const hasMore = useCallback(
    (sessionID: string, options?: { directory?: string | null }) => {
      const targetDirectory = resolveDirectory(options?.directory)
      const state = messageLoader.getSnapshot({ directory: targetDirectory, sessionID })
      return !state.complete && Boolean(state.cursor)
    },
    [messageLoader, resolveDirectory],
  )

  const isLoading = useCallback(
    (sessionID: string, options?: { directory?: string | null }) => {
      const targetDirectory = resolveDirectory(options?.directory)
      return messageLoader.getSnapshot({ directory: targetDirectory, sessionID }).status === "loading"
    },
    [messageLoader, resolveDirectory],
  )

  const hasPaginationMetadata = useCallback(
    (sessionID: string, options?: { directory?: string | null }) => {
      const targetDirectory = resolveDirectory(options?.directory)
      return messageLoader.getSnapshot({ directory: targetDirectory, sessionID }).resolved
    },
    [messageLoader, resolveDirectory],
  )

  const prefetchSession = useCallback(
    async (sessionID: string, targetDirectory: string) => {
      if (!sessionID || !targetDirectory || targetDirectory !== directory) return
      await messageLoader.prefetch({ directory: targetDirectory, sessionID })
      if (messageLoader.getSnapshot({ directory: targetDirectory, sessionID }).status === "ready") {
        touch(sessionID, targetDirectory)
        scheduleBackgroundTrim(targetDirectory)
      }
    },
    [directory, messageLoader, scheduleBackgroundTrim, touch],
  )

  useEffect(() => {
    return registerSessionMaterializer(directory, {
      ensureFirstPage: async (sessionID, options) => {
        const ok = await syncSession(sessionID, { force: Boolean(options?.force), directory })
        if (!ok) throw new Error(`Failed to materialize session ${sessionID}`)
      },
      loadOlderMessages: (sessionID) => loadMore(sessionID, { directory }),
      offloadSession: (sessionID) => evict(directory, [sessionID]),
    })
  }, [directory, syncSession, loadMore, evict])

  // Optimistic add (for prompt submission)
  const optimisticAdd = useCallback(
    (input: { sessionID: string; message: Message; parts: Part[]; directory?: string | null }) => {
      const targetDirectory = resolveDirectory(input.directory)
      registerDirectoryTracking(targetDirectory)
      messageLoader.optimisticAdd({
        directory: targetDirectory,
        sessionID: input.sessionID,
        message: input.message,
        parts: input.parts,
      })
    },
    [messageLoader, registerDirectoryTracking, resolveDirectory],
  )

  // Optimistic remove (for rollback on error)
  const optimisticRemove = useCallback(
    (input: { sessionID: string; messageID: string; directory?: string | null }) => {
      const targetDirectory = resolveDirectory(input.directory)
      messageLoader.optimisticRemove({ directory: targetDirectory, sessionID: input.sessionID, messageID: input.messageID })
    },
    [messageLoader, resolveDirectory],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      prefetchSession,
      resyncSession,
      loadMore,
      hasMore,
      isLoading,
      hasPaginationMetadata,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
      },
    }),
    [syncSession, prefetchSession, resyncSession, loadMore, hasMore, isLoading, hasPaginationMetadata, optimisticAdd, optimisticRemove],
  )
}
