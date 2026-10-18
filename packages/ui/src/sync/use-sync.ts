import { useCallback, useMemo } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  useSyncDirectory,
  useSyncResyncSession,
  useSessionHistory,
} from "./sync-context"

// ---------------------------------------------------------------------------
// useSync — message loading, pagination, optimistic updates
// A stateless view of the provider-owned SessionHistory: every caller shares
// one owner, so mounting or unmounting a caller acquires and releases nothing.
// ---------------------------------------------------------------------------

export function useSync() {
  const directory = useSyncDirectory()
  const history = useSessionHistory()
  const resyncSession = useSyncResyncSession()

  const resolveDirectory = useCallback((override?: string | null) => override || directory, [directory])

  const syncSession = useCallback(
    (
      sessionID: string,
      options?: boolean | {
        force?: boolean
        directory?: string | null
        reason?: "selected" | "reactive" | "force"
      },
    ) => {
      const force = typeof options === "boolean" ? options : options?.force === true
      const reason = typeof options === "object" ? options.reason : undefined
      const targetDirectory = resolveDirectory(typeof options === "object" ? options.directory : null)
      return history.ensureRenderable({ directory: targetDirectory, sessionID }, { force, reason })
    },
    [history, resolveDirectory],
  )

  const loadMore = useCallback(
    (sessionID: string, options?: { directory?: string | null }) =>
      history.loadMore({ directory: resolveDirectory(options?.directory), sessionID }),
    [history, resolveDirectory],
  )

  const hasMore = useCallback(
    (sessionID: string, options?: { directory?: string | null }) =>
      history.hasMore({ directory: resolveDirectory(options?.directory), sessionID }),
    [history, resolveDirectory],
  )

  const isLoading = useCallback(
    (sessionID: string, options?: { directory?: string | null }) =>
      history.isLoading({ directory: resolveDirectory(options?.directory), sessionID }),
    [history, resolveDirectory],
  )

  const hasPaginationMetadata = useCallback(
    (sessionID: string, options?: { directory?: string | null }) =>
      history.hasPaginationMetadata({ directory: resolveDirectory(options?.directory), sessionID }),
    [history, resolveDirectory],
  )

  const prefetchSession = useCallback(
    async (sessionID: string, targetDirectory: string) => {
      if (!sessionID || !targetDirectory || targetDirectory !== directory) return
      await history.prefetch({ directory: targetDirectory, sessionID })
    },
    [directory, history],
  )

  // Optimistic add (for prompt submission)
  const optimisticAdd = useCallback(
    (input: { sessionID: string; message: Message; parts: Part[]; directory?: string | null }) => {
      history.optimisticAdd({
        directory: resolveDirectory(input.directory),
        sessionID: input.sessionID,
        message: input.message,
        parts: input.parts,
      })
    },
    [history, resolveDirectory],
  )

  // Optimistic remove (for rollback on error)
  const optimisticRemove = useCallback(
    (input: { sessionID: string; messageID: string; directory?: string | null }) => {
      history.optimisticRemove({
        directory: resolveDirectory(input.directory),
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
    },
    [history, resolveDirectory],
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
