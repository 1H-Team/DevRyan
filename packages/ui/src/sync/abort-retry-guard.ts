/**
 * Abort-retry guard — makes a manual Stop stick when OpenCode is in a
 * provider retry loop (rate limit / out of usage).
 *
 * OpenCode ignores `session.abort` while it sleeps between retry attempts
 * (there is no in-flight request to cancel) and keeps emitting
 * `session.status: retry` events. Without this guard the UI flips back to
 * "Retrying…" right after the user stops the session, and the next backoff
 * fires another attempt with the same model.
 *
 * The guard is intentionally narrow:
 * - It activates only for sessions the user explicitly aborted.
 * - It is time-bounded (TTL); once the window expires, live server state wins.
 * - It clears immediately on an authoritative idle status or a new local send.
 *
 * While active it does two things:
 * 1. Suppresses `retry` statuses for the aborted session so the UI stays idle.
 * 2. Re-issues `session.abort` (bounded + debounced) when a `retry`/`busy`
 *    status arrives — catching the moment a retry attempt actually fires,
 *    when abort can take effect server-side.
 */

import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

export const ABORT_GUARD_TTL_MS = 60_000
export const ABORT_GUARD_MAX_REABORTS = 3
export const ABORT_GUARD_REABORT_DEBOUNCE_MS = 1_000

const EPOCH_SECONDS_THRESHOLD = 1_000_000_000
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000

interface AbortGuardRecord {
  directory?: string
  expiresAt: number
  reabortCount: number
  lastReabortAt: number
  retryAttempt?: number
  retryNext?: number
  retryTargetAt?: number
}

type AbortGuardExecutor = (sessionId: string, directory?: string) => Promise<unknown>

const records = new Map<string, AbortGuardRecord>()
let abortExecutor: AbortGuardExecutor | null = null

/**
 * Injected by the sync layer (session-actions) so this module does not need to
 * import SDK accessors directly. Tests can leave it unset or stub it.
 */
export function setAbortGuardExecutor(executor: AbortGuardExecutor | null): void {
  abortExecutor = executor
}

function addWithSafeUpperBound(value: number, amount: number): number {
  if (value >= Number.MAX_SAFE_INTEGER - amount) {
    return Number.MAX_SAFE_INTEGER
  }
  return value + amount
}

function normalizeRetryTargetAt(next: number, now: number): number | undefined {
  if (!Number.isFinite(next) || next <= 0) return undefined
  if (next >= EPOCH_MILLISECONDS_THRESHOLD) return next
  if (next >= EPOCH_SECONDS_THRESHOLD) {
    const milliseconds = next * 1_000
    return Number.isFinite(milliseconds) ? milliseconds : undefined
  }
  return addWithSafeUpperBound(now, next)
}

function extendGuardThroughRetry(record: AbortGuardRecord, status: SessionStatus, now: number): void {
  if (status.type !== "retry") return

  let retryTargetAt = record.retryTargetAt
  if (record.retryAttempt !== status.attempt || record.retryNext !== status.next || retryTargetAt === undefined) {
    retryTargetAt = normalizeRetryTargetAt(status.next, now)
    record.retryAttempt = status.attempt
    record.retryNext = status.next
    record.retryTargetAt = retryTargetAt
  }
  if (retryTargetAt === undefined) return

  record.expiresAt = Math.max(
    record.expiresAt,
    addWithSafeUpperBound(retryTargetAt, ABORT_GUARD_TTL_MS),
  )
}

/** Record that the user, a user-initiated flow, or manual provider recovery stopped this session. */
export function registerManualAbortGuard(
  sessionId: string,
  directory?: string,
  status?: SessionStatus,
  now: number = Date.now(),
): void {
  if (!sessionId) return
  const record: AbortGuardRecord = {
    directory,
    expiresAt: addWithSafeUpperBound(now, ABORT_GUARD_TTL_MS),
    reabortCount: 0,
    lastReabortAt: 0,
  }
  if (status) {
    extendGuardThroughRetry(record, status, now)
  }
  records.set(sessionId, record)
}

/** Clear the guard — authoritative idle arrived or a new local send started. */
export function clearAbortGuard(sessionId: string): void {
  records.delete(sessionId)
}

export function clearAbortGuards(sessionIds: Iterable<string>): void {
  for (const sessionId of sessionIds) {
    records.delete(sessionId)
  }
}

/** Test/HMR helper. */
export function resetAbortGuardState(): void {
  records.clear()
}

export function isAbortGuardActive(sessionId: string, now: number = Date.now()): boolean {
  const record = records.get(sessionId)
  if (!record) return false
  if (now > record.expiresAt) {
    records.delete(sessionId)
    return false
  }
  return true
}

export async function waitForAbortGuardSettlement(
  sessionId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? ABORT_GUARD_TTL_MS
  const pollMs = options.pollMs ?? 100
  const deadline = Date.now() + timeoutMs
  while (isAbortGuardActive(sessionId)) {
    if (Date.now() >= deadline) {
      throw new Error("The previous provider retry loop did not stop")
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
  }
}

function scheduleReabort(sessionId: string, record: AbortGuardRecord, now: number): void {
  if (!abortExecutor) return
  if (record.reabortCount >= ABORT_GUARD_MAX_REABORTS) return
  if (now - record.lastReabortAt < ABORT_GUARD_REABORT_DEBOUNCE_MS) return

  record.reabortCount += 1
  record.lastReabortAt = now

  const executor = abortExecutor
  // Defer so callers (event reducers) stay synchronous and side-effect free.
  setTimeout(() => {
    // The guard may have been cleared (idle arrived / new send) while waiting.
    if (records.get(sessionId) !== record) return
    void executor(sessionId, record.directory).catch(() => {
      // Best effort — the next retry/busy status will trigger another attempt
      // while the bounded budget lasts.
    })
  }, 0)
}

/**
 * Filter an incoming authoritative session status through the guard.
 *
 * - `idle` clears the guard and passes through.
 * - While the guard is active, `retry` is coerced to `idle` (the user already
 *   stopped this session) and a bounded re-abort is scheduled.
 * - `busy` passes through unchanged (it may be a legitimate new turn — new
 *   local sends clear the guard before setting busy), but still schedules a
 *   re-abort so a zombie retry attempt gets cancelled as soon as it fires.
 */
export function filterSessionStatusThroughAbortGuard(
  sessionId: string,
  status: SessionStatus,
  now: number = Date.now(),
): SessionStatus {
  if (status.type === "idle") {
    records.delete(sessionId)
    return status
  }

  if (!isAbortGuardActive(sessionId, now)) {
    return status
  }

  const record = records.get(sessionId)
  if (record) {
    extendGuardThroughRetry(record, status, now)
    scheduleReabort(sessionId, record, now)
  }

  if (status.type === "retry") {
    return { type: "idle" }
  }

  return status
}

/** Apply the manual-abort policy to an authoritative status snapshot. */
export function filterSessionStatusSnapshotThroughAbortGuard(
  statuses: Record<string, SessionStatus>,
  now: number = Date.now(),
): Record<string, SessionStatus> {
  let next: Record<string, SessionStatus> | undefined

  for (const [sessionId, status] of Object.entries(statuses)) {
    const filtered = filterSessionStatusThroughAbortGuard(sessionId, status, now)
    if (filtered === status) continue

    next ??= { ...statuses }
    next[sessionId] = filtered
  }

  return next ?? statuses
}
