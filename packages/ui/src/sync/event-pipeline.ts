/**
 * Event Pipeline — transport connection, event coalescing, and batched flush.
 *
 * This module must not make state-dependent decisions about event validity.
 * For example, deciding whether a delta is already represented by a full part
 * snapshot belongs in the reducer, which has access to the current state.
 *
 * Plain closure API:
 *   const { cleanup } = createEventPipeline({ sdk, onEvent })
 *
 * No class, no start/stop lifecycle. One pipeline per mount.
 * Abort controller created once at init, cleaned up via returned cleanup fn.
 */

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { syncDebug } from "./debug"
import {
  postRendererTurnTimingMark,
  responsivenessPerfCount,
  responsivenessPerfObserve,
} from "@/stores/utils/streamDebug"
import { appendStreamingTextDelta } from "./part-delta"
import { usePrimaryRecoveryStore } from "@/stores/usePrimaryRecoveryStore"

export type QueuedEvent = {
  directory: string
  payload: Event
}

export type FlushHandler = (events: QueuedEvent[]) => void

const FLUSH_FRAME_MS = 33
const STREAMING_FLUSH_FRAME_MS = 24
const STREAMING_FLUSH_QUEUE_DEPTH = 8
const BACKPRESSURE_FLUSH_FRAME_MS = 200
const BACKPRESSURE_MODE_MS = 10_000
const STREAM_YIELD_MS = 8
const DEFAULT_RECONNECT_DELAY_MS = 250
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const WS_FALLBACK_WINDOW_MS = 60_000
const DEFAULT_WS_READY_TIMEOUT_MS = 2_000
const PERMANENT_HTTP_RETRY_DELAY_MS = 5_000
const RECENT_DIRECTORY_FLUSH_LIMIT = 64
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//

const nowMs = (): number => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}

export type EventPipelineInput = {
  sdk: OpencodeClient
  onEvent: (directory: string, payload: Event) => void
  routeDirectory?: (directory: string, payload: Event) => string
  /** Called after stream reconnects (visibility restore or heartbeat timeout). */
  onReconnect?: () => void
  /** Called when the stream disconnects (heartbeat timeout, network error, or transport failure). */
  onDisconnect?: (reason: string) => void
  /** Called when transport switches (e.g. WS timeout → SSE fallback) without actual disconnection. */
  onTransportSwitch?: () => void
  /**
   * Called when the server reports that the client's lastEventId predates the
   * server-side replay buffer. The client should treat its cached directory
   * state as potentially stale and trigger a full resync.
   */
  onReplayGap?: () => void
  /** Routes low-frequency DevRyan-managed task state outside directory sync stores. */
  onManagedOrchestrationEvent?: (payload: unknown) => void
  /** Routes server-owned native notification events outside directory sync stores. */
  onUserNotificationEvent?: (payload: unknown) => void
  transport?: "auto" | "ws" | "sse"
  heartbeatTimeoutMs?: number
  reconnectDelayMs?: number
  wsReadyTimeoutMs?: number
}

type MessageStreamWsFrame = {
  type: "ready" | "event" | "error" | "backpressure" | "gap"
  payload?: unknown
  eventId?: string
  directory?: string
  message?: string
  scope?: "global" | "directory"
  lastEventId?: string
}

const normalizeEventType = (payload: Event): Event => {
  const type = (payload as { type?: unknown }).type
  if (typeof type !== "string") {
    return payload
  }

  const match = /^(.*)\.(\d+)$/.exec(type)
  if (!match || !match[1]) {
    return payload
  }

  return {
    ...payload,
    type: match[1] as Event["type"],
  } as unknown as Event
}

const normalizeSyntheticSessionStatus = (payload: Event): Event => {
  const type = (payload as { type?: unknown }).type
  if (type !== "openchamber:session-status") {
    return payload
  }

  const properties =
    typeof payload.properties === "object" && payload.properties !== null
      ? payload.properties as Record<string, unknown>
      : {}
  const sessionID = typeof properties.sessionID === "string" && properties.sessionID.length > 0
    ? properties.sessionID
    : typeof properties.sessionId === "string"
      ? properties.sessionId
      : ""
  if (!sessionID) {
    return payload
  }

  const rawStatus = properties.status
  const statusType = typeof rawStatus === "string"
    ? rawStatus
    : rawStatus && typeof rawStatus === "object" && typeof (rawStatus as { type?: unknown }).type === "string"
      ? String((rawStatus as { type: string }).type)
      : ""
  if (statusType !== "idle" && statusType !== "busy" && statusType !== "retry") {
    return payload
  }

  const metadata = properties.metadata && typeof properties.metadata === "object"
    ? properties.metadata as Record<string, unknown>
    : {}
  const statusRecord = rawStatus && typeof rawStatus === "object"
    ? rawStatus as Record<string, unknown>
    : {}

  const status: Record<string, unknown> = { type: statusType }
  if (statusType === "retry") {
    const attempt = typeof statusRecord.attempt === "number" ? statusRecord.attempt : metadata.attempt
    const message = typeof statusRecord.message === "string" ? statusRecord.message : metadata.message
    const next = typeof statusRecord.next === "number" ? statusRecord.next : metadata.next
    if (typeof attempt === "number" && typeof message === "string" && typeof next === "number") {
      status.attempt = attempt
      status.message = message
      status.next = next
    }
  }

  return {
    ...payload,
    type: "session.status",
    properties: {
      ...properties,
      sessionID,
      status,
    },
  } as unknown as Event
}

const normalizeIncomingEvent = (payload: Event): Event => {
  return normalizeSyntheticSessionStatus(normalizeEventType(payload))
}

function resolveEventDirectory(event: unknown, payload: Event): string {
  const directDirectory =
    typeof event === "object" && event !== null && typeof (event as { directory?: unknown }).directory === "string"
      ? (event as { directory: string }).directory
      : null

  if (directDirectory && directDirectory.length > 0) {
    return directDirectory
  }

  const properties =
    typeof payload.properties === "object" && payload.properties !== null
      ? (payload.properties as Record<string, unknown>)
      : null
  const propertyDirectory = typeof properties?.directory === "string" ? properties.directory : null

  return propertyDirectory && propertyDirectory.length > 0 ? propertyDirectory : "global"
}

function resolveEventPayload(payload: unknown): Event | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const record = payload as { type?: unknown; payload?: unknown }
  if (typeof record.type === "string") {
    return payload as Event
  }

  if (record.payload && typeof record.payload === "object" && typeof (record.payload as { type?: unknown }).type === "string") {
    return record.payload as Event
  }

  return null
}

function resolveAbsoluteUrl(candidate: string): string {
  const normalized = typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "/api"
  if (ABSOLUTE_URL_PATTERN.test(normalized)) {
    return normalized
  }

  if (typeof window === "undefined") {
    return normalized
  }

  const baseReference = window.location?.href || window.location?.origin
  if (!baseReference) {
    return normalized
  }

  return new URL(normalized, baseReference).toString()
}

function toWebSocketUrl(candidate: string): string {
  const url = new URL(resolveAbsoluteUrl(candidate))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

function buildGlobalEventWsUrl(lastEventId?: string): string {
  let baseUrl = "/api"
  try {
    const client = opencodeClient as { getBaseUrl?: () => string }
    if (typeof client.getBaseUrl === "function") {
      baseUrl = client.getBaseUrl()
    }
  } catch {
    baseUrl = "/api"
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const httpUrl = new URL("global/event/ws", resolveAbsoluteUrl(normalizedBase))
  if (lastEventId && lastEventId.length > 0) {
    httpUrl.searchParams.set("lastEventId", lastEventId)
  }
  return toWebSocketUrl(httpUrl.toString())
}

function isVSCodeRuntime(): boolean {
  if (typeof window === "undefined") {
    return false
  }

  const runtimeApis = (window as unknown as {
    __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { isVSCode?: boolean } }
  }).__OPENCHAMBER_RUNTIME_APIS__
  return runtimeApis?.runtime?.isVSCode === true
}

function getRendererRuntimeLabel(): string {
  if (typeof window === "undefined") {
    return "unknown"
  }

  const runtimeApis = (window as unknown as {
    __OPENCHAMBER_DESKTOP_SERVER__?: unknown
    __OPENCHAMBER_ELECTRON__?: unknown
    __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { isDesktop?: boolean; isVSCode?: boolean } }
  }).__OPENCHAMBER_RUNTIME_APIS__

  if (
    (window as unknown as { __OPENCHAMBER_DESKTOP_SERVER__?: unknown }).__OPENCHAMBER_DESKTOP_SERVER__
    || (window as unknown as { __OPENCHAMBER_ELECTRON__?: unknown }).__OPENCHAMBER_ELECTRON__
    || runtimeApis?.runtime?.isDesktop === true
  ) {
    return "desktop"
  }
  if (runtimeApis?.runtime?.isVSCode === true) {
    return "vscode"
  }
  return "web"
}

function getVisibilityState(): string | undefined {
  return typeof document !== "undefined" && typeof document.visibilityState === "string"
    ? document.visibilityState
    : undefined
}

function getRendererTimingTarget(payload: Event): { sessionId?: string; assistantMessageId?: string } | null {
  const properties = (payload as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const props = properties as Record<string, unknown>
  if (payload.type === "message.updated") {
    const info = props.info
    if (!info || typeof info !== "object" || (info as { role?: unknown }).role !== "assistant") {
      return null
    }
    return {
      sessionId: typeof (info as { sessionID?: unknown }).sessionID === "string"
        ? (info as { sessionID: string }).sessionID
        : undefined,
      assistantMessageId: typeof (info as { id?: unknown }).id === "string"
        ? (info as { id: string }).id
        : undefined,
    }
  }

  if (payload.type === "message.part.updated") {
    const part = props.part
    if (!part || typeof part !== "object") {
      return null
    }
    return {
      sessionId: typeof (part as { sessionID?: unknown }).sessionID === "string"
        ? (part as { sessionID: string }).sessionID
        : undefined,
      assistantMessageId: typeof (part as { messageID?: unknown }).messageID === "string"
        ? (part as { messageID: string }).messageID
        : undefined,
    }
  }

  if (payload.type === "message.part.delta") {
    return {
      sessionId: typeof props.sessionID === "string" ? props.sessionID : undefined,
      assistantMessageId: typeof props.messageID === "string" ? props.messageID : undefined,
    }
  }

  return null
}

type DirectoryQueue = {
  queue: Event[]
  buffer: Event[]
  coalesced: Map<string, number>
  timer: ReturnType<typeof setTimeout> | undefined
  last: number
}

type AttemptAbortReason =
  | "pipeline_stopped"
  | "ws_heartbeat_timeout"
  | "sse_heartbeat_timeout"
  | "ws_system_resume"
  | "sse_system_resume"
  | "ws_visibility_restore"
  | "sse_visibility_restore"
  | "ws_pageshow_restore"
  | "sse_pageshow_restore"
  | null

function getErrorHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const directStatus = (error as { status?: unknown }).status
  if (typeof directStatus === "number") return directStatus
  const responseStatus = (error as { response?: { status?: unknown } }).response?.status
  return typeof responseStatus === "number" ? responseStatus : undefined
}

function isPermanentClientErrorStatus(status: number | undefined): boolean {
  return typeof status === "number"
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429
}

export function coalescePartDeltaValue(field: string, previousDelta: string, incomingDelta: string): string {
  if (field === "text" || field === "output") {
    return appendStreamingTextDelta(previousDelta, incomingDelta)
  }

  return previousDelta + incomingDelta
}

export const isStreamingPartEvent = (payload: Event): boolean => {
  if (payload.type === "message.part.delta") {
    return true
  }
  if (payload.type === "message.part.updated") {
    const part = (payload.properties as { part?: { type?: string } }).part
    return part?.type === "text" || part?.type === "reasoning"
  }
  return false
}

export function createEventPipeline(input: EventPipelineInput) {
  const {
    sdk,
    onEvent,
    onReconnect,
    onDisconnect,
    onTransportSwitch,
    onReplayGap,
    onManagedOrchestrationEvent,
    onUserNotificationEvent,
    routeDirectory,
    transport = "auto",
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    wsReadyTimeoutMs = DEFAULT_WS_READY_TIMEOUT_MS,
  } = input
  const abort = new AbortController()
  let disconnected = false
  let lastEventId: string | undefined
  let wsFallbackUntil = 0

  const directories = new Map<string, DirectoryQueue>()
  const recentDirectoryFlushes = new Map<string, number>()

  const rememberDirectoryFlush = (directory: string, timestamp: number) => {
    recentDirectoryFlushes.delete(directory)
    recentDirectoryFlushes.set(directory, timestamp)
    while (recentDirectoryFlushes.size > RECENT_DIRECTORY_FLUSH_LIMIT) {
      const oldest = recentDirectoryFlushes.keys().next().value
      if (typeof oldest !== "string") break
      recentDirectoryFlushes.delete(oldest)
    }
  }

  const getOrCreateDir = (directory: string): DirectoryQueue => {
    let d = directories.get(directory)
    if (d) return d
    d = {
      queue: [],
      buffer: [],
      coalesced: new Map(),
      timer: undefined,
      last: recentDirectoryFlushes.get(directory) ?? 0,
    }
    directories.set(directory, d)
    return d
  }

  const partUpdatedKey = (messageID: string, partID: string) => `message.part.updated:${messageID}:${partID}`

  const key = (payload: Event): string | undefined => {
    if (payload.type === "session.status") {
      const props = payload.properties as { sessionID: string }
      return `session.status:${props.sessionID}`
    }
    if (payload.type === "lsp.updated") {
      return "lsp.updated"
    }
    if (payload.type === "message.part.delta") {
      const props = payload.properties as { messageID: string; partID: string; field: string }
      return `message.part.delta:${props.messageID}:${props.partID}:${props.field}`
    }
    if (payload.type === "message.part.updated") {
      const props = payload.properties as { part?: { id?: string; messageID?: string } }
      const part = props.part
      if (part?.messageID && part.id) {
        return partUpdatedKey(part.messageID, part.id)
      }
    }
    return undefined
  }

  const invalidatePartUpdatedCoalescingAfterDelta = (d: DirectoryQueue, payload: Event) => {
    if (payload.type !== "message.part.delta") return
    const props = payload.properties as { messageID?: string; partID?: string }
    if (!props.messageID || !props.partID) return
    d.coalesced.delete(partUpdatedKey(props.messageID, props.partID))
  }

  // Mirror of the above: a delta arriving after a queued part snapshot must not
  // coalesce into a slot BEFORE that snapshot, or the flush applies the newer
  // delta first and the stale snapshot then overwrites it — dropping the delta's
  // text mid-stream.
  const invalidateDeltaCoalescingAfterPartUpdated = (d: DirectoryQueue, payload: Event) => {
    if (payload.type !== "message.part.updated") return
    const part = (payload.properties as { part?: { id?: string; messageID?: string } }).part
    if (!part?.messageID || !part.id) return
    const prefix = `message.part.delta:${part.messageID}:${part.id}:`
    for (const coalescedKey of d.coalesced.keys()) {
      if (coalescedKey.startsWith(prefix)) d.coalesced.delete(coalescedKey)
    }
  }

  const flushDir = (directory: string) => {
    const d = directories.get(directory)
    if (!d) return
    if (d.timer) {
      clearTimeout(d.timer)
      d.timer = undefined
    }
    if (d.queue.length === 0) {
      directories.delete(directory)
      return
    }

    const events = d.queue
    d.queue = d.buffer
    d.buffer = events
    d.queue.length = 0
    d.coalesced.clear()

    d.last = Date.now()
    rememberDirectoryFlush(directory, d.last)
    syncDebug.pipeline.flush(events.length)
    responsivenessPerfCount("event_pipeline.flush_count")
    responsivenessPerfObserve("event_pipeline.flush_size", events.length)
    const startedAt = nowMs()
    for (const payload of events) {
      onEvent(directory, payload)
    }
    responsivenessPerfObserve("event_pipeline.flush_ms", nowMs() - startedAt)

    d.buffer.length = 0
    if (d.queue.length === 0 && !d.timer && directories.get(directory) === d) {
      directories.delete(directory)
    }
  }

  const flushAll = () => {
    for (const directory of directories.keys()) {
      flushDir(directory)
    }
  }

  const scheduleDir = (directory: string, streaming = false) => {
    const d = getOrCreateDir(directory)
    if (d.timer) {
      if (!streaming) {
        return
      }
      clearTimeout(d.timer)
      d.timer = undefined
    }
    const elapsed = Date.now() - d.last
    const flushFrameMs = Date.now() < backpressureUntil
      ? BACKPRESSURE_FLUSH_FRAME_MS
      : streaming
        ? STREAMING_FLUSH_FRAME_MS
        : FLUSH_FRAME_MS
    d.timer = setTimeout(() => flushDir(directory), Math.max(0, flushFrameMs - elapsed))
  }

  const releaseDirectory = (directory: string): boolean => {
    const releasedRecent = recentDirectoryFlushes.delete(directory)
    const d = directories.get(directory)
    if (!d) return releasedRecent
    if (d.timer) {
      clearTimeout(d.timer)
      d.timer = undefined
    }
    d.queue.length = 0
    d.buffer.length = 0
    d.coalesced.clear()
    directories.delete(directory)
    return true
  }

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === "AbortError" ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")
  const isBrowserOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false
  const isDocumentHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden"

  const waitForRetryDelay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (ms <= 0 && !isBrowserOffline() && !isDocumentHidden()) {
      resolve()
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      signal.removeEventListener("abort", finish)
      if (typeof globalThis.window !== "undefined") {
        globalThis.window.removeEventListener("online", finish)
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility)
      }
      resolve()
    }
    const handleVisibility = () => {
      if (!isDocumentHidden()) {
        finish()
      }
    }

    if (signal.aborted) {
      finish()
      return
    }

    signal.addEventListener("abort", finish, { once: true })
    if (typeof globalThis.window !== "undefined") {
      globalThis.window.addEventListener("online", finish)
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility)
    }

    if (!isBrowserOffline() && !isDocumentHidden() && ms > 0) {
      timer = setTimeout(finish, ms)
    }
  })

  let streamErrorLogged = false
  let attempt: AbortController | undefined
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  let activeTransport: "ws" | "sse" = transport === "ws" ? "ws" : "sse"
  let attemptAbortReason: AttemptAbortReason = null
  let consecutiveFailures = 0
  let backpressureUntil = 0
  let backoffMs = reconnectDelayMs
  const RECONNECT_BACKOFF_MAX_MS = 5_000

  const notifyDisconnected = (reason: string) => {
    if (disconnected) {
      return
    }
    disconnected = true
    responsivenessPerfCount("event_pipeline.disconnect")
    onDisconnect?.(reason)
  }

  const markConnected = () => {
    disconnected = false
    consecutiveFailures = 0
    backoffMs = reconnectDelayMs
    // Fire onReconnect on every successful connect — including the very
    // first one. Consumer state (isConnected) starts at false and needs
    // to be flipped positively; without this the send button throws
    // "Connection lost" until something else (HTTP health check) happens
    // to race a setState({isConnected: true}) through.
    onReconnect?.()
    globalThis.window?.dispatchEvent(new globalThis.Event("openchamber:primary-recovery-reconnect"))
  }

  const enqueueEvent = (directory: string, payload: Event) => {
    responsivenessPerfCount("event_pipeline.enqueue_count")
    const normalizedPayload = normalizeIncomingEvent(payload)
    const normalizedType = (normalizedPayload as unknown as { type?: string }).type
    if (normalizedType === "openchamber:primary-recovery") {
      const data = normalizedPayload as unknown as { properties?: { sessionID?: unknown; recovery?: unknown } }
      if (typeof data.properties?.sessionID === "string") {
        usePrimaryRecoveryStore.getState().accept(data.properties.sessionID, data.properties.recovery)
      }
      return
    }
    if (
      normalizedType === "openchamber:managed-task"
      || normalizedType === "openchamber:managed-task-removed"
      || normalizedType === "openchamber:managed-orchestration-warning"
    ) {
      onManagedOrchestrationEvent?.(normalizedPayload)
      return
    }
    if (normalizedType === "openchamber:notification") {
      onUserNotificationEvent?.(normalizedPayload)
      return
    }
    const routedDirectory = routeDirectory?.(directory, normalizedPayload) || directory
    const rendererTarget = getRendererTimingTarget(normalizedPayload)
    if (rendererTarget?.sessionId || rendererTarget?.assistantMessageId) {
      postRendererTurnTimingMark({
        sessionId: rendererTarget.sessionId,
        assistantMessageId: rendererTarget.assistantMessageId,
        mark: "renderer_event_received",
        directory: routedDirectory,
        metadata: {
          runtime: getRendererRuntimeLabel(),
          transport: activeTransport,
          visibilityState: getVisibilityState(),
        },
      })
    }
    const d = getOrCreateDir(routedDirectory)
    invalidatePartUpdatedCoalescingAfterDelta(d, normalizedPayload)
    invalidateDeltaCoalescingAfterPartUpdated(d, normalizedPayload)
    const k = key(normalizedPayload)
    if (k) {
      const i = d.coalesced.get(k)
      if (i !== undefined) {
        if (normalizedPayload.type === "message.part.delta") {
          const prev = d.queue[i] as unknown as { properties: { delta: string } }
          const inc = normalizedPayload.properties as { delta: string; field?: string }
          d.queue[i] = {
            ...normalizedPayload,
            properties: {
              ...(normalizedPayload.properties as object),
              delta: coalescePartDeltaValue(
                typeof inc.field === "string" ? inc.field : "",
                prev.properties.delta,
                inc.delta,
              ),
            },
          } as unknown as Event
        } else {
          d.queue[i] = normalizedPayload
        }
        syncDebug.pipeline.coalesced(normalizedPayload.type, k)
        responsivenessPerfObserve("event_pipeline.queue_depth", d.queue.length)
        const coalescedStreaming = isStreamingPartEvent(normalizedPayload)
        if (coalescedStreaming && d.queue.length >= STREAMING_FLUSH_QUEUE_DEPTH) {
          flushDir(routedDirectory)
          return
        }
        scheduleDir(routedDirectory, coalescedStreaming)
        return
      }
      d.coalesced.set(k, d.queue.length)
    }

    d.queue.push(normalizedPayload)
    responsivenessPerfObserve("event_pipeline.queue_depth", d.queue.length)
    const streaming = isStreamingPartEvent(normalizedPayload)
    if (streaming && d.queue.length >= STREAMING_FLUSH_QUEUE_DEPTH) {
      flushDir(routedDirectory)
      return
    }
    scheduleDir(routedDirectory, streaming)
  }

  const resetHeartbeat = () => {
    lastEventAt = Date.now()
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      attemptAbortReason = `${activeTransport}_heartbeat_timeout`
      attempt?.abort()
    }, heartbeatTimeoutMs)
  }

  const clearHeartbeat = () => {
    if (!heartbeat) return
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  const runSseAttempt = async (signal: AbortSignal) => {
    let connected = false
    const markSseConnected = () => {
      if (connected) return
      // The SDK creates its stream wrapper before opening the response. A
      // parsed/yielded event is the first authoritative proof of connectivity.
      connected = true
      markConnected()
    }
    const events = await sdk.global.event({
      signal,
      ...(lastEventId && lastEventId.length > 0 ? { headers: { "Last-Event-ID": lastEventId } } : {}),
      onSseEvent: (event: { id?: unknown }) => {
        markSseConnected()
        resetHeartbeat()
        if (typeof event.id === "string" && event.id.length > 0) {
          lastEventId = event.id
        }
      },
      onSseError: (error: unknown) => {
        if (isAbortError(error)) return
        if (streamErrorLogged) return
        streamErrorLogged = true
        console.error("[event-pipeline] SSE stream error", error)
      },
    })

    let yielded = Date.now()
    resetHeartbeat()

    for await (const event of events.stream) {
      markSseConnected()
      resetHeartbeat()
      streamErrorLogged = false

      const payload = resolveEventPayload((event as { payload?: Event }).payload ?? event)
      if (!payload) {
        continue
      }
      const directory = resolveEventDirectory(event, payload)
      enqueueEvent(directory, payload)

      if (Date.now() - yielded < STREAM_YIELD_MS) continue
      yielded = Date.now()
      await wait(0)
    }
  }

  const runWsAttempt = async (signal: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let opened = false
      let readyAt = 0
      let lastWsErrorReason: string | undefined
      const socket = new WebSocket(buildGlobalEventWsUrl(lastEventId))
      const setFallbackCode = (error: Error, force = false) => {
        if ((force || !opened) && transport === "auto") {
          wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
          ;(error as Error & { code?: string }).code = "WS_FALLBACK"
        }
      }

      let readyTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        readyTimer = undefined
        const error = new Error("Message stream WebSocket ready timeout")
        setFallbackCode(error)
        settleReject(error)
        try {
          socket.close()
        } catch {
          // ignore
        }
      }, wsReadyTimeoutMs)

      const cleanup = () => {
        if (readyTimer) {
          clearTimeout(readyTimer)
          readyTimer = undefined
        }
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
      }

      const settleResolve = () => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", handleAbort)
        cleanup()
        resolve()
      }

      const settleReject = (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", handleAbort)
        cleanup()
        reject(error)
      }

      const handleAbort = () => {
        try {
          socket.close()
        } catch {
          // ignore close failures during abort
        }
        settleResolve()
      }

      signal.addEventListener("abort", handleAbort, { once: true })

      socket.onopen = () => {
        // Don't clear streamErrorLogged here. If the socket immediately closes
        // before sending the ready frame, clearing would cause log spam.
      }

      socket.onmessage = (messageEvent) => {
        resetHeartbeat()
        streamErrorLogged = false

        let frame: MessageStreamWsFrame | null = null
        try {
          frame = JSON.parse(String(messageEvent.data)) as MessageStreamWsFrame
        } catch (error) {
          console.warn("[event-pipeline] Failed to parse WS frame", error)
          return
        }

        if (!frame || typeof frame.type !== "string") {
          return
        }

        if (frame.type === "ready") {
          opened = true
          readyAt = Date.now()
          if (readyTimer) {
            clearTimeout(readyTimer)
            readyTimer = undefined
          }
          streamErrorLogged = false
          markConnected()
          return
        }

        if (frame.type === "error") {
          const error = new Error(frame.message || "Message stream WebSocket error")
          ;(error as Error & { reason?: string }).reason = `ws_error_frame:${frame.message || "unknown"}`
          setFallbackCode(error)
          settleReject(error)
          try {
            socket.close()
          } catch {
            // ignore
          }
          return
        }

        if (frame.type === "backpressure") {
          backpressureUntil = Date.now() + BACKPRESSURE_MODE_MS
          return
        }

        if (frame.type === "gap") {
          // Server-side replay buffer rolled past our lastEventId. The events
          // it just sent (if any) follow this frame, so allow them through
          // and let the consumer trigger a full resync separately.
          responsivenessPerfCount("event_pipeline.replay_gap")
          onReplayGap?.()
          return
        }

        if (frame.type !== "event") {
          return
        }

        const payload = resolveEventPayload(frame.payload)
        if (!payload) {
          return
        }

        if (typeof frame.eventId === "string" && frame.eventId.length > 0) {
          lastEventId = frame.eventId
        }

        const directory = resolveEventDirectory(
          { directory: frame.directory, payload },
          payload,
        )
        enqueueEvent(directory, payload)
      }

      socket.onerror = (event) => {
        // WebSocket "error" events are intentionally opaque per the spec;
        // capture whatever we can so onclose can tag a non-empty reason.
        const candidate = (event as { message?: unknown }).message
        if (typeof candidate === "string" && candidate.length > 0) {
          lastWsErrorReason = candidate
        } else if (!lastWsErrorReason) {
          lastWsErrorReason = "ws_error"
        }
      }

      socket.onclose = (event) => {
        if (signal.aborted) {
          settleResolve()
          return
        }

        const error = new Error(lastWsErrorReason
          ? `Global message stream WebSocket closed (${lastWsErrorReason})`
          : "Global message stream WebSocket closed")
        ;(error as Error & { reason?: string }).reason = opened
          ? `ws_closed:code=${event?.code ?? "?"}${lastWsErrorReason ? `:${lastWsErrorReason}` : ""}`
          : `ws_closed_before_ready${lastWsErrorReason ? `:${lastWsErrorReason}` : ""}`

        // If the WS stream connects (ready) but then drops quickly, prefer SSE for a while.
        // This avoids tight reconnect loops with repeated console spam.
        const livedMs = readyAt > 0 ? Date.now() - readyAt : 0
        const unstableAfterReady = opened && livedMs > 0 && livedMs < 2_000
        setFallbackCode(error, unstableAfterReady)
        settleReject(error)
      }
    })
  }

  const resolveTransport = (): "ws" | "sse" => {
    if (isVSCodeRuntime()) {
      return "sse"
    }
    if (typeof WebSocket !== "function") {
      return "sse"
    }
    if (transport === "ws") {
      return "ws"
    }
    if (transport === "sse") {
      return "sse"
    }
    return wsFallbackUntil > Date.now() ? "sse" : "ws"
  }

  void (async () => {
    while (!abort.signal.aborted) {
      attempt = new AbortController()
      lastEventAt = Date.now()
      attemptAbortReason = null
      // Default to the current backoff. Specific error paths below reset it
      // (transport switch, heartbeat-driven reconnect) or grow it.
      let retryDelayMs = backoffMs
      const currentTransport = resolveTransport()
      activeTransport = currentTransport
      const onAbort = () => {
        attemptAbortReason = "pipeline_stopped"
        attempt?.abort()
      }
      abort.signal.addEventListener("abort", onAbort)

      try {
        if (currentTransport === "ws") {
          await runWsAttempt(attempt.signal)
        } else {
          await runSseAttempt(attempt.signal)
        }
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
        if (currentTransport === "ws" && code === "WS_FALLBACK") {
          retryDelayMs = 0
          // Transport switch (WS → SSE fallback), not a real disconnection.
          // No events were lost — the next attempt will use SSE and carry
          // lastEventId for gapless replay. Notify consumer so it can set
          // isConnected, but do NOT treat this as a disconnection requiring
          // a full directory resync.
          responsivenessPerfCount("event_pipeline.transport_switch")
          onTransportSwitch?.()
        } else if (!isAbortError(error)) {
          consecutiveFailures += 1
          if (!streamErrorLogged) {
            streamErrorLogged = true
            console.error("[event-pipeline] stream failed", error)
          }
          // Notify consumer that the stream has disconnected, so it can
          // update connection state (e.g. set isConnected = false).
          // Guard: only fire once per disconnection cycle to avoid repeated
          // setState calls on every failed retry attempt.
          const taggedReason = typeof error === "object" && error !== null
            ? (error as { reason?: unknown }).reason
            : undefined
          const message = typeof error === "object" && error !== null
            ? (error as { message?: unknown }).message
            : undefined
          const reason = typeof taggedReason === "string" && taggedReason.length > 0
            ? taggedReason
            : typeof message === "string" && message.length > 0
              ? `${currentTransport}_error:${message.slice(0, 80)}`
              : `${currentTransport}_error:unknown`
          notifyDisconnected(reason)

          // Backoff so a hard-down server doesn't spin the browser event loop.
          // Cap at 5s; reset occurs in markConnected().
          const status = getErrorHttpStatus(error)
          if (isPermanentClientErrorStatus(status)) {
            backoffMs = Math.max(PERMANENT_HTTP_RETRY_DELAY_MS, reconnectDelayMs)
          } else {
            backoffMs = consecutiveFailures <= 1
              ? Math.max(backoffMs, reconnectDelayMs)
              : Math.min(RECONNECT_BACKOFF_MAX_MS, Math.max(backoffMs, reconnectDelayMs) * 2)
          }
          retryDelayMs = backoffMs
        }
      } finally {
        abort.signal.removeEventListener("abort", onAbort)
        attempt = undefined
        clearHeartbeat()
      }

      if (abort.signal.aborted) return
      const abortReason = attemptAbortReason as string | null
      if (abortReason && abortReason !== "pipeline_stopped") {
        if (abortReason.endsWith("_heartbeat_timeout")) {
          responsivenessPerfCount("event_pipeline.heartbeat_abort")
        }
        notifyDisconnected(abortReason)
        retryDelayMs = 0
        attemptAbortReason = null
      }
      if (retryDelayMs > 0 || isBrowserOffline() || isDocumentHidden()) {
        await waitForRetryDelay(retryDelayMs, abort.signal)
      }
    }
  })().finally(flushAll)

  const onVisibility = () => {
    if (typeof document === "undefined") return
    if (document.visibilityState !== "visible") return
    if (Date.now() - lastEventAt < heartbeatTimeoutMs) return
    attemptAbortReason = `${activeTransport}_visibility_restore`
    attempt?.abort()
  }

  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return
    attemptAbortReason = `${activeTransport}_pageshow_restore`
    attempt?.abort()
  }

  // OS wake-from-sleep (Electron powerMonitor.resume). The SSE connection
  // is almost certainly dead after sleep — abort immediately so the
  // reconnect loop fires on the next tick with retryDelayMs = 0.
  const onSystemResume = () => {
    attemptAbortReason = `${activeTransport}_system_resume`
    attempt?.abort()
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
  }

  // Use globalThis (not window) for the system-resume listener so that
  // test environments can replace globalThis.window with a stub.
  if (typeof globalThis.window !== "undefined") {
    globalThis.window.addEventListener("openchamber:system-resume", onSystemResume)
  }

  const cleanup = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
    }
    if (typeof globalThis.window !== "undefined") {
      globalThis.window.removeEventListener("openchamber:system-resume", onSystemResume)
    }
    abort.abort()
    flushAll()
    recentDirectoryFlushes.clear()
  }

  return {
    cleanup,
    enqueueEvent,
    releaseDirectory,
    getDirectoryQueueCount: () => directories.size,
    getRecentDirectoryCount: () => recentDirectoryFlushes.size,
  }
}
