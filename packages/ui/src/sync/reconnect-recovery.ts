import type { SessionStatus, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import { filterSessionStatusThroughAbortGuard } from "./abort-retry-guard"
import { getSessionMaterializationStatus } from "./materialization"
import { shouldSettleTerminalSessionStatus } from "./plan-idle-settlement"
import type { State } from "./types"

export { unwrapSdkResult } from "./sdk-result"

export const ACTIVE_SESSION_STATUS_STALE_MS = 20_000
export const ACTIVE_SESSION_RECOVERY_COOLDOWN_MS = 15_000

type ReconnectMaterializationState = {
  session: Session[]
  session_status?: Record<string, SessionStatus>
  message?: Record<string, Message[]>
  part?: Record<string, Part[]>
}

type RecoveredSessionStatusState = Pick<
  State,
  "message" | "part" | "permission" | "question" | "session" | "session_status" | "revert_transaction"
>

export type ViewedSessionMaterializationTarget = {
  directory: string
  sessionId: string
}

type ReconnectCandidateOptions = {
  directory?: string
  viewedSession?: ViewedSessionMaterializationTarget | null
}

export function getReconnectCandidateSessionIds(state: ReconnectMaterializationState, options?: ReconnectCandidateOptions) {
  const ids = new Set<string>()

  for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
    if (status && status.type !== "idle") ids.add(sessionId)
  }

  for (const [sessionId, messages] of Object.entries(state.message ?? {})) {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage
      && lastMessage.role === "assistant"
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number"
    ) {
      ids.add(sessionId)
    } else if (!getSessionMaterializationStatus({ message: state.message ?? {}, part: state.part ?? {} }, sessionId).renderable) {
      ids.add(sessionId)
    }
  }

  const parentIds = new Set<string>()
  for (const session of state.session) {
    const parentId = (session as Session & { parentID?: string | null }).parentID
    if (parentId) {
      parentIds.add(parentId)
    }
  }
  for (const pid of parentIds) {
    ids.add(pid)
  }

  const viewedSession = options?.viewedSession
  if (viewedSession?.sessionId && viewedSession.directory === options?.directory) {
    const sessionId = viewedSession.sessionId
    const sessionExists = state.session.some((session) => session.id === sessionId)
      || Object.hasOwn(state.session_status ?? {}, sessionId)
      || Object.hasOwn(state.message ?? {}, sessionId)

    if (sessionExists) {
      ids.add(sessionId)
    }
  }

  return Array.from(ids)
}

type RawSessionStatus = {
  type?: unknown
  attempt?: unknown
  message?: unknown
  next?: unknown
}

export type SessionStatusBaseline = ReadonlyMap<string, SessionStatus | undefined>

const cloneSessionStatus = (status: SessionStatus | undefined): SessionStatus | undefined => (
  status ? { ...status } as SessionStatus : undefined
)

const haveEquivalentSessionStatus = (
  left: SessionStatus | undefined,
  right: SessionStatus | undefined,
): boolean => {
  if (left === right) return true
  if (!left || !right || left.type !== right.type) return false
  if (left.type !== "retry" || right.type !== "retry") return true
  return left.attempt === right.attempt
    && left.message === right.message
    && left.next === right.next
}

export function captureSessionStatusBaseline(
  current: Record<string, SessionStatus>,
  candidateSessionIds: Iterable<string>,
): SessionStatusBaseline {
  const baseline = new Map<string, SessionStatus | undefined>()
  for (const sessionId of candidateSessionIds) {
    baseline.set(sessionId, cloneSessionStatus(current[sessionId]))
  }
  return baseline
}

export function filterUnchangedSessionStatusCandidates(input: {
  current: Record<string, SessionStatus>
  candidateSessionIds: Iterable<string>
  baseline: SessionStatusBaseline
}): string[] {
  const eligible = new Set<string>()
  for (const sessionId of input.candidateSessionIds) {
    if (!input.baseline.has(sessionId)) continue
    if (!haveEquivalentSessionStatus(input.current[sessionId], input.baseline.get(sessionId))) continue
    eligible.add(sessionId)
  }
  return [...eligible]
}

export function toAuthoritativeSessionStatus(status: RawSessionStatus | undefined): SessionStatus | undefined {
  if (!status) return undefined
  if (status.type === "idle" || status.type === "busy") {
    return { type: status.type }
  }
  if (
    status.type === "retry"
    && typeof status.attempt === "number"
    && typeof status.message === "string"
    && typeof status.next === "number"
  ) {
    return {
      type: "retry",
      attempt: status.attempt,
      message: status.message,
      next: status.next,
    } as SessionStatus
  }
  return undefined
}

export function mergeAuthoritativeSessionStatuses(input: {
  current: Record<string, SessionStatus>
  candidateSessionIds: Iterable<string>
  authoritative: Record<string, RawSessionStatus | undefined>
}): Record<string, SessionStatus> {
  let next: Record<string, SessionStatus> | undefined
  for (const sessionId of input.candidateSessionIds) {
    const rawStatus = toAuthoritativeSessionStatus(input.authoritative[sessionId])
    if (!rawStatus) continue
    // Reconnect snapshots go through the same stop-during-retry guard as live
    // events so a user-stopped retry loop cannot resurrect via resync.
    const status = filterSessionStatusThroughAbortGuard(sessionId, rawStatus)
    const currentStatus = input.current[sessionId]
    if (currentStatus === status || currentStatus?.type === status.type) {
      if (status.type !== "retry" || (
        (currentStatus as Extract<SessionStatus, { type: "retry" }> | undefined)?.attempt === status.attempt
        && (currentStatus as Extract<SessionStatus, { type: "retry" }> | undefined)?.message === status.message
        && (currentStatus as Extract<SessionStatus, { type: "retry" }> | undefined)?.next === status.next
      )) {
        continue
      }
    }
    next ??= { ...input.current }
    next[sessionId] = status
  }

  return next ?? input.current
}

export function mergeRecoveredSessionStatuses(input: {
  current: Record<string, SessionStatus>
  candidateSessionIds: Iterable<string>
  authoritative: Record<string, RawSessionStatus | undefined>
  state: RecoveredSessionStatusState
}): Record<string, SessionStatus> {
  let next = mergeAuthoritativeSessionStatuses(input)

  for (const sessionId of input.candidateSessionIds) {
    if (Object.hasOwn(input.authoritative, sessionId)) continue

    const statusType = next[sessionId]?.type
    if (statusType !== "busy" && statusType !== "retry") continue
    if (!shouldSettleTerminalSessionStatus({ sessionID: sessionId, state: input.state })) continue

    if (next === input.current) {
      next = { ...input.current }
    }
    next[sessionId] = { type: "idle" } as SessionStatus
  }

  return next
}

export function shouldRecoverStaleActiveSession(input: {
  status: SessionStatus | undefined
  now?: number
  lastStatusEventAt?: number
  lastOutputEventAt?: number
  lastRecoveryAt?: number
  staleMs?: number
  cooldownMs?: number
}): boolean {
  const statusType = input.status?.type
  if (statusType !== "busy" && statusType !== "retry") {
    return false
  }

  const now = input.now ?? Date.now()
  const staleMs = input.staleMs ?? ACTIVE_SESSION_STATUS_STALE_MS
  const cooldownMs = input.cooldownMs ?? ACTIVE_SESSION_RECOVERY_COOLDOWN_MS
  const observedEventTimes = [
    input.lastStatusEventAt,
    input.lastOutputEventAt,
  ].filter((value): value is number => typeof value === "number")
  const lastObservedEventAt = observedEventTimes.length > 0
    ? Math.max(...observedEventTimes)
    : now

  if (now - lastObservedEventAt < staleMs) {
    return false
  }

  if (typeof input.lastRecoveryAt === "number" && now - input.lastRecoveryAt < cooldownMs) {
    return false
  }

  return true
}
