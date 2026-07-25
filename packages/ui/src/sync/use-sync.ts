import { useCallback, useEffect, useRef, useMemo } from "react"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { ChildStoreManager } from "./child-store"
import { Binary } from "./binary"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import {
  mergeOptimisticPage,
  type OptimisticItem,
} from "./optimistic"
import { useSyncSDK, useSyncDirectory, useChildStoreManager, useSyncResyncSession } from "./sync-context"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"
import { stripMessageDiffSnapshots } from "./sanitize"
import { updateSessionUserActivityFromMessages } from "./session-user-activity"
import {
  shouldSkipSessionPrefetch,
  captureSessionPrefetchRevision,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  releaseSessionPrefetchRevision,
  setSessionPrefetch,
  clearSessionPrefetch,
} from "./session-prefetch-cache"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import {
  registerSessionMaterializer,
} from "./session-materializer"
import { hasMessageRecordInfo, normalizeMessageFetchLimit, unwrapMessageRecordsResult } from "./message-fetch"
import { unwrapSdkResult } from "./sdk-result"
import { opencodeClient } from "@/lib/opencode/client"
import {
  clearSessionMessagePagination,
  getSessionMessagePagination,
  isSessionMessageLoadCurrent,
  runSessionMessageLoad,
  setSessionMessagePagination,
} from "./message-pagination-store"
import {
  normalizeChatOwnedDiffSummary,
  stripUntrustedSessionDiffSummary,
  type SessionSummaryDiffStats,
} from "@/lib/sessionDiffStats"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const MESSAGE_PAGE_SIZE = 200
const MAX_SEEN_DIRS = 30
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function filterRenderableParts(parts: Part[]) {
  return parts.filter((p) => !!p?.id)
}

function normalizeSessionDiffSummaryFromMessages(
  sessions: Session[],
  sessionID: string,
  messages: Message[],
): Session[] {
  const result = Binary.search(sessions, sessionID, (session) => session.id)
  if (!result.found) return sessions

  const session = sessions[result.index]
  const nextSession = normalizeChatOwnedDiffSummary(
    session as Session & { summary?: SessionSummaryDiffStats | null },
    messages as Array<Message & { summary?: SessionSummaryDiffStats | null }>,
  ) as Session
  if (nextSession === session) return sessions

  const nextSessions = [...sessions]
  nextSessions[result.index] = nextSession
  return nextSessions
}

// ---------------------------------------------------------------------------
// useSync — message loading, pagination, optimistic updates
// Message loading, pagination, optimistic updates
// ---------------------------------------------------------------------------

export function useSync() {
  const sdk = useSyncSDK()
  const directory = useSyncDirectory()
  const childStores = useChildStoreManager()
  const resyncSession = useSyncResyncSession()

  // Refs for mutable tracking (no re-renders)
  const inflight = useRef(new Map<string, Promise<boolean>>())
  const optimistic = useRef(new Map<string, Map<string, OptimisticItem>>())
  const seen = useRef(new Map<string, Set<string>>())
  const directoryDisposerUnregisters = useRef(new Map<string, () => void>())

  const clearDirectoryTracking = useCallback((targetDirectory: string) => {
    const prefix = `${targetDirectory}\n`
    for (const key of inflight.current.keys()) {
      if (key.startsWith(prefix)) inflight.current.delete(key)
    }
    for (const key of optimistic.current.keys()) {
      if (key.startsWith(prefix)) optimistic.current.delete(key)
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

  const getMetaFor = useCallback(
    (sessionID: string, directoryOverride?: string | null) => (
      getSessionMessagePagination(resolveDirectory(directoryOverride), sessionID)
    ),
    [resolveDirectory],
  )

  const setMetaFor = useCallback(
    (sessionID: string, patch: Partial<{ limit: number; cursor: string | undefined; complete: boolean; loading: boolean; initialized: boolean }>, directoryOverride?: string | null) => {
      setSessionMessagePagination(resolveDirectory(directoryOverride), sessionID, patch)
    },
    [resolveDirectory],
  )

  const reconcileSupersededLoad = useCallback((
    sessionID: string,
    targetDirectory: string,
    targetStore: ReturnType<ChildStoreManager["ensureChild"]>,
  ): boolean => {
    if (childStores.getChild(targetDirectory) !== targetStore) return false
    const latest = getSessionPrefetch(targetDirectory, sessionID)
    if (!latest) {
      clearSessionMessagePagination(targetDirectory, [sessionID])
      return false
    }
    setMetaFor(sessionID, {
      limit: latest.limit,
      cursor: latest.cursor,
      complete: latest.complete,
      loading: false,
      initialized: true,
    }, targetDirectory)
    return true
  }, [childStores, setMetaFor])

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

      // Clear meta + optimistic + prefetch cache for evicted sessions
      for (const id of sessionIDs) {
        optimistic.current.delete(`${dir}\n${id}`)
      }
      clearSessionMessagePagination(dir, sessionIDs)
      clearSessionPrefetch(dir, sessionIDs)
    },
    [childStores],
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
      const targetStore = childStores.ensureChild(targetDirectory)
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

  // Optimistic operations
  const getOptimistic = useCallback(
    (sessionID: string, directoryOverride?: string | null): OptimisticItem[] => {
      const key = `${resolveDirectory(directoryOverride)}\n${sessionID}`
      return [...(optimistic.current.get(key)?.values() ?? [])]
    },
    [resolveDirectory],
  )

  const setOptimistic = useCallback(
    (sessionID: string, item: OptimisticItem, directoryOverride?: string | null) => {
      const key = `${resolveDirectory(directoryOverride)}\n${sessionID}`
      const list = optimistic.current.get(key)
      const sorted: OptimisticItem = { message: item.message, parts: filterRenderableParts(item.parts) }
      if (list) {
        list.set(item.message.id, sorted)
      } else {
        optimistic.current.set(key, new Map([[item.message.id, sorted]]))
      }
    },
    [resolveDirectory],
  )

  const clearOptimistic = useCallback(
    (sessionID: string, messageID?: string, directoryOverride?: string | null) => {
      const key = `${resolveDirectory(directoryOverride)}\n${sessionID}`
      if (!messageID) {
        optimistic.current.delete(key)
        return
      }
      const list = optimistic.current.get(key)
      if (!list) return
      list.delete(messageID)
      if (list.size === 0) optimistic.current.delete(key)
    },
    [resolveDirectory],
  )

  // Fetch messages from API
  const fetchMessages = useCallback(
    async (sessionID: string, limit: number, before?: string, directoryOverride?: string | null) => {
      const targetDirectory = resolveDirectory(directoryOverride)
      const targetSdk = targetDirectory === directory ? sdk : opencodeClient.getScopedSdkClient(targetDirectory)
      const normalizedLimit = normalizeMessageFetchLimit(limit, MESSAGE_PAGE_SIZE)
      const result = await retry(async () => {
        const response = await targetSdk.session.messages({ sessionID, limit: normalizedLimit, before })
        return {
          data: unwrapMessageRecordsResult(response),
          response: response.response,
        }
      })
      const items = result.data.filter(hasMessageRecordInfo)
      const session = items
        .map((x) => stripMessageDiffSnapshots(x.info))
        .sort((a: Message, b: Message) => cmp(a.id, b.id))
      const part = items.map((x) => ({
        id: x.info.id,
        part: filterRenderableParts(x.parts ?? []),
      }))
      const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
      return { session, part, cursor, complete: !cursor }
    },
    [directory, resolveDirectory, sdk],
  )

  // Load messages for a session
  const loadMessages = useCallback(
    async (sessionID: string, options?: { before?: string; mode?: "replace" | "prepend"; directory?: string | null }) => {
      const targetDirectory = resolveDirectory(options?.directory)
      const targetStore = childStores.ensureChild(targetDirectory)
      registerDirectoryTracking(targetDirectory)
      return runSessionMessageLoad({
        directory: targetDirectory,
        sessionID,
        task: async (loadToken) => {
          const m = getMetaFor(sessionID, targetDirectory)
          setMetaFor(sessionID, { loading: true }, targetDirectory)
          const prefetchRevision = captureSessionPrefetchRevision(targetDirectory, sessionID)

          try {
            const limit = normalizeMessageFetchLimit(m.limit, MESSAGE_PAGE_SIZE)
            const page = await fetchMessages(sessionID, limit, options?.before, targetDirectory)
            if (
              childStores.getChild(targetDirectory) !== targetStore
              || !isSessionMessageLoadCurrent(targetDirectory, sessionID, loadToken)
            ) {
              releaseSessionPrefetchRevision(targetDirectory, sessionID, prefetchRevision)
              return false
            }
            if (!isSessionPrefetchCurrent(targetDirectory, sessionID, prefetchRevision)) {
              releaseSessionPrefetchRevision(targetDirectory, sessionID, prefetchRevision)
              return reconcileSupersededLoad(sessionID, targetDirectory, targetStore)
            }

            // Merge optimistic items
            const items = getOptimistic(sessionID, targetDirectory)
            const merged = mergeOptimisticPage(page, items)
            for (const messageID of merged.confirmed) {
              clearOptimistic(sessionID, messageID, targetDirectory)
            }

            const current = targetStore.getState()
            const materialized = materializeSessionSnapshots(
              current,
              sessionID,
              merged.session.map((info) => ({
                info,
                parts: merged.part.find((item) => item.id === info.id)?.part ?? [],
              })),
              { skipPartTypes: SKIP_PARTS, mode: options?.mode === "prepend" ? "prepend" : "merge" },
            )

            const draft = {
              ...current,
              message: materialized.message,
              part: materialized.part,
              session_user_activity: current.session_user_activity,
            }
            const activityChanged = updateSessionUserActivityFromMessages(draft, sessionID)
            const normalizedSessions = normalizeSessionDiffSummaryFromMessages(current.session, sessionID, materialized.messages)
            targetStore.setState({
              message: materialized.message,
              part: materialized.part,
              ...(normalizedSessions !== current.session ? { session: normalizedSessions } : {}),
              ...(activityChanged ? { session_user_activity: draft.session_user_activity } : {}),
            })
            setMetaFor(sessionID, {
              limit: normalizeMessageFetchLimit(materialized.messages.length, limit),
              cursor: merged.cursor,
              complete: merged.complete,
              loading: false,
              initialized: true,
            }, targetDirectory)
            setSessionPrefetch({
              directory: targetDirectory,
              sessionID,
              limit: normalizeMessageFetchLimit(materialized.messages.length, limit),
              cursor: merged.cursor,
              complete: merged.complete,
              revision: prefetchRevision,
            })
            return true
          } catch {
            const current = isSessionPrefetchCurrent(targetDirectory, sessionID, prefetchRevision)
            releaseSessionPrefetchRevision(targetDirectory, sessionID, prefetchRevision)
            if (!current) return reconcileSupersededLoad(sessionID, targetDirectory, targetStore)
            if (
              childStores.getChild(targetDirectory) !== targetStore
              || !isSessionMessageLoadCurrent(targetDirectory, sessionID, loadToken)
            ) return false
            setMetaFor(sessionID, { loading: false }, targetDirectory)
            return false
          }
        },
      })
    },
    [childStores, fetchMessages, getMetaFor, setMetaFor, getOptimistic, clearOptimistic, resolveDirectory, registerDirectoryTracking, reconcileSupersededLoad],
  )

  // Sync a session (load if not cached)
  const syncSession = useCallback(
    async (sessionID: string, options?: boolean | { force?: boolean; directory?: string | null }) => {
      const force = typeof options === "boolean" ? options : options?.force === true
      const targetDirectory = resolveDirectory(typeof options === "object" ? options.directory : null)
      const targetStore = childStores.ensureChild(targetDirectory)
      const targetSdk = targetDirectory === directory ? sdk : opencodeClient.getScopedSdkClient(targetDirectory)
      touch(sessionID, targetDirectory)
      const key = keyFor(sessionID, targetDirectory)

      // Dedup inflight requests
      const existing = inflight.current.get(key)
      if (existing) return existing

      const current = targetStore.getState()
      let m = getMetaFor(sessionID, targetDirectory)
      const materialization = getSessionMaterializationStatus(current, sessionID)
      const prefetchInfo = getSessionPrefetch(targetDirectory, sessionID)
      if (!m.initialized && prefetchInfo) {
        setMetaFor(sessionID, {
          limit: prefetchInfo.limit,
          cursor: prefetchInfo.cursor,
          complete: prefetchInfo.complete,
          loading: false,
          initialized: true,
        }, targetDirectory)
        m = getMetaFor(sessionID, targetDirectory)
      }
      const cached = materialization.hasMessages && materialization.renderable && m.limit > 0 && m.initialized
      const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
      if (cached && hasSession && !force) return true

      // Skip if recently fetched (TTL)
      if (!force) {
        if (shouldSkipSessionPrefetch({
          hasMessages: cached,
          info: prefetchInfo,
          pageSize: MESSAGE_PAGE_SIZE,
        })) return true
      }

      const promise = (async () => {
        // Fetch session info if needed
        if (!hasSession || force) {
          try {
            const result = await retry(() =>
              targetSdk.session.get({ sessionID }).then((response) => unwrapSdkResult(response, "session.get")),
            )
            if (childStores.getChild(targetDirectory) !== targetStore) {
              return false
            }
            if (result) {
              const s = targetStore.getState()
              const sessions = [...s.session]
              const idx = Binary.search(sessions, sessionID, (s) => s.id)
              const cachedMessages = s.message[sessionID]
              const normalizedResult = cachedMessages
                ? normalizeChatOwnedDiffSummary(
                  result as Session & { summary?: SessionSummaryDiffStats | null },
                  cachedMessages as Array<Message & { summary?: SessionSummaryDiffStats | null }>,
                ) as Session
                : stripUntrustedSessionDiffSummary(result as Session & { summary?: SessionSummaryDiffStats | null }) as Session
              if (idx.found) {
                sessions[idx.index] = normalizedResult
              } else {
                sessions.splice(idx.index, 0, normalizedResult)
              }
              targetStore.setState({ session: sessions })
            }
          } catch (e) {
            console.error("[sync] failed to fetch session", sessionID, e)
          }
        }

        // Load messages if needed
        if (!cached || force) {
          return await loadMessages(sessionID, { directory: targetDirectory })
        }

        return true
      })()

      inflight.current.set(key, promise)
      promise.finally(() => {
        if (inflight.current.get(key) === promise) {
          inflight.current.delete(key)
        }
      })
      return promise
    },
    [childStores, directory, sdk, resolveDirectory, keyFor, touch, getMetaFor, setMetaFor, loadMessages],
  )

  // Load more (pagination)
  const loadMore = useCallback(
    async (sessionID: string, options?: { directory?: string | null }) => {
      const targetDirectory = resolveDirectory(options?.directory)
      touch(sessionID, targetDirectory)
      const m = getMetaFor(sessionID, targetDirectory)
      if (m.loading || m.complete) return
      if (!m.cursor) {
        await syncSession(sessionID, { directory: targetDirectory, force: true })
        return
      }
      await loadMessages(sessionID, { before: m.cursor, mode: "prepend", directory: targetDirectory })
    },
    [resolveDirectory, touch, getMetaFor, loadMessages, syncSession],
  )

  const hasMore = useCallback(
    (sessionID: string, options?: { directory?: string | null }) => {
      const m = getMetaFor(sessionID, options?.directory)
      return !m.complete && !!m.cursor
    },
    [getMetaFor],
  )

  const isLoading = useCallback(
    (sessionID: string, options?: { directory?: string | null }) => getMetaFor(sessionID, options?.directory).loading,
    [getMetaFor],
  )

  const hasPaginationMetadata = useCallback(
    (sessionID: string, options?: { directory?: string | null }) => getMetaFor(sessionID, options?.directory).initialized,
    [getMetaFor],
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
      const targetStore = childStores.ensureChild(targetDirectory)
      registerDirectoryTracking(targetDirectory)
      setOptimistic(input.sessionID, { message: input.message, parts: input.parts }, targetDirectory)
      const current = targetStore.getState()
      const message = { ...current.message }
      const part = { ...current.part }

      // Insert message
      const messages = message[input.sessionID] ? [...message[input.sessionID]] : []
      const result = Binary.search(messages, input.message.id, (m) => m.id)
      if (!result.found) messages.splice(result.index, 0, input.message)
      message[input.sessionID] = messages

      // Insert parts
      part[input.message.id] = filterRenderableParts(input.parts)

      const draft = {
        ...current,
        message,
        part,
        session_user_activity: current.session_user_activity,
      }
      const activityChanged = updateSessionUserActivityFromMessages(draft, input.sessionID)
      targetStore.setState({
        message,
        part,
        ...(activityChanged ? { session_user_activity: draft.session_user_activity } : {}),
      })
    },
    [childStores, resolveDirectory, setOptimistic, registerDirectoryTracking],
  )

  // Optimistic remove (for rollback on error)
  const optimisticRemove = useCallback(
    (input: { sessionID: string; messageID: string; directory?: string | null }) => {
      const targetDirectory = resolveDirectory(input.directory)
      const targetStore = childStores.ensureChild(targetDirectory)
      clearOptimistic(input.sessionID, input.messageID, targetDirectory)
      const current = targetStore.getState()
      const message = { ...current.message }
      const part = { ...current.part }

      const messages = message[input.sessionID]
      if (messages) {
        const next = [...messages]
        const result = Binary.search(next, input.messageID, (m) => m.id)
        if (result.found) {
          next.splice(result.index, 1)
          message[input.sessionID] = next
        }
      }
      delete part[input.messageID]

      const draft = {
        ...current,
        message,
        part,
        session_user_activity: current.session_user_activity,
      }
      const activityChanged = updateSessionUserActivityFromMessages(draft, input.sessionID)
      targetStore.setState({
        message,
        part,
        ...(activityChanged ? { session_user_activity: draft.session_user_activity } : {}),
      })
    },
    [childStores, resolveDirectory, clearOptimistic],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
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
    [syncSession, resyncSession, loadMore, hasMore, isLoading, hasPaginationMetadata, optimisticAdd, optimisticRemove],
  )
}
