import { streamPerfCount, streamPerfObserve } from "@/stores/utils/streamDebug"

export type SessionLoadOutcome = "complete" | "error" | "stale" | "deduplicated" | "canceled"

type SessionLoadEventInput = {
  operation: string
  caller?: string
  queuedMs?: number
  requestLimit?: number
  cursorPresent?: boolean
}

type SessionLoadEventDetails = {
  retryCount?: number
  recordCount?: number
}

const navigationStartedAt = new Map<string, { startedAt: number; loaderMarked: boolean }>()
const MAX_NAVIGATION_KEYS = 100

const now = (): number => (
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()
)

const navigationKey = (directory: string | null | undefined, sessionID: string): string => (
  `${directory ?? ""}\n${sessionID}`
)

const sanitizeMetricSegment = (value: string | undefined, fallback: string): string => {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_")
  return normalized || fallback
}

export function startSessionLoadPerformanceEvent(input: SessionLoadEventInput) {
  const startedAt = now()
  const operation = sanitizeMetricSegment(input.operation, "unknown")
  const caller = sanitizeMetricSegment(input.caller, "unknown")

  return (outcome: SessionLoadOutcome, details?: SessionLoadEventDetails): void => {
    const durationMs = Math.max(0, now() - startedAt)
    const prefix = `session.load.${operation}.${caller}`
    streamPerfObserve(`${prefix}.duration_ms`, durationMs)
    streamPerfCount(`${prefix}.outcome.${outcome}`)
    if (typeof input.queuedMs === "number" && Number.isFinite(input.queuedMs)) {
      streamPerfObserve(`${prefix}.queued_ms`, Math.max(0, input.queuedMs))
    }
    if (typeof input.requestLimit === "number" && Number.isFinite(input.requestLimit)) {
      streamPerfObserve(`${prefix}.request_limit`, Math.max(0, Math.floor(input.requestLimit)))
    }
    if (typeof input.cursorPresent === "boolean") {
      streamPerfCount(`${prefix}.cursor.${input.cursorPresent ? "present" : "absent"}`)
    }
    if (typeof details?.retryCount === "number" && Number.isFinite(details.retryCount)) {
      streamPerfObserve(`${prefix}.retry_count`, Math.max(0, Math.floor(details.retryCount)))
    }
    if (typeof details?.recordCount === "number" && Number.isFinite(details.recordCount)) {
      streamPerfObserve(`${prefix}.record_count`, Math.max(0, Math.floor(details.recordCount)))
    }
  }
}

export function beginSessionNavigation(
  sessionID: string,
  directory?: string | null,
  cacheState: "warm" | "cold" | "unknown" = "unknown",
): void {
  if (!sessionID) return
  const key = navigationKey(directory, sessionID)
  if (navigationStartedAt.has(key)) return
  navigationStartedAt.set(key, { startedAt: now(), loaderMarked: false })
  while (navigationStartedAt.size > MAX_NAVIGATION_KEYS) {
    const oldest = navigationStartedAt.keys().next().value
    if (!oldest) break
    navigationStartedAt.delete(oldest)
  }
  streamPerfCount("session.load.navigation.selected")
  streamPerfCount(`session.load.navigation.cache.${cacheState}`)
}

export function markSessionNavigationLoaderStarted(sessionID: string, directory?: string | null): void {
  const navigation = navigationStartedAt.get(navigationKey(directory, sessionID))
  if (!navigation || navigation.loaderMarked) return
  navigation.loaderMarked = true
  streamPerfObserve("session.load.navigation.to_loader_start_ms", Math.max(0, now() - navigation.startedAt))
}

export function markSessionNavigationReactCommitted(sessionID: string, directory?: string | null): void {
  const navigation = navigationStartedAt.get(navigationKey(directory, sessionID))
  if (!navigation) return
  streamPerfObserve("session.load.navigation.to_react_commit_ms", Math.max(0, now() - navigation.startedAt))
  streamPerfCount("session.load.navigation.react_commit")
}

export function completeSessionNavigation(sessionID: string, directory?: string | null): void {
  if (!sessionID) return
  const key = navigationKey(directory, sessionID)
  const navigation = navigationStartedAt.get(key)
  if (!navigation) return
  navigationStartedAt.delete(key)
  streamPerfObserve("session.load.navigation.to_first_visible_ms", Math.max(0, now() - navigation.startedAt))
  streamPerfCount("session.load.navigation.first_visible")
}

export function cancelSessionNavigation(sessionID: string, directory?: string | null): void {
  navigationStartedAt.delete(navigationKey(directory, sessionID))
}

export function resetSessionLoadPerformanceForTest(): void {
  navigationStartedAt.clear()
}
