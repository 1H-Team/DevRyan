import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

export type SessionStatusType = "idle" | "busy" | "retry" | "blocked" | "unknown"

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
  liveStatuses: Record<string, SessionStatus | undefined>,
): SessionStatusType {
  const status = liveStatuses[sessionId]
  if (!status) return "unknown"
  const type = status.type
  return type === "busy" || type === "retry" ? type : "idle"
}

export function resolveQueuedAutoSendStatusType(
  sessionId: string,
  liveStatuses: Record<string, SessionStatus | undefined>,
  anyDirectoryStatus?: SessionStatus,
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
    return "idle"
  }
  if (!Object.prototype.hasOwnProperty.call(liveStatuses, sessionId)) {
    return "unknown"
  }
  return resolveQueuedSessionStatusType(sessionId, liveStatuses)
}
