import type { SessionLineageEntry } from "@/lib/sessionLineage"
import { collectSessionIndicatorScopeIds } from "@/components/session/sidebar/sessionIndicator"

export type SessionStatusType = "idle" | "busy" | "retry" | "blocked" | "unknown"
type LiveStatus = { readonly type?: unknown }

export type QueuedSessionDispatchState = {
  queueLength: number
  currentStatus: SessionStatusType
  previousStatus?: SessionStatusType
  isConnected: boolean
  previousConnectionState?: boolean
}

export function shouldDispatchQueuedSession(state: QueuedSessionDispatchState): boolean {
  if (state.queueLength === 0 || !state.isConnected || state.currentStatus !== "idle") {
    return false
  }

  const firstSeenIdle = state.previousStatus === undefined
  const becameIdle = state.previousStatus !== undefined && state.previousStatus !== "idle"
  const connectionRestored = state.previousConnectionState === false

  return firstSeenIdle || becameIdle || connectionRestored
}

export function resolveQueuedSessionStatusType(
  sessionId: string,
  liveStatuses: Record<string, LiveStatus | undefined>,
): SessionStatusType {
  const status = liveStatuses[sessionId]
  if (!status) return "unknown"
  const type = status.type
  return type === "busy" || type === "retry" || type === "idle" ? type : "unknown"
}

export function resolveQueuedAutoSendStatusType(
  sessionId: string,
  liveStatuses: Record<string, LiveStatus | undefined>,
  anyDirectoryStatus?: LiveStatus,
  blockingRequestCount = 0,
): SessionStatusType {
  if (blockingRequestCount > 0) {
    return "blocked"
  }
  const anyDirectoryType = anyDirectoryStatus?.type
  if (anyDirectoryType === "busy" || anyDirectoryType === "retry") {
    return anyDirectoryType
  }
  if (anyDirectoryStatus) {
    return anyDirectoryType === "idle" ? "idle" : "unknown"
  }
  if (!Object.prototype.hasOwnProperty.call(liveStatuses, sessionId)) {
    return "unknown"
  }
  return resolveQueuedSessionStatusType(sessionId, liveStatuses)
}

/** Loaded lineage is only a renderer readiness hint; native admission checks
 * the complete canonical subtree before accepting or delivering the input. */
export function resolveQueuedSessionScopeIds(sessionId: string, sessions: readonly SessionLineageEntry[]): string[] | null {
  const root = sessions.find(session => session.id === sessionId)
  if (!root) return null
  if (root.parentID) return [sessionId]
  const children = new Map<string, SessionLineageEntry[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const siblings = children.get(session.parentID) ?? []
    siblings.push(session)
    children.set(session.parentID, siblings)
  }
  const scope = collectSessionIndicatorScopeIds(sessionId, children)
  return scope.length <= 512 ? scope.sort() : null
}

export function resolveQueuedSubtreeStatusType(
  scope: readonly string[] | null | undefined,
  liveStatuses: Record<string, LiveStatus | undefined>,
  anyDirectoryStatus: (sessionId: string) => LiveStatus | undefined,
  blockingRequestCount: (sessionId: string) => number,
): SessionStatusType {
  if (!scope?.length) return "unknown"
  for (const sessionId of scope) {
    const status = resolveQueuedAutoSendStatusType(sessionId, liveStatuses, anyDirectoryStatus(sessionId), blockingRequestCount(sessionId))
    if (status !== "idle") return status
  }
  return "idle"
}
