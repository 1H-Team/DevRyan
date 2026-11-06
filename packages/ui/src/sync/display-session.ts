import type { Session } from "@opencode-ai/sdk/v2/client"
import type { DisplaySession, SessionFork, SessionOutcome } from "./types"

/**
 * The decode boundary for session records entering the UI stores from events
 * and REST reads. Native lifecycle facts (`time.busy`, `time.idle`,
 * `time.viewed`, `outcome`, `fork`) are display metadata: they never decide
 * running state (`session.status`), unread state (`notification-store.ts`) or
 * managed verification.
 */

export type SessionLifecycle = {
  busy?: number
  idle?: number
  viewed?: number
  outcome?: SessionOutcome
  fork?: SessionFork
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
)

export const isSessionLifecycleTimestamp = (value: unknown): value is number => (
  typeof value === "number" && Number.isFinite(value) && value >= 0
)

export const isSessionOutcome = (value: unknown): value is SessionOutcome => (
  value === "succeeded" || value === "failed" || value === "interrupted"
)

export const isSessionFork = (value: unknown): value is SessionFork => {
  if (!isRecord(value) || typeof value.sessionID !== "string" || value.sessionID.length === 0) return false
  const boundary = value.boundary
  return isRecord(boundary)
    && (boundary.type === "before" || boundary.type === "through")
    && typeof boundary.messageID === "string"
    && boundary.messageID.length > 0
}

/** The record identity every session consumer relies on: a non-empty id and a time object. */
const isSessionRecord = (value: unknown): value is Session => (
  isRecord(value)
  && typeof value.id === "string"
  && value.id.length > 0
  && isRecord(value.time)
)

/** Reads the valid lifecycle facts of a record; invalid values read as absent. */
export const readSessionLifecycle = (session: DisplaySession): SessionLifecycle => {
  const lifecycle: SessionLifecycle = {}
  const time = session.time
  if (isSessionLifecycleTimestamp(time?.busy)) lifecycle.busy = time.busy
  if (isSessionLifecycleTimestamp(time?.idle)) lifecycle.idle = time.idle
  if (isSessionLifecycleTimestamp(time?.viewed)) lifecycle.viewed = time.viewed
  if (isSessionOutcome(session.outcome)) lifecycle.outcome = session.outcome
  if (isSessionFork(session.fork)) lifecycle.fork = session.fork
  return lifecycle
}

const hasInvalidLifecycleField = (session: DisplaySession): boolean => {
  if ((session.outcome !== undefined && !isSessionOutcome(session.outcome))
    || (session.fork !== undefined && !isSessionFork(session.fork))) {
    return true
  }
  const time = session.time
  if (!isRecord(time)) return false
  return (time.busy !== undefined && !isSessionLifecycleTimestamp(time.busy))
    || (time.idle !== undefined && !isSessionLifecycleTimestamp(time.idle))
    || (time.viewed !== undefined && !isSessionLifecycleTimestamp(time.viewed))
}

const sameFork = (left: SessionFork | undefined, right: SessionFork | undefined): boolean => (
  left === right
  || (
    left !== undefined
    && right !== undefined
    && left.sessionID === right.sessionID
    && left.boundary.type === right.boundary.type
    && left.boundary.messageID === right.boundary.messageID
  )
)

export const sameSessionLifecycle = (left: SessionLifecycle, right: SessionLifecycle): boolean => (
  left.busy === right.busy
  && left.idle === right.idle
  && left.viewed === right.viewed
  && left.outcome === right.outcome
  && sameFork(left.fork, right.fork)
)

/**
 * Returns `session` with exactly `lifecycle` as its lifecycle facts. The same
 * reference comes back when nothing changes, so equal merges stay no-ops.
 */
export const withSessionLifecycle = (session: DisplaySession, lifecycle: SessionLifecycle): DisplaySession => {
  if (!hasInvalidLifecycleField(session) && sameSessionLifecycle(readSessionLifecycle(session), lifecycle)) {
    return session
  }
  const time: DisplaySession["time"] = { ...session.time }
  if (lifecycle.busy === undefined) delete time.busy
  else time.busy = lifecycle.busy
  if (lifecycle.idle === undefined) delete time.idle
  else time.idle = lifecycle.idle
  if (lifecycle.viewed === undefined) delete time.viewed
  else time.viewed = lifecycle.viewed
  const next: DisplaySession = { ...session, time }
  if (lifecycle.outcome === undefined) delete next.outcome
  else next.outcome = lifecycle.outcome
  if (lifecycle.fork === undefined) delete next.fork
  else next.fork = lifecycle.fork
  return next
}

/**
 * Decodes an untrusted session payload. Returns null for a value without a
 * session identity; otherwise the record with invalid lifecycle values
 * dropped. A record whose lifecycle facts are all valid or absent comes back
 * as the same reference.
 */
export const decodeDisplaySession = (value: unknown): DisplaySession | null => {
  if (!isSessionRecord(value)) return null
  const session: DisplaySession = value
  if (!hasInvalidLifecycleField(session)) return session
  return withSessionLifecycle(session, readSessionLifecycle(session))
}

/** Decodes the `info` record of a `session.created` / `session.updated` payload. */
export const decodeSessionEventInfo = (properties: unknown): DisplaySession | null => (
  isRecord(properties) ? decodeDisplaySession(properties.info) : null
)

/** Decodes a REST session list, dropping entries without a session identity. */
export const decodeDisplaySessionList = (values: unknown): DisplaySession[] => {
  if (!Array.isArray(values)) return []
  const sessions: DisplaySession[] = []
  for (const value of values) {
    const session = decodeDisplaySession(value)
    if (session) sessions.push(session)
  }
  return sessions
}
