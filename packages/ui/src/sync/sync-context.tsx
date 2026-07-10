/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"
import {
  reduceGlobalEvent,
  applyGlobalProject,
  applyDirectoryEvent,
  shouldSettleTerminalAssistantMessageStatus,
} from "./event-reducer"
import { useGlobalSyncStore, type GlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areSessionListsEquivalent,
  areStatusMapsEquivalent,
  findLiveSession,
  findLiveSessionStatus,
} from "./live-aggregate"
import { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"
import { retry } from "./retry"
import { updateStreamingState, useStreamingStore } from "./streaming"
import { isSessionWorkingFromState } from "./session-working"
import { setActionRefs } from "./session-actions"
import { setSyncRefs } from "./sync-refs"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { syncDebug } from "./debug"
import {
  ACTIVE_SESSION_RECOVERY_COOLDOWN_MS,
  ACTIVE_SESSION_STATUS_STALE_MS,
  getReconnectCandidateSessionIds,
  mergeRecoveredSessionStatuses,
  shouldRecoverStaleActiveSession,
  unwrapSdkResult,
} from "./reconnect-recovery"
import { hasMessageRecordInfo, unwrapMessageRecordsResult } from "./message-fetch"
import {
  addPendingPartDelta,
  applyPendingPartDeltasToState,
  consumePendingPartDeltas,
  hasPendingPartDeltasForMessages,
  readPendingPartDeltaFromEvent,
  type PendingPartDeltaStore,
} from "./pending-part-deltas"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { useTodosPersistStore } from "@/stores/useTodosPersistStore"
import { useUIStore } from "@/stores/useUIStore"
import {
  postRendererTurnTimingMark,
  responsivenessPerfCount,
  responsivenessPerfObserve,
  streamDebugEnabled,
  streamDebugMark,
} from "@/stores/utils/streamDebug"
import { toast } from "@/components/ui"
import {
  isLikelyProviderModelNotFound,
  PROVIDER_MODEL_NOT_FOUND_MESSAGE,
} from "@/lib/messages/providerModelNotFound"
import { appendNotification } from "./notification-store"
import type { State } from "./types"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"
import * as sessionActions from "./session-actions"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { updateSessionUserActivityFromMessages } from "./session-user-activity"
import { getEffectiveSessionRevertMessageID } from "./revert-transactions"
import { markArchived, markUnarchived, setSessionMaterializerChildStores } from "./session-materializer"
import { detectPlanCompletedCandidate } from "./plan-completion-detection"
import { detectPlanProposedCandidate } from "./plan-proposed-detection"
import {
  isSessionTurnSettledForCompletion,
  shouldSettlePlanProposalStatus,
  shouldSettleTerminalSessionStatus,
} from "./plan-idle-settlement"
import { detectTurnCompletedCandidate } from "./turn-completion-detection"
import {
  getTerminalSessionIdForParentMaterialization,
  resolveParentSessionIdForTerminalChild,
} from "./subtaskParentMaterialization"
import {
  ensureSessionChildrenFetch,
  getEffectiveSessionChildrenFetchStatus,
  getSessionChildrenFetchKey,
  mergeChildSessions,
  type SessionChildrenFetchCacheEntry,
  type SessionChildrenHookStatus,
} from "./session-children"
import {
  normalizeChatOwnedDiffSummary,
  stripUntrustedSessionDiffSummary,
  type SessionSummaryDiffStats,
} from "@/lib/sessionDiffStats"
import { requestSignature } from "./request-signature"

const EMPTY_SESSION_STATUS_MAP: Record<string, SessionStatus> = {}
const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_QUESTION_REQUESTS: QuestionRequest[] = []
const FIRST_ASSISTANT_DELTA_MARK_LIMIT = 1_000
const firstAssistantDeltaMarkedMessages = new Set<string>()
const sessionChildrenFetches = new Map<string, SessionChildrenFetchCacheEntry>()
const blockingRequestSessionMaterializationsInFlight = new Set<string>()

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const nowMs = (): number => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}

const rememberFirstAssistantDeltaMark = (messageID: string): void => {
  firstAssistantDeltaMarkedMessages.add(messageID)
  if (firstAssistantDeltaMarkedMessages.size <= FIRST_ASSISTANT_DELTA_MARK_LIMIT) {
    return
  }
  const oldest = firstAssistantDeltaMarkedMessages.values().next().value
  if (typeof oldest === "string") {
    firstAssistantDeltaMarkedMessages.delete(oldest)
  }
}

const markFirstAssistantStreamForDebug = (state: State, payload: Event): void => {
  if (!streamDebugEnabled()) {
    return
  }

  let messageID = ""
  let partID: string | undefined
  let field: string | undefined
  let eventType: "message.part.delta" | "message.part.updated" | null = null

  if (payload.type === "message.part.delta") {
    const props = payload.properties as { messageID?: unknown; partID?: unknown; field?: unknown }
    messageID = typeof props.messageID === "string" ? props.messageID : ""
    partID = typeof props.partID === "string" ? props.partID : undefined
    field = typeof props.field === "string" ? props.field : undefined
    eventType = "message.part.delta"
  } else if (payload.type === "message.part.updated") {
    const part = (payload.properties as { part?: { messageID?: string; id?: string; type?: string } }).part
    if (!part || (part.type !== "text" && part.type !== "reasoning")) {
      return
    }
    messageID = typeof part.messageID === "string" ? part.messageID : ""
    partID = typeof part.id === "string" ? part.id : undefined
    field = "text"
    eventType = "message.part.updated"
  } else {
    return
  }

  if (!messageID || firstAssistantDeltaMarkedMessages.has(messageID)) {
    return
  }

  for (const messages of Object.values(state.message)) {
    const message = messages.find((item) => item.id === messageID)
    if (!message) {
      continue
    }
    if (message.role !== "assistant") {
      return
    }
    rememberFirstAssistantDeltaMark(messageID)
    streamDebugMark("first-reply-first-assistant-stream", {
      messageID,
      partID,
      field,
      eventType,
    })
    if (eventType === "message.part.delta") {
      streamDebugMark("first-reply-first-assistant-delta", {
        messageID,
        partID,
        field,
      })
    }
    return
  }
}

const isTerminalAssistantInfo = (info: Message | undefined): info is Message => {
  if (!info || info.role !== "assistant") return false
  const finish = (info as { finish?: unknown }).finish
  const completed = (info.time as { completed?: unknown } | undefined)?.completed
  return typeof completed === "number" || (typeof finish === "string" && finish.length > 0)
}

const markRendererReducedEvent = (
  payload: Event,
  directory: string,
  state: State,
  routingIndex: EventRoutingIndex,
): void => {
  if (payload.type === "message.updated") {
    const info = (payload.properties as { info?: Message }).info
    if (!isTerminalAssistantInfo(info)) {
      return
    }
    postRendererTurnTimingMark({
      sessionId: info.sessionID,
      assistantMessageId: info.id,
      mark: "renderer_assistant_completion_observed",
      directory,
      metadata: { source: "message.updated" },
    })
    return
  }

  if (payload.type === "message.part.updated") {
    const part = (payload.properties as { part?: Part }).part
    if (!part || (part.type !== "text" && part.type !== "reasoning")) {
      return
    }
    const messageID = (part as { messageID?: string }).messageID
    if (!messageID) {
      return
    }
    postRendererTurnTimingMark({
      sessionId: (part as { sessionID?: string }).sessionID ?? resolveSessionIdForMessage(state, routingIndex, messageID) ?? undefined,
      assistantMessageId: messageID,
      mark: "renderer_first_assistant_part_reduced",
      directory,
      metadata: { source: "message.part.updated" },
    })
    return
  }

  if (payload.type === "message.part.delta") {
    const props = payload.properties as { messageID?: string; sessionID?: string }
    if (!props.messageID) {
      return
    }
    postRendererTurnTimingMark({
      sessionId: props.sessionID ?? resolveSessionIdForMessage(state, routingIndex, props.messageID) ?? undefined,
      assistantMessageId: props.messageID,
      mark: "renderer_first_assistant_part_reduced",
      directory,
      metadata: { source: "message.part.delta" },
    })
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type SyncSystem = {
  childStores: ChildStoreManager
  sdk: OpencodeClient
  directory: string
  resyncSession: (sessionID: string, options?: { directory?: string | null; reason?: "focus" | "reconnect" | "manual" }) => Promise<void>
}

const SYNC_CONTEXT_GLOBAL_KEY = "__openchamber_sync_context__"
type SyncGlobal = typeof globalThis & {
  [SYNC_CONTEXT_GLOBAL_KEY]?: React.Context<SyncSystem | null>
}

const syncGlobal = globalThis as SyncGlobal
const SyncContext = syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] ?? createContext<SyncSystem | null>(null)
syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] = SyncContext

function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

export function useSyncChildStores(): ChildStoreManager {
  return useSyncSystem().childStores
}

function getLiveStates(childStores: ChildStoreManager): State[] {
  return Array.from(childStores.children.values(), (store) => store.getState())
}

function useLiveSyncSelector<T>(selector: (states: State[]) => T, isEqual: (left: T, right: T) => boolean = Object.is): T {
  const { childStores } = useSyncSystem()
  const cacheRef = useRef<T | undefined>(undefined)
  const initializedRef = useRef(false)

  const getSnapshot = useCallback(() => {
    const next = selector(getLiveStates(childStores))
    if (initializedRef.current && isEqual(cacheRef.current as T, next)) {
      return cacheRef.current as T
    }

    cacheRef.current = next
    initializedRef.current = true
    return next
  }, [childStores, isEqual, selector])

  return React.useSyncExternalStore(
    useCallback((notify) => childStores.subscribeAll(notify), [childStores]),
    getSnapshot,
    getSnapshot,
  )
}

// ---------------------------------------------------------------------------
// Event handler — applies one SSE event at a time to the live store.
// Each event reads live state, creates a shallow draft, applies, writes back.
// React 18 batches synchronous setState calls automatically.
// ---------------------------------------------------------------------------

/** Read status for a session across all directories */
export function useGlobalSessionStatus(sessionId: string): SessionStatus | undefined {
  return useLiveSyncSelector(
    useCallback((states) => findLiveSessionStatus(states, sessionId), [sessionId]),
  )
}

/** Read all session statuses (for sidebar) */
export function useAllSessionStatuses(enabled = true): Record<string, SessionStatus> {
  return useLiveSyncSelector(
    useCallback((states) => (enabled ? aggregateLiveSessionStatuses(states) : EMPTY_SESSION_STATUS_MAP), [enabled]),
    areStatusMapsEquivalent,
  )
}

const areSessionUserActivityMapsEquivalent = (left: Record<string, number>, right: Record<string, number>): boolean => {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => left[key] === right[key])
}

export function useAllSessionUserActivity(): Record<string, number> {
  return useLiveSyncSelector(
    useCallback((states) => {
      const activity: Record<string, number> = {}
      for (const state of states) {
        for (const [sessionID, timestamp] of Object.entries(state.session_user_activity ?? {})) {
          const current = activity[sessionID]
          activity[sessionID] = current === undefined ? timestamp : Math.max(current, timestamp)
        }
      }
      return activity
    }, []),
    areSessionUserActivityMapsEquivalent,
  )
}

export function useAllLiveSessions(): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => aggregateLiveSessions(states), []),
    areSessionListsEquivalent,
  )
}

// Boot debounce — suppresses redundant refresh/re-bootstrap events during startup.
let bootingRoot = false
let bootedAt = 0
const BOOT_DEBOUNCE_MS = 1500
const GLOBAL_BOOTSTRAP_RETRY_BASE_MS = 500
const GLOBAL_BOOTSTRAP_RETRY_MAX_MS = 5_000
const RECONNECT_MESSAGE_LIMIT = 30
const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30
const ACTIVE_SESSION_RECOVERY_CHECK_MS = 5_000
const RECONNECT_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const ACTIVE_SESSION_RECOVERY_TRACKING_LIMIT = 500

const syncSnapshotSignature = (value: unknown): string => JSON.stringify(value)

function haveEquivalentSyncSnapshots(left: unknown, right: unknown): boolean {
  return syncSnapshotSignature(left) === syncSnapshotSignature(right)
}

// ---------------------------------------------------------------------------
// Session materialization scheduler — when local message/part state is incomplete,
// fetch the canonical session snapshot and materialize messages and parts together.
// Tracked per-directory, deduplicated, and auto-expiring.
// ---------------------------------------------------------------------------

type PendingSessionMaterialization = {
  sessionID: string
  directory: string
  enqueuedAt: number
  attempts: number
  inFlight: boolean
  detectTurnCompletionAfterLoad: boolean
  drainAttempts: number
  retryTimer?: ReturnType<typeof setTimeout>
}

const SESSION_MATERIALIZATION_MAX_RETRIES = 3
const SESSION_MATERIALIZATION_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const
// When a session fetch succeeds but buffered part-deltas still can't apply (the
// streamed part isn't persisted server-side yet — e.g. a part orphaned by a WS
// reconnect gap), retry the fetch a few times so the text renders within ~1 RTT
// instead of staying invisible until the turn goes idle (the "stuck until Stop"
// symptom). Only fires when deltas are genuinely stuck, so normal streaming is
// unaffected.
const PENDING_DELTA_DRAIN_MAX_RETRIES = 4
const PENDING_DELTA_DRAIN_RETRY_MS = 300
const pendingSessionMaterializations = new Map<string, PendingSessionMaterialization>() // key: directory:sessionID
const pendingPartDeltas: PendingPartDeltaStore = new Map()

const materializationKey = (directory: string, sessionID: string) => `${directory}:${sessionID}`

function scheduleSessionMaterialization(
  key: string,
  childStores: ChildStoreManager,
  delayMs = 0,
) {
  const pending = pendingSessionMaterializations.get(key)
  if (!pending) return

  const run = () => {
    const current = pendingSessionMaterializations.get(key)
    if (!current) return
    current.retryTimer = undefined
    void runSessionMaterialization(key, childStores)
  }

  if (delayMs > 0) {
    pending.retryTimer = setTimeout(run, delayMs)
    return
  }

  void Promise.resolve().then(run)
}

async function runSessionMaterialization(key: string, childStores: ChildStoreManager) {
  const pending = pendingSessionMaterializations.get(key)
  if (!pending || pending.inFlight) return

  const store = childStores.getChild(pending.directory)
  if (!store) {
    pendingSessionMaterializations.delete(key)
    return
  }

  pending.inFlight = true
  try {
    const stillPending = await materializeSessionFromServer(pending.directory, pending.sessionID, store)
    await detectAndMarkPlanLifecycle(
      pending.sessionID,
      pending.directory,
      store,
      pending.detectTurnCompletionAfterLoad,
    ).catch(() => undefined)
    const latest = pendingSessionMaterializations.get(key)
    if (stillPending && latest && latest.drainAttempts < PENDING_DELTA_DRAIN_MAX_RETRIES) {
      // Fetch succeeded but buffered part-deltas still can't apply — the streamed
      // part isn't in the server snapshot yet. Retry shortly so the orphaned text
      // renders without waiting for the turn to go idle.
      latest.inFlight = false
      latest.drainAttempts += 1
      latest.enqueuedAt = Date.now()
      scheduleSessionMaterialization(key, childStores, PENDING_DELTA_DRAIN_RETRY_MS)
      return
    }
    pendingSessionMaterializations.delete(key)
  } catch {
    const latest = pendingSessionMaterializations.get(key)
    if (!latest) return

    latest.inFlight = false
    latest.attempts += 1
    if (latest.attempts > SESSION_MATERIALIZATION_MAX_RETRIES) {
      pendingSessionMaterializations.delete(key)
      return
    }

    const retryDelay = SESSION_MATERIALIZATION_RETRY_DELAYS_MS[latest.attempts - 1]
      ?? SESSION_MATERIALIZATION_RETRY_DELAYS_MS[SESSION_MATERIALIZATION_RETRY_DELAYS_MS.length - 1]
    latest.enqueuedAt = Date.now()
    scheduleSessionMaterialization(key, childStores, retryDelay)
  }
}

function enqueueSessionMaterialization(
  directory: string,
  sessionID: string,
  childStores: ChildStoreManager,
  options?: { detectTurnCompletionAfterLoad?: boolean },
) {
  if (!directory || directory === "global" || !sessionID) return
  const k = materializationKey(directory, sessionID)
  const existing = pendingSessionMaterializations.get(k)
  if (existing) {
    existing.detectTurnCompletionAfterLoad ||= options?.detectTurnCompletionAfterLoad === true
    if (existing.inFlight || existing.retryTimer) return
    existing.enqueuedAt = Date.now()
    scheduleSessionMaterialization(k, childStores)
    return
  }

  pendingSessionMaterializations.set(k, {
    sessionID,
    directory,
    enqueuedAt: Date.now(),
    attempts: 0,
    inFlight: false,
    detectTurnCompletionAfterLoad: options?.detectTurnCompletionAfterLoad === true,
    drainAttempts: 0,
  })

  // Defer to next microtask so we don't hold up the current event batch.
  scheduleSessionMaterialization(k, childStores)
}

function resolveSessionIdForMessage(
  state: State,
  routingIndex: EventRoutingIndex,
  messageID: string,
): string | null {
  const indexedSessionID = routingIndex.messageSessionById.get(messageID)
  if (indexedSessionID) {
    return indexedSessionID
  }

  for (const [sessionID, messages] of Object.entries(state.message)) {
    if (messages.some((message) => message.id === messageID)) {
      return sessionID
    }
  }

  return null
}

function resolveLifecycleSessionIdFromPartDelta(
  state: State,
  routingIndex: EventRoutingIndex,
  payload: Event,
): string | null {
  if (payload.type !== "message.part.delta") return null
  const messageID = getMessageIdFromPayload(payload)
  if (!messageID) return null
  return resolveSessionIdForMessage(state, routingIndex, messageID)
}

function resolveLifecycleSessionIdFromPayload(
  state: State,
  routingIndex: EventRoutingIndex,
  payload: Event,
): string | null {
  const directSessionId = getSessionIdFromPayload(payload)
  if (directSessionId) return directSessionId

  if (payload.type !== "message.part.updated") return null
  const messageID = getMessageIdFromPayload(payload)
  if (!messageID) return null
  return resolveSessionIdForMessage(state, routingIndex, messageID)
}

function isIdleOrTerminalSessionStatus(status: SessionStatus | undefined): boolean {
  if (!status) return false
  return status.type === "idle"
}

function shouldDetectPlanLifecycleAfterPartDelta(state: State, sessionID: string): boolean {
  if (isIdleOrTerminalSessionStatus(state.session_status?.[sessionID])) return true
  return shouldSettleTerminalSessionStatus({ sessionID, state })
}

function bufferPendingPartDelta(directory: string, payload: Event) {
  const pending = readPendingPartDeltaFromEvent(payload)
  if (!pending) return
  addPendingPartDelta(pendingPartDeltas, directory, pending)
}

function replayPendingPartDeltasForEvent(
  directory: string,
  payload: Event,
  store: StoreApi<DirectoryStore>,
) {
  if (payload.type !== "message.part.updated") return

  const part = (payload.properties as { part?: Part }).part as (Part & { messageID?: string }) | undefined
  if (!part?.messageID || !part.id) return

  replayPendingPartDeltasForPart(directory, part.messageID, part.id, store)
}

function replayPendingPartDeltasForPart(
  directory: string,
  messageID: string,
  partID: string,
  store: StoreApi<DirectoryStore>,
) {
  if (!directory || directory === "global") return

  const pending = consumePendingPartDeltas(pendingPartDeltas, directory, messageID, partID)
  if (pending.length === 0) return

  const patch = applyPendingPartDeltasToState(store.getState(), messageID, partID, pending)
  if (!patch) {
    for (const pendingDelta of pending) {
      addPendingPartDelta(pendingPartDeltas, directory, pendingDelta)
    }
    return
  }

  store.setState(patch)
}

function replayPendingPartDeltasForSession(
  directory: string,
  sessionID: string,
  store: StoreApi<DirectoryStore>,
) {
  const state = store.getState()
  for (const message of state.message[sessionID] ?? EMPTY_MESSAGES) {
    const parts = state.part[message.id]
    if (!parts) continue
    for (const part of parts) {
      replayPendingPartDeltasForPart(directory, message.id, part.id, store)
    }
  }
}

async function materializeSessionFromServer(
  directory: string,
  sessionID: string,
  store: StoreApi<DirectoryStore>,
) {
  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  const result = await retry(() =>
    scopedClient.session.messages({ sessionID, limit: SESSION_MATERIALIZATION_MESSAGE_LIMIT }).then(unwrapMessageRecordsResult),
  )
  const records = result.filter(hasMessageRecordInfo)
  if (records.length === 0) return false

  store.setState((state: DirectoryStore) => {
    const materialized = materializeSessionSnapshots(
      state,
      sessionID,
      records.map((record) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: RECONNECT_SKIP_PARTS },
    )
    const draft = {
      ...state,
      message: materialized.message,
      part: materialized.part,
      session_user_activity: state.session_user_activity,
    }
    const activityChanged = updateSessionUserActivityFromMessages(draft, sessionID)
    return {
      ...(materialized.sessionsChanged && materialized.session ? { session: materialized.session } : {}),
      message: materialized.message,
      part: materialized.part,
      ...(activityChanged ? { session_user_activity: draft.session_user_activity } : {}),
    }
  })
  replayPendingPartDeltasForSession(directory, sessionID, store)

  // Report whether buffered deltas for this session are still orphaned after the
  // fetch+replay (the streamed part wasn't in the snapshot yet). The caller retries.
  const messageIDs = (store.getState().message[sessionID] ?? EMPTY_MESSAGES).map((message) => message.id)
  return hasPendingPartDeltasForMessages(pendingPartDeltas, directory, messageIDs)
}

const getKnownBlockingRequestSessionIds = (state: State): Set<string> => new Set<string>([
  ...state.session.map((session) => session.id),
  ...Object.keys(state.message ?? {}),
  ...Object.keys(state.session_status ?? {}),
  ...Object.keys(state.question ?? {}),
  ...Object.keys(state.permission ?? {}),
])

const mergeRecoveredSessionsIntoStore = (
  store: StoreApi<DirectoryStore>,
  sessionsToMerge: Session[],
): void => {
  if (sessionsToMerge.length === 0) return

  store.setState((state: DirectoryStore) => {
    let sessions = state.session
    let sessionTotal = state.sessionTotal
    let changed = false

    for (const nextSession of sessionsToMerge) {
      if (!nextSession?.id) continue
      const sessionIndex = sessions.findIndex((item) => item.id === nextSession.id)
      if (sessionIndex >= 0) {
        if (!haveEquivalentSyncSnapshots(sessions[sessionIndex], nextSession)) {
          if (!changed) {
            sessions = [...sessions]
            changed = true
          }
          sessions[sessionIndex] = nextSession
        }
        continue
      }

      if (!changed) {
        sessions = [...sessions]
        changed = true
      }
      sessions.push(nextSession)
      if (!nextSession.parentID) sessionTotal += 1
    }

    if (!changed) return state

    sessions.sort((a, b) => cmp(a.id, b.id))
    return { session: sessions, sessionTotal }
  })
}

const materializeBlockingRequestSessions = async (
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionIds: Iterable<string | null | undefined>,
  routingIndex?: EventRoutingIndex,
): Promise<void> => {
  if (!directory || directory === "global") return

  const state = store.getState()
  const knownSessionIds = new Set(state.session.map((session) => session.id))
  const missingSessionIds: string[] = []
  const seen = new Set<string>()

  for (const rawSessionId of sessionIds) {
    const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : ""
    if (!sessionId || seen.has(sessionId) || knownSessionIds.has(sessionId)) continue
    seen.add(sessionId)
    missingSessionIds.push(sessionId)
  }

  if (missingSessionIds.length === 0) return

  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  const recoveredSessions: Session[] = []

  await Promise.all(missingSessionIds.map(async (sessionID) => {
    const materializationKey = `${directory}\n${sessionID}`
    if (blockingRequestSessionMaterializationsInFlight.has(materializationKey)) return
    blockingRequestSessionMaterializationsInFlight.add(materializationKey)
    try {
      const session = await retry(() =>
        scopedClient.session.get({ sessionID }).then((result) => unwrapSdkResult(result, "session.get")),
      ).catch(() => null)
      if (!session?.id) return

      const recoveredSession = stripSessionDiffSnapshots(session) as Session
      recoveredSessions.push(recoveredSession)
      if (routingIndex) {
        setIndexedSessionDirectory(routingIndex, recoveredSession.id, directory)
      }
    } finally {
      blockingRequestSessionMaterializationsInFlight.delete(materializationKey)
    }
  }))

  mergeRecoveredSessionsIntoStore(store, recoveredSessions)
}

// Module-level refs for notification viewed check.
// Used to determine if user is currently viewing the session when a notification arrives.
let _activeDirectory = ""
let _activeSession = ""
let _activeSessionTrackingKey = ""
const externallyViewedSessions = new Map<string, number>()
const lastStatusEventAtBySessionKey = new Map<string, number>()
const lastOutputEventAtBySessionKey = new Map<string, number>()
const lastRecoveryAtBySessionKey = new Map<string, number>()
const EXTERNAL_VIEW_TTL_MS = 15_000

const viewedSessionKey = (directory: string, sessionId: string) => `${directory}\n${sessionId}`
const statusTrackingKey = (directory: string, sessionId: string) => `${directory}\n${sessionId}`

function rememberBoundedTimestamp(map: Map<string, number>, key: string, timestamp: number) {
  map.delete(key)
  map.set(key, timestamp)
  while (map.size > ACTIVE_SESSION_RECOVERY_TRACKING_LIMIT) {
    const oldest = map.keys().next().value
    if (typeof oldest !== "string") break
    map.delete(oldest)
  }
}

function markStatusEventObserved(directory: string, sessionId: string, timestamp = Date.now()) {
  if (!directory || !sessionId || directory === "global") return
  const key = statusTrackingKey(directory, sessionId)
  rememberBoundedTimestamp(lastStatusEventAtBySessionKey, key, timestamp)
  lastRecoveryAtBySessionKey.delete(key)
}

function markOutputEventObserved(directory: string, sessionId: string | null | undefined, timestamp = Date.now()) {
  if (!directory || !sessionId || directory === "global") return
  const key = statusTrackingKey(directory, sessionId)
  rememberBoundedTimestamp(lastOutputEventAtBySessionKey, key, timestamp)
  lastRecoveryAtBySessionKey.delete(key)
}

function pruneExternallyViewedSessions(now = Date.now()) {
  for (const [key, expiresAt] of externallyViewedSessions.entries()) {
    if (expiresAt <= now) {
      externallyViewedSessions.delete(key)
    }
  }
}
const pendingQuestionToastIds = new Set<string>()
const pendingPermissionToastIds = new Set<string>()

const getQuestionToastKey = (sessionID?: string, requestID?: string) => {
  if (!sessionID || !requestID) return null
  return `${sessionID}:${requestID}`
}

const getPermissionToastKey = (sessionID?: string, requestID?: string) => {
  if (!sessionID || !requestID) return null
  return `${sessionID}:${requestID}`
}

const dropPendingToastKeysForSession = (sessionID: string) => {
  if (!sessionID) return
  const prefix = `${sessionID}:`
  for (const key of pendingQuestionToastIds) {
    if (key.startsWith(prefix)) {
      pendingQuestionToastIds.delete(key)
      toast.dismiss(`question-${key}`)
    }
  }
  for (const key of pendingPermissionToastIds) {
    if (key.startsWith(prefix)) {
      pendingPermissionToastIds.delete(key)
      toast.dismiss(`permission-${key}`)
    }
  }
}

const resolveRootSessionId = (sessions: readonly Session[], sessionID?: string): string | undefined => {
  if (!sessionID) return undefined

  const byId = new Map(sessions.map((session) => [session.id, session]))
  let currentId: string | undefined = sessionID
  const seen = new Set<string>()

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const session = byId.get(currentId)
    const parentID = session ? (session as Session & { parentID?: string | null }).parentID : null
    if (!parentID) return currentId
    currentId = parentID
  }

  return sessionID
}

const openSessionFromToast = (sessionID: string, directory: string) => {
  void import("./session-ui-store")
    .then(({ useSessionUIStore }) => {
      useSessionUIStore.getState().setCurrentSession(sessionID, directory)
    })
    .catch(() => undefined)
}

// Plan lifecycle detection runs after reducer state is current. It is pure
// metadata/message based and never depends on a mounted chat/PlanCard.
async function detectAndMarkPlanLifecycle(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
  shouldDetectTurnCompletion: boolean,
  completionMessageId?: string | null,
): Promise<void> {
  const { useSessionUIStore } = await import("./session-ui-store")
  const sessionUI = useSessionUIStore.getState()
  let state = store.getState()

  if (shouldSettleTerminalSessionStatus({ sessionID, state })) {
    store.setState((current) => {
      const statusType = current.session_status[sessionID]?.type
      if (statusType !== "busy" && statusType !== "retry") return current
      return {
        session_status: {
          ...current.session_status,
          [sessionID]: { type: "idle" as const },
        },
      }
    })
    state = store.getState()
  }

  const planEntry = sessionUI.sessionPlanIndicator.get(sessionID)

  const completedCandidate = detectPlanCompletedCandidate({
    sessionID,
    state,
    planEntry,
    isRecordedPlanModeUserMessage: (messageId) => sessionUI.isUserMessagePlanMode(messageId),
    implementedPlanRequests: sessionUI.implementedPlanRequests,
  })

  const turnCandidate = shouldDetectTurnCompletion && !completedCandidate
    ? detectTurnCompletedCandidate({
        sessionID,
        state,
        isRecordedPlanModeUserMessage: (messageId) => sessionUI.isUserMessagePlanMode(messageId),
        planEntry,
      })
    : null

  const isViewed = isViewedInCurrentSession(directory, sessionID)
  const turnCandidateMatchesTrigger = turnCandidate && (!completionMessageId || turnCandidate.completedMessageId === completionMessageId)
  const settledTurnCandidate = turnCandidate && turnCandidateMatchesTrigger
    && isSessionTurnSettledForCompletion({
      sessionID,
      state,
      completedMessageId: turnCandidate.completedMessageId,
    })
    ? turnCandidate
    : null
  const planCompletionMatchesTrigger = completedCandidate
    && (!completionMessageId || completedCandidate.completedMessageId === completionMessageId)
  const settledPlanCandidate = completedCandidate && planCompletionMatchesTrigger
    && isSessionTurnSettledForCompletion({
      sessionID,
      state,
      completedMessageId: completedCandidate.completedMessageId,
    })
    ? completedCandidate
    : null
  const manualAbortFlag = sessionUI.sessionAbortFlags.get(sessionID)
  const isManuallyAbortedCandidate = (completedMessageId: string) => (
    manualAbortFlag?.reason === "manual" && manualAbortFlag.id === completedMessageId
  )
  const suppressTurnCandidate = settledTurnCandidate
    ? isManuallyAbortedCandidate(settledTurnCandidate.completedMessageId)
    : false
  const suppressPlanCandidate = settledPlanCandidate
    ? isManuallyAbortedCandidate(settledPlanCandidate.completedMessageId)
    : false

  if (settledTurnCandidate && !suppressTurnCandidate && (!isViewed || isActiveInCurrentSession(directory, sessionID))) {
    sessionUI.markSessionTurnCompleted(
      sessionID,
      settledTurnCandidate.completedMessageId,
      getMessageCompletedAt(state, sessionID, settledTurnCandidate.completedMessageId),
    )
  }

  if (shouldDetectTurnCompletion && !isViewed) {
    const session = state.session.find((item) => item.id === sessionID)
    const isSubtask = Boolean((session as (Session & { parentID?: string | null }) | undefined)?.parentID)
    const shouldRecordCompletion = !isSubtask || useUIStore.getState().notifyOnSubtasks

    if (shouldRecordCompletion && settledPlanCandidate && !suppressPlanCandidate) {
      appendNotification({
        directory,
        session: sessionID,
        messageId: settledPlanCandidate.completedMessageId,
        time: Date.now(),
        viewed: false,
        type: "turn-complete",
      })
    } else if (shouldRecordCompletion && settledTurnCandidate && !suppressTurnCandidate) {
      appendNotification({
        directory,
        session: sessionID,
        messageId: settledTurnCandidate.completedMessageId,
        time: Date.now(),
        viewed: false,
        type: "turn-complete",
      })
    }
  }

  if (settledPlanCandidate && !suppressPlanCandidate) {
    sessionUI.markPlanCompleted(sessionID, settledPlanCandidate.sourceMessageId)
  }

  const candidate = detectPlanProposedCandidate({
    sessionID,
    state,
    isRecordedPlanModeUserMessage: (messageId) => sessionUI.isUserMessagePlanMode(messageId),
    implementedPlanRequests: sessionUI.implementedPlanRequests,
  })
  if (!candidate) return

  sessionUI.markPlanProposed(sessionID, candidate.sourceMessageId)
  store.setState((current) => {
    const latestSessionUI = useSessionUIStore.getState()
    if (!shouldSettlePlanProposalStatus({
      sessionID,
      state: current,
      sourceMessageId: candidate.sourceMessageId,
      planEntry: latestSessionUI.sessionPlanIndicator.get(sessionID),
      implementedPlanRequests: latestSessionUI.implementedPlanRequests,
    })) {
      return current
    }

    return {
      session_status: {
        ...current.session_status,
        [sessionID]: { type: "idle" as const },
      },
    }
  })
}

export function setActiveSession(directory: string, sessionId: string) {
  _activeDirectory = directory
  _activeSession = sessionId
  const nextKey = directory && sessionId ? statusTrackingKey(directory, sessionId) : ""
  if (nextKey && nextKey !== _activeSessionTrackingKey) {
    _activeSessionTrackingKey = nextKey
    rememberBoundedTimestamp(lastStatusEventAtBySessionKey, nextKey, Date.now())
    lastRecoveryAtBySessionKey.delete(nextKey)
  } else if (!nextKey) {
    _activeSessionTrackingKey = ""
  }
}

export function setExternallyViewedSession(directory: string, sessionId: string, viewed: boolean) {
  if (!directory || !sessionId) return
  const key = viewedSessionKey(directory, sessionId)
  if (!viewed) {
    externallyViewedSessions.delete(key)
    return
  }
  externallyViewedSessions.set(key, Date.now() + EXTERNAL_VIEW_TTL_MS)
}

function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!sessionId) return false
  if (_activeDirectory && _activeSession && directory === _activeDirectory && sessionId === _activeSession) return true
  pruneExternallyViewedSessions()
  return externallyViewedSessions.has(viewedSessionKey(directory, sessionId))
}

function isActiveInCurrentSession(directory: string, sessionId?: string): boolean {
  return Boolean(sessionId && _activeDirectory && _activeSession && directory === _activeDirectory && sessionId === _activeSession)
}

function isIdleSessionStatusEvent(payload: Event): boolean {
  if (payload.type !== "session.status") return false
  const props = payload.properties as { status?: SessionStatus } | undefined
  return props?.status?.type === "idle"
}

function isWorkingSessionStatusEvent(payload: Event): boolean {
  if (payload.type !== "session.status") return false
  const props = payload.properties as { status?: SessionStatus } | undefined
  const statusType = props?.status?.type
  return statusType === "busy" || statusType === "retry"
}

function clearCompletionForAcceptedWorkingStatus(
  payload: Event,
  store: StoreApi<DirectoryStore>,
): void {
  if (!isWorkingSessionStatusEvent(payload)) return

  const sessionID = getSessionIdFromPayload(payload)
  if (!sessionID) return

  const statusType = store.getState().session_status?.[sessionID]?.type
  if (statusType !== "busy" && statusType !== "retry") return

  void import("./session-ui-store")
    .then(({ useSessionUIStore }) => {
      useSessionUIStore.getState().clearSessionTurnCompletion(sessionID)
    })
    .catch(() => undefined)
}

function getOutputSessionIdFromPayload(
  state: State,
  routingIndex: EventRoutingIndex,
  payload: Event,
): string | null {
  if (payload.type === "message.updated") {
    const info = (payload.properties as { info?: Message }).info
    return typeof info?.sessionID === "string" && info.sessionID.length > 0 ? info.sessionID : null
  }

  if (payload.type === "message.part.updated") {
    const part = (payload.properties as { part?: Part }).part as (Part & { sessionID?: string; messageID?: string }) | undefined
    if (typeof part?.sessionID === "string" && part.sessionID.length > 0) {
      return part.sessionID
    }
    if (typeof part?.messageID === "string" && part.messageID.length > 0) {
      return resolveSessionIdForMessage(state, routingIndex, part.messageID)
    }
    return null
  }

  if (payload.type === "message.part.delta" || payload.type === "message.part.removed") {
    const messageID = getMessageIdFromPayload(payload)
    return messageID ? resolveSessionIdForMessage(state, routingIndex, messageID) : null
  }

  return null
}

function getMessageCompletedAt(state: State, sessionID: string, messageID: string): number | undefined {
  const message = state.message[sessionID]?.find((candidate) => candidate.id === messageID)
  const completedAt = (message?.time as { completed?: unknown } | undefined)?.completed
  return typeof completedAt === "number" && completedAt > 0 ? completedAt : undefined
}

function isRecentBoot() {
  return bootingRoot || Date.now() - bootedAt < BOOT_DEBOUNCE_MS
}

function getViewedSessionMaterializationTarget(directory: string) {
  if (!_activeDirectory || !_activeSession) return null
  if (directory !== _activeDirectory) return null
  return {
    directory: _activeDirectory,
    sessionId: _activeSession,
  }
}

type EventRoutingIndex = {
  sessionDirectoryById: Map<string, string>
  messageSessionById: Map<string, string>
  sessionMessageIdsById: Map<string, Set<string>>
}

const createEventRoutingIndex = (): EventRoutingIndex => ({
  sessionDirectoryById: new Map(),
  messageSessionById: new Map(),
  sessionMessageIdsById: new Map(),
})

const normalizeEventDirectory = (rawDirectory: string): string => {
  if (!rawDirectory || rawDirectory === "global") {
    return rawDirectory
  }
  const normalized = rawDirectory.replace(/\\/g, "/").replace(/^([a-z]):/, (_, l: string) => l.toUpperCase() + ":")
  // Strip trailing slashes to match child store keys (normalizeDirectoryPath in useDirectoryStore)
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

const getSessionIdFromPayload = (event: Event): string | null => {
  const properties = (event as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const props = properties as Record<string, unknown>

  if (event.type === "message.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const sessionID = (info as { sessionID?: unknown }).sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (
    event.type === "message.removed"
    || event.type === "session.status"
    || event.type === "session.idle"
    || event.type === "session.error"
    || event.type === "todo.updated"
    || event.type === "permission.asked"
    || event.type === "permission.replied"
    || event.type === "question.asked"
    || event.type === "question.replied"
    || event.type === "question.rejected"
    || event.type === "session.deleted"
  ) {
    const sessionID = props.sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (event.type === "message.part.updated") {
    const part = props.part
    if (!part || typeof part !== "object") {
      return null
    }
    const sessionID = (part as { sessionID?: unknown }).sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (event.type === "session.created" || event.type === "session.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const id = (info as { id?: unknown }).id
    return typeof id === "string" && id.length > 0 ? id : null
  }

  return null
}

const getMessageIdFromPayload = (event: Event): string | null => {
  const properties = (event as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const props = properties as Record<string, unknown>

  if (event.type === "message.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const id = (info as { id?: unknown }).id
    return typeof id === "string" && id.length > 0 ? id : null
  }

  if (event.type === "message.removed" || event.type === "message.part.delta" || event.type === "message.part.removed") {
    const messageID = props.messageID
    return typeof messageID === "string" && messageID.length > 0 ? messageID : null
  }

  if (event.type === "message.part.updated") {
    const part = props.part
    if (!part || typeof part !== "object") {
      return null
    }
    const messageID = (part as { messageID?: unknown }).messageID
    return typeof messageID === "string" && messageID.length > 0 ? messageID : null
  }

  return null
}

const setIndexedSessionDirectory = (routingIndex: EventRoutingIndex, sessionID: string, directory: string) => {
  if (!sessionID || !directory || directory === "global") {
    return
  }
  routingIndex.sessionDirectoryById.set(sessionID, directory)
}

const setIndexedSessionMessages = (
  routingIndex: EventRoutingIndex,
  sessionID: string,
  directory: string,
  messages: Message[],
) => {
  if (!sessionID) {
    return
  }

  setIndexedSessionDirectory(routingIndex, sessionID, directory)

  const previous = routingIndex.sessionMessageIdsById.get(sessionID)
  const next = new Set<string>()

  for (const message of messages) {
    if (!message?.id) {
      continue
    }
    next.add(message.id)
    routingIndex.messageSessionById.set(message.id, sessionID)
  }

  if (previous) {
    for (const previousMessageID of previous) {
      if (!next.has(previousMessageID)) {
        routingIndex.messageSessionById.delete(previousMessageID)
      }
    }
  }

  routingIndex.sessionMessageIdsById.set(sessionID, next)
}

const setIndexedMessage = (
  routingIndex: EventRoutingIndex,
  sessionID: string,
  messageID: string,
  directory: string,
) => {
  if (!sessionID || !messageID) {
    return
  }

  setIndexedSessionDirectory(routingIndex, sessionID, directory)
  routingIndex.messageSessionById.set(messageID, sessionID)

  const existing = routingIndex.sessionMessageIdsById.get(sessionID)
  if (existing) {
    existing.add(messageID)
  } else {
    routingIndex.sessionMessageIdsById.set(sessionID, new Set([messageID]))
  }
}

const removeIndexedMessage = (
  routingIndex: EventRoutingIndex,
  messageID: string,
  sessionHint?: string | null,
) => {
  if (!messageID) {
    return
  }

  const sessionID = sessionHint ?? routingIndex.messageSessionById.get(messageID)
  routingIndex.messageSessionById.delete(messageID)

  if (!sessionID) {
    return
  }

  const messageIds = routingIndex.sessionMessageIdsById.get(sessionID)
  if (!messageIds) {
    return
  }

  messageIds.delete(messageID)
  if (messageIds.size === 0) {
    routingIndex.sessionMessageIdsById.delete(sessionID)
  }
}

const removeIndexedSession = (routingIndex: EventRoutingIndex, sessionID: string) => {
  if (!sessionID) {
    return
  }

  routingIndex.sessionDirectoryById.delete(sessionID)
  const messageIds = routingIndex.sessionMessageIdsById.get(sessionID)
  if (messageIds) {
    for (const messageID of messageIds) {
      routingIndex.messageSessionById.delete(messageID)
    }
  }
  routingIndex.sessionMessageIdsById.delete(sessionID)
}

const ingestDirectoryStateIntoRoutingIndex = (
  routingIndex: EventRoutingIndex,
  directory: string,
  state: State,
) => {
  const nextSessionIds = new Set<string>()

  for (const session of state.session) {
    if (!session?.id) {
      continue
    }
    nextSessionIds.add(session.id)
    setIndexedSessionDirectory(routingIndex, session.id, directory)
  }

  for (const sessionID of Object.keys(state.message)) {
    nextSessionIds.add(sessionID)
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
    setIndexedSessionMessages(routingIndex, sessionID, directory, state.message[sessionID] ?? EMPTY_MESSAGES)
  }

  for (const [indexedSessionID, indexedDirectory] of routingIndex.sessionDirectoryById) {
    if (indexedDirectory !== directory) {
      continue
    }
    if (!nextSessionIds.has(indexedSessionID)) {
      removeIndexedSession(routingIndex, indexedSessionID)
    }
  }
}

const findSessionInChildStores = (
  sessionID: string,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
): string | null => {
  for (const [dir, store] of childStores.children) {
    const state = store.getState()
    if (
      state.session.some((s) => s.id === sessionID)
      || Object.prototype.hasOwnProperty.call(state.message, sessionID)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
    ) {
      // Self-heal: populate the routing index so future events resolve instantly
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
      return dir
    }
  }
  return null
}

const childStoreHasSessionState = (
  childStores: ChildStoreManager,
  directory: string,
  sessionID: string,
): boolean => {
  const store = childStores.getChild(directory)
  if (!store) return false
  const state = store.getState()
  return state.session.some((session) => session.id === sessionID)
    || Object.prototype.hasOwnProperty.call(state.message, sessionID)
    || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
}

const childStoreHasMessagePartState = (
  childStores: ChildStoreManager,
  directory: string,
  messageID: string,
): boolean => {
  const store = childStores.getChild(directory)
  if (!store) return false
  return Object.prototype.hasOwnProperty.call(store.getState().part, messageID)
}

const resolveDirectoryFromRoutingIndex = (
  routingIndex: EventRoutingIndex,
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
): string => {
  const normalizedDirectory = normalizeEventDirectory(rawDirectory)

  const sessionID = getSessionIdFromPayload(payload)
  if (sessionID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasSessionState(childStores, normalizedDirectory, sessionID)) {
      setIndexedSessionDirectory(routingIndex, sessionID, normalizedDirectory)
      return normalizedDirectory
    }

    const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionID)
    if (indexedDirectory && childStores.getChild(indexedDirectory)) {
      return indexedDirectory
    }

    // Routing index miss — scan child stores for this session.
    // Covers optimistic sessions not yet indexed and events with wrong/empty directory.
    const found = findSessionInChildStores(sessionID, childStores, routingIndex)
    if (found) {
      return found
    }
  }

  const messageID = getMessageIdFromPayload(payload)
  if (messageID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasMessagePartState(childStores, normalizedDirectory, messageID)) {
      return normalizedDirectory
    }

    const sessionFromMessage = routingIndex.messageSessionById.get(messageID)
    if (sessionFromMessage) {
      const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionFromMessage)
      if (indexedDirectory && childStores.getChild(indexedDirectory)) {
        return indexedDirectory
      }
    }

    // Scan child stores for a store that has parts for this message
    for (const [dir, store] of childStores.children) {
      if (Object.prototype.hasOwnProperty.call(store.getState().part, messageID)) {
        return dir
      }
    }
  }

  // Single-store fallback: if there's only one directory, use it
  if (
    (sessionID || messageID)
    && (!normalizedDirectory || normalizedDirectory === "global")
    && childStores.children.size === 1
  ) {
    const onlyDirectory = childStores.children.keys().next().value
    if (typeof onlyDirectory === "string" && onlyDirectory.length > 0) {
      return onlyDirectory
    }
  }

  return normalizedDirectory
}

const updateRoutingIndexFromEvent = (
  routingIndex: EventRoutingIndex,
  directory: string,
  payload: Event,
) => {
  if (!directory || directory === "global") {
    return
  }

  const sessionID = getSessionIdFromPayload(payload)
  if (sessionID) {
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
  }

  switch (payload.type) {
    case "session.created":
    case "session.updated": {
      const info = (payload.properties as { info?: Session }).info
      if (info?.id) {
        setIndexedSessionDirectory(routingIndex, info.id, directory)
      }
      return
    }

    case "session.deleted": {
      const deletedSessionID = (payload.properties as { sessionID?: string }).sessionID
      if (deletedSessionID) {
        removeIndexedSession(routingIndex, deletedSessionID)
      }
      return
    }

    case "message.updated": {
      const info = (payload.properties as { info?: Message }).info
      if (info?.id && info.sessionID) {
        setIndexedMessage(routingIndex, info.sessionID, info.id, directory)
      }
      return
    }

    case "message.removed": {
      const props = payload.properties as { sessionID?: string; messageID?: string }
      if (props.messageID) {
        removeIndexedMessage(routingIndex, props.messageID, props.sessionID)
      }
      return
    }

    case "message.part.updated": {
      const part = (payload.properties as { part?: Part }).part as (Part & { sessionID?: string; messageID?: string }) | undefined
      if (part?.messageID && part.sessionID) {
        setIndexedMessage(routingIndex, part.sessionID, part.messageID, directory)
      }
      return
    }

    default:
      return
  }
}

/**
 * Re-fetch pending questions and permissions for a directory and merge them
 * into the directory's child store, preserving any in-flight SSE updates that
 * arrived while the request was pending. Used by reconnect/materialization
 * recovery paths only; normal session switches rely on primary SSE reducer
 * state for `question.asked` / `permission.asked` events. When
 * `candidateSessionIds` is omitted, every session known to the directory store
 * is treated as a candidate.
 */
export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
) {
  const before = store.getState()
  let knownSessionIds = getKnownBlockingRequestSessionIds(before)
  const candidates = candidateSessionIds ?? Array.from(knownSessionIds)
  if (candidates.length === 0) return

  // Re-fetch pending questions that may have been asked during an SSE gap,
  // reconnect window, or directory materialization gap.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.question[sessionId])]),
    )
    const pendingQuestions = await opencodeClient.listPendingQuestions({ directories: [directory] })
    await materializeBlockingRequestSessions(directory, store, pendingQuestions.map((q) => q?.sessionID))
    knownSessionIds = getKnownBlockingRequestSessionIds(store.getState())
    const grouped: Record<string, QuestionRequest[]> = {}
    for (const q of pendingQuestions) {
      if (!q?.id || !q.sessionID) continue
      if (!knownSessionIds.has(q.sessionID)) continue
      const list = grouped[q.sessionID]
      if (list) list.push(q)
      else grouped[q.sessionID] = [q]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    for (const [sessionId, questions] of Object.entries(grouped)) {
      const knownIds = new Set((before.question[sessionId] ?? []).map((item) => item.id))
      const rootSessionId = resolveRootSessionId(before.session, sessionId) ?? sessionId
      const isViewed = isViewedInCurrentSession(directory, rootSessionId)
      if (isViewed) continue
      for (const question of questions) {
        if (knownIds.has(question.id)) continue
        appendNotification({
          directory,
          session: rootSessionId,
          time: Date.now(),
          viewed: false,
          type: "question",
        })
        const toastKey = getQuestionToastKey(sessionId, question.id)
        if (!toastKey || pendingQuestionToastIds.has(toastKey)) continue
        pendingQuestionToastIds.add(toastKey)
        const firstQuestion = question.questions?.[0]
        const title = firstQuestion?.header?.trim() || "Input needed"
        const description = firstQuestion?.question?.trim() || "Agent is waiting for your response"
        toast.info(title, {
          id: `question-${toastKey}`,
          description,
          action: {
            label: "Open session",
            onClick: () => openSessionFromToast(sessionId, directory),
          },
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.question }
      for (const [sessionId, questions] of Object.entries(grouped)) {
        merged[sessionId] = questions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.question[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { question: merged }
    })
  } catch {
    // Non-fatal: question resync best-effort
  }

  // Re-fetch pending permissions — same rationale as questions.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    )
    const pendingPermissions = await opencodeClient.listPendingPermissions({ directories: [directory] })
    await materializeBlockingRequestSessions(directory, store, pendingPermissions.map((permission) => permission?.sessionID))
    knownSessionIds = getKnownBlockingRequestSessionIds(store.getState())
    const grouped: Record<string, PermissionRequest[]> = {}
    for (const permission of pendingPermissions) {
      if (!permission?.id || !permission.sessionID) continue
      if (!knownSessionIds.has(permission.sessionID)) continue
      const list = grouped[permission.sessionID]
      if (list) list.push(permission)
      else grouped[permission.sessionID] = [permission]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    const permissionStore = usePermissionStore.getState()
    const autoAcceptingSessionIds = Object.keys(grouped).filter((sessionId) => permissionStore.isSessionAutoAccepting(sessionId))

    if (autoAcceptingSessionIds.length > 0) {
      await Promise.all(
        autoAcceptingSessionIds.flatMap((sessionId) =>
          (grouped[sessionId] ?? []).map((permission) =>
            sessionActions.respondToPermission(permission.sessionID, permission.id, "once").catch(() => undefined),
          ),
        ),
      )

      for (const sessionId of autoAcceptingSessionIds) {
        delete grouped[sessionId]
      }
    }

    for (const [sessionId, permissions] of Object.entries(grouped)) {
      const knownIds = new Set((before.permission[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const permission of permissions) {
        if (knownIds.has(permission.id)) continue
        const toastKey = getPermissionToastKey(sessionId, permission.id)
        if (!toastKey || pendingPermissionToastIds.has(toastKey)) continue
        pendingPermissionToastIds.add(toastKey)
        const description = typeof permission.permission === "string" && permission.permission.trim().length > 0
          ? permission.permission
          : "Agent needs your approval"
        toast.info("Permission needed", {
          id: `permission-${toastKey}`,
          description,
          action: {
            label: "Open session",
            onClick: () => openSessionFromToast(sessionId, directory),
          },
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.permission }
      for (const [sessionId, permissions] of Object.entries(grouped)) {
        merged[sessionId] = permissions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.permission[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { permission: merged }
    })
  } catch {
    // Non-fatal: permission resync best-effort
  }
}

export async function resyncDirectoryAfterReconnect(
  directory: string,
  store: StoreApi<DirectoryStore>,
  routingIndex: EventRoutingIndex,
  options?: { candidateSessionIds?: Iterable<string> },
) {
  const current = store.getState()
  const candidateSessionIds = new Set(getReconnectCandidateSessionIds(current, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  }))
  for (const sessionId of options?.candidateSessionIds ?? []) {
    if (sessionId) candidateSessionIds.add(sessionId)
  }
  if (candidateSessionIds.size === 0) return

  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  const nextStatuses = await retry(async () => {
    const result = await scopedClient.session.status()
    return unwrapSdkResult(result, "session.status")
  }).catch(() => null)

  if (nextStatuses) {
    const currentStatuses = store.getState().session_status ?? {}
    const mergedStatuses = mergeRecoveredSessionStatuses({
      current: currentStatuses,
      candidateSessionIds,
      authoritative: nextStatuses,
      state: store.getState(),
    })

    if (mergedStatuses !== currentStatuses) {
      store.setState((state: DirectoryStore) => {
        const latestMerged = mergeRecoveredSessionStatuses({
          current: state.session_status ?? {},
          candidateSessionIds,
          authoritative: nextStatuses,
          state,
        })
        if (latestMerged === state.session_status) {
          return state
        }
        return { session_status: latestMerged }
      })
    }
  }

  await Promise.all(Array.from(candidateSessionIds).map(async (sessionId) => {
    const [sessionResponse, messageResponse] = await Promise.all([
      retry(() => scopedClient.session.get({ sessionID: sessionId }).then((result) => unwrapSdkResult(result, "session.get"))).catch(() => null),
      retry(() => scopedClient.session.messages({ sessionID: sessionId, limit: RECONNECT_MESSAGE_LIMIT }).then(unwrapMessageRecordsResult)).catch(() => null),
    ])
    const session = sessionResponse
    const records = messageResponse
    if (!session || !records) return

    const materializedRecords = records.filter(hasMessageRecordInfo)
    const nextMessages = materializedRecords
      .map((record) => stripMessageDiffSnapshots(record.info))
      .sort((a, b) => cmp(a.id, b.id))
    const nextSession = normalizeChatOwnedDiffSummary(
      stripSessionDiffSnapshots(session) as Session & { summary?: SessionSummaryDiffStats | null },
      nextMessages as Array<Message & { summary?: SessionSummaryDiffStats | null }>,
    ) as Session

    store.setState((state: DirectoryStore) => {
      const sessionIndex = state.session.findIndex((item) => item.id === nextSession.id)
      let sessions = state.session
      let sessionChanged = false
      let sessionTotal = state.sessionTotal

      if (sessionIndex >= 0) {
        if (!haveEquivalentSyncSnapshots(sessions[sessionIndex], nextSession)) {
          sessions = [...state.session]
          sessions[sessionIndex] = nextSession
          sessionChanged = true
        }
      } else {
        sessions = [...state.session]
        sessions.push(nextSession)
        sessions.sort((a, b) => cmp(a.id, b.id))
        if (!nextSession.parentID) sessionTotal += 1
        sessionChanged = true
      }

      const materializedBaseState = sessionChanged ? { ...state, session: sessions } : state
      const materialized = materializeSessionSnapshots(
        materializedBaseState,
        sessionId,
        materializedRecords.map((record) => ({
          info: stripMessageDiffSnapshots(record.info),
          parts: record.parts ?? [],
        })),
        { skipPartTypes: RECONNECT_SKIP_PARTS },
      )
      if (materialized.sessionsChanged && materialized.session) {
        sessions = materialized.session
        sessionChanged = true
      }
      const messagesChanged = materialized.messagesChanged
      const partsChanged = materialized.partsChanged
      const activityDraft = {
        ...state,
        message: materialized.message,
        part: materialized.part,
        session_user_activity: state.session_user_activity,
      }
      const activityChanged = updateSessionUserActivityFromMessages(activityDraft, sessionId)
      if (!sessionChanged && !messagesChanged && !partsChanged && !activityChanged) {
        return state
      }

      return {
        ...(sessionChanged ? { session: sessions, sessionTotal } : {}),
        ...(messagesChanged ? { message: materialized.message } : {}),
        ...(partsChanged ? { part: materialized.part } : {}),
        ...(activityChanged ? { session_user_activity: activityDraft.session_user_activity } : {}),
      }
    })

    setIndexedSessionDirectory(routingIndex, nextSession.id, directory)
    setIndexedSessionMessages(routingIndex, sessionId, directory, nextMessages)
  }))

  await resyncBlockingRequestsForDirectory(directory, store, Array.from(candidateSessionIds))

  if (nextStatuses) {
    store.setState((state: DirectoryStore) => {
      const latestMerged = mergeRecoveredSessionStatuses({
        current: state.session_status ?? {},
        candidateSessionIds,
        authoritative: nextStatuses,
        state,
      })
      if (latestMerged === state.session_status) {
        return state
      }
      return { session_status: latestMerged }
    })
  }

  ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
}

function handleEvent(
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
) {
  const directory = resolveDirectoryFromRoutingIndex(routingIndex, rawDirectory, payload, childStores)

  // Global events
  if (directory === "global" || !directory) {
    const recent = isRecentBoot()
    const result = reduceGlobalEvent(payload)
    if (!result) return
    if (result.type === "refresh") {
      // Suppress refresh during/shortly after bootstrap
      if (!recent) {
        useGlobalSyncStore.setState({ reload: "pending" })
      }
    } else if (result.type === "project") {
      const current = useGlobalSyncStore.getState()
      useGlobalSyncStore.setState({
        projects: applyGlobalProject(current, result.project).projects,
      })
    }
    // On server.connected / global.disposed, re-bootstrap all directories
    // but only if not during recent boot
    if (payload.type === "server.connected" || payload.type === "global.disposed") {
      if (!recent) {
        for (const dir of childStores.children.keys()) {
          const store = childStores.getChild(dir)
          if (store && store.getState().status !== "loading") {
            // Mark as loading to trigger re-bootstrap
            store.setState({ status: "loading" as const })
            childStores.ensureChild(dir)
          }
        }
      }
    }
    return
  }

  // Directory events
  let store = childStores.getChild(directory)
  let resolvedDirectory = directory

  if (!store) {
    // Store not found for this directory — attempt recovery by scanning
    // child stores for the session. This handles directory mismatches
    // (trailing slashes, case differences, events with wrong directory).
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID) {
      const fallbackDir = findSessionInChildStores(sessionID, childStores, routingIndex)
      if (fallbackDir) {
        store = childStores.getChild(fallbackDir)
        resolvedDirectory = fallbackDir
      }
    }
  }

  if (!store) {
    // Try as global event for unknown directories
    const result = reduceGlobalEvent(payload)
    if (result?.type === "refresh") {
      useGlobalSyncStore.setState({ reload: "pending" })
    } else if (result?.type === "project") {
      const current = useGlobalSyncStore.getState()
      useGlobalSyncStore.setState({
        projects: applyGlobalProject(current, result.project).projects,
      })
    }
    return
  }

  childStores.mark(resolvedDirectory)

  if (payload.type === "session.status") {
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID) {
      markStatusEventObserved(resolvedDirectory, sessionID)
    }
  }

  if (payload.type === "permission.asked") {
    const permission = payload.properties as PermissionRequest
    const permissionStore = usePermissionStore.getState()
    if (permissionStore.isSessionAutoAccepting(permission.sessionID)) {
      updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
      void sessionActions.respondToPermission(permission.sessionID, permission.id, "once").catch(() => undefined)
      return
    }

    const toastKey = getPermissionToastKey(permission.sessionID, permission.id)
    const isViewed = isViewedInCurrentSession(resolvedDirectory, permission.sessionID)
    if (!isViewed && toastKey && !pendingPermissionToastIds.has(toastKey)) {
      pendingPermissionToastIds.add(toastKey)
      const description = typeof permission.permission === "string" && permission.permission.trim().length > 0
        ? permission.permission
        : "Agent needs your approval"
      toast.info("Permission needed", {
        id: `permission-${toastKey}`,
        description,
        action: {
          label: "Open session",
          onClick: () => openSessionFromToast(permission.sessionID, resolvedDirectory),
        },
      })
    }
  }

  if (payload.type === "permission.replied") {
    const props = payload.properties as { sessionID?: string; requestID?: string }
    const toastKey = getPermissionToastKey(props.sessionID, props.requestID)
    if (toastKey) {
      pendingPermissionToastIds.delete(toastKey)
      toast.dismiss(`permission-${toastKey}`)
    }
  }

  if (payload.type === "question.asked") {
    const question = payload.properties as QuestionRequest
    const sessionID = question.sessionID
    const rootSessionID = resolveRootSessionId(store.getState().session, sessionID) ?? sessionID
    const toastKey = getQuestionToastKey(sessionID, question.id)
    const isViewed = isViewedInCurrentSession(resolvedDirectory, rootSessionID)
    if (!isViewed && rootSessionID) {
      appendNotification({
        directory: resolvedDirectory,
        session: rootSessionID,
        time: Date.now(),
        viewed: false,
        type: "question",
      })
    }
    if (!isViewed && toastKey && !pendingQuestionToastIds.has(toastKey)) {
      pendingQuestionToastIds.add(toastKey)
      const firstQuestion = question.questions?.[0]
      const title = firstQuestion?.header?.trim() || "Input needed"
      const description = firstQuestion?.question?.trim() || "Agent is waiting for your response"
      toast.info(title, {
        id: `question-${toastKey}`,
        description,
        action: {
          label: "Open session",
          onClick: () => openSessionFromToast(sessionID, resolvedDirectory),
        },
      })
    }
  }

  if (payload.type === "question.replied" || payload.type === "question.rejected") {
    const props = payload.properties as { sessionID?: string; requestID?: string }
    const toastKey = getQuestionToastKey(props.sessionID, props.requestID)
    if (toastKey) {
      pendingQuestionToastIds.delete(toastKey)
      toast.dismiss(`question-${toastKey}`)
    }
  }

  if (payload.type === "session.deleted") {
    const info = (payload.properties as { info?: { id?: string } }).info
    const sessionID = info?.id
    if (sessionID) {
      dropPendingToastKeysForSession(sessionID)
    }
  }

  // Notification dispatch for terminal error events.
  // These are NOT handled by the event reducer — only the notification store.
  if (payload.type === "session.error") {
    const props = payload.properties as {
      sessionID?: string
      error?: { message?: string; code?: string; name?: string; data?: { message?: string } }
    }
    const sessionID = props.sessionID
    if (sessionID) {
      const viewed = isViewedInCurrentSession(resolvedDirectory, sessionID)
      appendNotification({
        directory: resolvedDirectory,
        session: sessionID,
        time: Date.now(),
        viewed,
        type: "error",
        error: props.error,
      })

      const errorDetail = [
        typeof props.error?.data?.message === "string" ? props.error.data.message : "",
        typeof props.error?.message === "string" ? props.error.message : "",
        typeof props.error?.name === "string" ? props.error.name : "",
      ].find((value) => value.trim().length > 0) || ""
      if (
        isLikelyProviderModelNotFound(errorDetail)
        || props.error?.name === "ProviderModelNotFoundError"
      ) {
        toast.error(PROVIDER_MODEL_NOT_FOUND_MESSAGE, {
          id: `provider-model-not-found-${sessionID}`,
          description: errorDetail || undefined,
        })
      }
    }
  }

  // Sync-layer parent resync: when a child session reaches a terminal state,
  // recover the parent session snapshot. This ensures the parent's task tool
  // part reflects child completion/error/abort even when no ToolPart component
  // is mounted.
  const terminalChildSessionId = getTerminalSessionIdForParentMaterialization(payload)
  if (terminalChildSessionId && resolvedDirectory && resolvedDirectory !== "global") {
    const parentID = resolveParentSessionIdForTerminalChild(store.getState(), terminalChildSessionId)
    if (parentID) {
      enqueueSessionMaterialization(resolvedDirectory, parentID, childStores)
    }
  }

  // Read live state, create targeted draft cloning ONLY fields that event
  // type will mutate. This preserves reference identity for untouched slices
  // so Zustand selectors skip re-renders for unrelated subscribers.
  const current = store.getState()
  markOutputEventObserved(resolvedDirectory, getOutputSessionIdFromPayload(current, routingIndex, payload))
  markFirstAssistantStreamForDebug(current, payload)
  const draft: State = { ...current }
  const sessionUpdateInfo = payload.type === "session.updated"
    ? (payload.properties as { info?: Session }).info
    : undefined
  const wasKnownActiveSession = sessionUpdateInfo
    ? current.session.some((session) => session.id === sessionUpdateInfo.id)
    : false

  switch (payload.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted":
      draft.session = [...current.session]
      draft.revert_transaction = { ...current.revert_transaction }
      draft.permission = { ...current.permission }
      draft.todo = { ...current.todo }
      draft.part = { ...current.part }
      break
    case "session.diff":
      draft.session_diff = { ...current.session_diff }
      draft.session = [...current.session]
      break
    case "session.status":
    case "session.idle":
    case "session.error":
      draft.session_status = { ...(current.session_status ?? {}) }
      break
    case "todo.updated":
      draft.todo = { ...current.todo }
      break
    case "message.updated":
      draft.message = { ...current.message }
      if (shouldSettleTerminalAssistantMessageStatus(current, (payload.properties as { info?: Message }).info)) {
        draft.session_status = { ...(current.session_status ?? {}) }
      }
      break
    case "message.removed":
      draft.message = { ...current.message }
      draft.part = { ...current.part }
      break
    case "message.part.removed":
    case "message.part.delta":
      draft.part = { ...current.part }
      break
    case "message.part.updated":
      draft.message = { ...current.message }
      draft.part = { ...current.part }
      break
    case "vcs.branch.updated":
      break
    case "permission.asked":
    case "permission.replied":
      draft.permission = { ...current.permission }
      break
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      draft.question = { ...current.question }
      break
    case "lsp.updated":
      draft.lsp = [...current.lsp]
      break
    default:
      break
  }

  const reducerStartedAt = nowMs()
  const reducerResult = applyDirectoryEvent(draft, payload, {
    onSetSessionTodo: (sessionID, todos) => {
      useTodosPersistStore.getState().setSessionTodos(sessionID, todos)
    },
    // Hot path: the reducer would otherwise scan every cached session per
    // message.part.delta to find the owning session. Resolve from the routing
    // index instead; reducer falls back to its scan when this returns nothing.
    resolveSessionIDForMessage: (messageID) =>
      routingIndex.messageSessionById.get(messageID),
  })
  responsivenessPerfObserve(`sync.apply.${payload.type}.ms`, nowMs() - reducerStartedAt)
  const reducerChanged = typeof reducerResult === "boolean" ? reducerResult : reducerResult.changed
  responsivenessPerfCount(reducerChanged ? "sync.event.changed" : "sync.event.noop")
  const materializationResult = typeof reducerResult === "boolean" ? undefined : reducerResult.materialization

  if (!reducerChanged && materializationResult && payload.type === "message.part.delta") {
    bufferPendingPartDelta(resolvedDirectory, payload)
  }

  if (reducerChanged) {
    store.setState(draft)
    markRendererReducedEvent(payload, resolvedDirectory, store.getState(), routingIndex)
    if (sessionUpdateInfo?.id) {
      if (sessionUpdateInfo.time?.archived) {
        markArchived(sessionUpdateInfo.id, resolvedDirectory)
      } else if (!wasKnownActiveSession) {
        // Decision: a non-archived update for a session missing from the active
        // child store is treated as unarchive/materialization recovery. Existing
        // active title/status updates should not restart hydration work.
        markUnarchived(sessionUpdateInfo.id, resolvedDirectory)
      }
    }
    if (payload.type === "permission.asked") {
      const permission = payload.properties as PermissionRequest
      const hasSessionRecord = store.getState().session.some((session) => session.id === permission.sessionID)
      if (!hasSessionRecord) {
        // Decision: keep the permission in state immediately, then recover the
        // session lineage asynchronously so parent chats can prove ownership
        // before rendering a subagent permission card.
        void materializeBlockingRequestSessions(resolvedDirectory, store, [permission.sessionID], routingIndex)
          .then(() => {
            const pending = store.getState().permission[permission.sessionID]
              ?.some((entry) => entry.id === permission.id) ?? false
            if (pending && usePermissionStore.getState().isSessionAutoAccepting(permission.sessionID)) {
              void sessionActions.respondToPermission(permission.sessionID, permission.id, "once").catch(() => undefined)
            }
          })
      }
    }
    const sessionID = getSessionIdFromPayload(payload) ?? undefined
    const messageID = getMessageIdFromPayload(payload) ?? undefined
    syncDebug.dispatch.eventApplied(payload.type, sessionID, messageID)

    // Snapshot materialization on message.updated: if the message was inserted or
    // replaced but draft.part[messageID] is empty, the parts were lost or
    // never arrived. Recover the session so the UI doesn't render a blank bubble.
    if (sessionID && messageID && payload.type === "message.updated") {
      const after = store.getState()
      const info = (payload.properties as { info: Message }).info
      if (info.role === "assistant" && (!after.part[messageID] || after.part[messageID].length === 0)) {
        enqueueSessionMaterialization(resolvedDirectory, sessionID, childStores)
      }
    }
  } else {
    const sessionID = getSessionIdFromPayload(payload) ?? undefined
    const messageID = getMessageIdFromPayload(payload) ?? undefined
    syncDebug.dispatch.eventNoChange(payload.type, sessionID, messageID)

  }

  // Snapshot materialization is driven by typed reducer outcomes, not by
  // inferring meaning from a generic false/no-change result.
  if (materializationResult) {
    const materializationSessionID = materializationResult.sessionID
      ?? getSessionIdFromPayload(payload)
      ?? resolveSessionIdForMessage(store.getState(), routingIndex, materializationResult.messageID)
      ?? undefined
    if (materializationSessionID) {
      enqueueSessionMaterialization(resolvedDirectory, materializationSessionID, childStores)
    }
  }

  clearCompletionForAcceptedWorkingStatus(payload, store)

  replayPendingPartDeltasForEvent(resolvedDirectory, payload, store)

  if (
    payload.type === "session.idle"
    || isIdleSessionStatusEvent(payload)
    || payload.type === "session.updated"
    || payload.type === "message.updated"
    || payload.type === "message.part.updated"
  ) {
    const latestState = store.getState()
    const lifecycleSessionId = resolveLifecycleSessionIdFromPayload(latestState, routingIndex, payload)
    if (lifecycleSessionId) {
      if (
        (payload.type === "session.idle" || isIdleSessionStatusEvent(payload))
        && !getSessionMaterializationStatus(latestState, lifecycleSessionId).renderable
      ) {
        enqueueSessionMaterialization(resolvedDirectory, lifecycleSessionId, childStores, {
          detectTurnCompletionAfterLoad: true,
        })
      }
      void detectAndMarkPlanLifecycle(
        lifecycleSessionId,
        resolvedDirectory,
        store,
        payload.type === "session.idle"
          || isIdleSessionStatusEvent(payload)
          || payload.type === "message.updated"
          || payload.type === "message.part.updated",
        payload.type === "message.part.updated" ? getMessageIdFromPayload(payload) : null,
      ).catch(() => undefined)
    }
  } else if (payload.type === "message.part.delta" && reducerChanged) {
    const lifecycleSessionId = resolveLifecycleSessionIdFromPartDelta(store.getState(), routingIndex, payload)
    const latestState = store.getState()
    if (
      lifecycleSessionId
      && shouldDetectPlanLifecycleAfterPartDelta(latestState, lifecycleSessionId)
    ) {
      void detectAndMarkPlanLifecycle(
        lifecycleSessionId,
        resolvedDirectory,
        store,
        false,
      ).catch(() => undefined)
    }
  }

  updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
}

/** Test hook: apply one sync event through the production handler. */
export function applySyncEventForTest(
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
) {
  handleEvent(rawDirectory, payload, childStores, routingIndex)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SyncProvider(props: {
  sdk: OpencodeClient
  directory: string
  children: React.ReactNode
}) {
  const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport)
  const childStoresRef = useRef<ChildStoreManager | null>(null)
  if (!childStoresRef.current) childStoresRef.current = new ChildStoreManager()
  const childStores = childStoresRef.current
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current
  setSessionMaterializerChildStores(childStores)

  const resyncSession = useCallback(
    async (sessionID: string, options?: { directory?: string | null; reason?: "focus" | "reconnect" | "manual" }) => {
      if (!sessionID) return
      const directory = options?.directory || props.directory
      if (!directory) return
      const store = childStores.ensureChild(directory)
      await resyncDirectoryAfterReconnect(directory, store, routingIndex, {
        candidateSessionIds: [sessionID],
      })
    },
    [childStores, props.directory, routingIndex],
  )

  const system = useMemo<SyncSystem>(
    () => ({
      childStores,
      sdk: props.sdk,
      directory: props.directory,
      resyncSession,
    }),
    [childStores, props.sdk, props.directory, resyncSession],
  )

  // Configure child store manager
  useEffect(() => {
    const bootingDirs = new Set<string>()

    childStores.configure({
      onBootstrap: (directory) => {
        if (bootingDirs.has(directory)) return
        bootingDirs.add(directory)

        const store = childStores.getChild(directory)
        if (!store) return

        const runBootstrap = async () => {
          const globalState = useGlobalSyncStore.getState()
          await bootstrapDirectory({
            directory,
            sdk: props.sdk,
            getState: () => store.getState(),
            set: (patch) => {
              store.setState(patch)
              if (patch.session || patch.message) {
                ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
              }
            },
            global: {
              config: globalState.config,
              projects: globalState.projects,
              providers: globalState.providers,
            },
            loadSessions: (dir) => retry(async () => {
              store.setState({ sessionListStatus: "loading", sessionListError: undefined })
              const result = await props.sdk.session.list({
                directory: dir,
                roots: true,
                limit: 50,
              })
              // SDK returns { error } instead of { data } on non-ok responses (503).
              // Preserve HTTP status so retry()'s transient detection works.
              const rawError = (result as { error?: unknown }).error
              if (rawError) {
                const response = (result as { response?: { status?: number } }).response
                const status = response?.status
                const message = typeof rawError === "object" && rawError !== null && "message" in rawError
                  ? String((rawError as { message?: unknown }).message)
                  : String(rawError)
                const wrapped = new Error(`session.list failed${status ? ` (${status})` : ""}: ${message}`)
                if (status !== undefined) {
                  ;(wrapped as Error & { status?: number }).status = status
                }
                throw wrapped
              }
              const sessions = (result.data ?? [])
                .filter((s) => !!s?.id)
                .map((session) => stripUntrustedSessionDiffSummary(
                  stripSessionDiffSnapshots(session) as Session & { summary?: SessionSummaryDiffStats | null },
                ) as Session)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              // Race guard: if the list came back empty but event pipeline
              // already populated the store, don't clobber. OpenCode can
              // answer HTTP with empty sessions while WS delivers session
              // events for the same data (disk warmup race on app launch).
              const currentSessions = store.getState().session
              if (sessions.length === 0 && currentSessions.length > 0) {
                console.warn(
                  `[bootstrap] session.list returned empty for ${dir}; preserving ${currentSessions.length} existing sessions`,
                )
                store.setState({ sessionListStatus: "ready", sessionListError: undefined })
                return
              }
              store.setState({
                session: sessions,
                sessionTotal: sessions.length,
                limit: Math.max(sessions.length, 50),
                sessionListStatus: "ready",
                sessionListError: undefined,
              })
              ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
            }),
          })
        }

        runBootstrap().finally(() => {
          bootingDirs.delete(directory)
        })
      },
      onDispose: (directory) => {
        bootingDirs.delete(directory)
      },
      isBooting: (directory) => bootingDirs.has(directory),
      isLoadingSessions: () => false,
    })
  }, [childStores, props.sdk, routingIndex])

  // Bootstrap global state — set bootingRoot/bootedAt to suppress
  // redundant refresh events during startup
  useEffect(() => {
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryAttempt = 0
    bootingRoot = true
    const globalActions = useGlobalSyncStore.getState().actions

    const runGlobalBootstrap = () => {
      if (!active) return
      void bootstrapGlobal(props.sdk, globalActions.set)
        .then((result) => {
          if (!active) return
          if (result.ready || !result.retryable) {
            bootedAt = Date.now()
            bootingRoot = false
            return
          }
          const delay = Math.min(
            GLOBAL_BOOTSTRAP_RETRY_BASE_MS * Math.pow(2, retryAttempt),
            GLOBAL_BOOTSTRAP_RETRY_MAX_MS,
          )
          retryAttempt += 1
          retryTimer = setTimeout(runGlobalBootstrap, delay)
        })
        .catch((error) => {
          if (!active) return
          bootedAt = Date.now()
          bootingRoot = false
          const message = error instanceof Error ? error.message : String(error)
          globalActions.set({ ready: true, error: { type: "init", message } })
        })
    }

    runGlobalBootstrap()

    return () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
      if (bootingRoot) {
        bootedAt = Date.now()
        bootingRoot = false
      }
    }
  }, [props.sdk])

  // Event pipeline — created once per mount. No class, no start/stop.
  // Abort controller owned by the pipeline closure. Cleanup aborts + flushes.
  useEffect(() => {
    const reconnectMaterializing = new Set<string>()
    const triggerReconnectMaterialization = (directory: string) => {
      const store = childStores.children.get(directory)
      if (!store) return
      if (reconnectMaterializing.has(directory)) return

      reconnectMaterializing.add(directory)
      void resyncDirectoryAfterReconnect(directory, store, routingIndex)
        .catch(() => {
          // Transient failure during materialization — next SSE event, transport switch,
          // or reconnect will catch up.
        })
        .finally(() => {
          reconnectMaterializing.delete(directory)
        })
    }
    const triggerActiveSessionRecovery = () => {
      const directory = _activeDirectory
      const sessionID = _activeSession
      if (!directory || !sessionID) return

      const store = childStores.children.get(directory)
      if (!store) return
      const state = store.getState()
      const status = state.session_status?.[sessionID]
      const key = statusTrackingKey(directory, sessionID)
      const now = Date.now()

      if (!shouldRecoverStaleActiveSession({
        status,
        now,
        lastStatusEventAt: lastStatusEventAtBySessionKey.get(key),
        lastOutputEventAt: lastOutputEventAtBySessionKey.get(key),
        lastRecoveryAt: lastRecoveryAtBySessionKey.get(key),
        staleMs: ACTIVE_SESSION_STATUS_STALE_MS,
        cooldownMs: ACTIVE_SESSION_RECOVERY_COOLDOWN_MS,
      })) {
        return
      }

      rememberBoundedTimestamp(lastRecoveryAtBySessionKey, key, now)
      void resyncDirectoryAfterReconnect(directory, store, routingIndex, {
        candidateSessionIds: [sessionID],
      }).catch(() => {
        // Transient failure during targeted stale recovery; cooldown keeps retries bounded.
      })
    }
    const triggerAllRecovery = () => {
      for (const dir of childStores.children.keys()) {
        triggerReconnectMaterialization(dir)
      }
    }
    const onVisible = () => {
      if (typeof document === "undefined") return
      if (document.visibilityState !== "visible") return
      triggerAllRecovery()
    }
    const activeRecoveryWatchdog = setInterval(triggerActiveSessionRecovery, ACTIVE_SESSION_RECOVERY_CHECK_MS)
    ;(activeRecoveryWatchdog as { unref?: () => void }).unref?.()
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible)
    }

    const { cleanup } = createEventPipeline({
      sdk: props.sdk,
      transport: messageStreamTransport,
      routeDirectory: (directory, payload) => {
        return resolveDirectoryFromRoutingIndex(routingIndex, directory, payload, childStores)
      },
      onEvent: (directory, payload) => {
        handleEvent(directory, payload, childStores, routingIndex)
      },
      onReconnect: () => {
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        triggerAllRecovery()
      },
      onDisconnect: (reason) => {
        const { hasEverConnected } = useConfigStore.getState()
        useConfigStore.setState({
          isConnected: false,
          connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
          lastDisconnectReason: reason,
        })
      },
      onTransportSwitch: () => {
        // Transport switched (e.g. WS timeout → SSE fallback) without a full
        // disconnect. If the active session missed the transition into a busy
        // turn, force a targeted resync for the viewed directory.
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        if (_activeDirectory) {
          triggerReconnectMaterialization(_activeDirectory)
        }
      },
      onReplayGap: () => {
        // Server's replay buffer rolled past our lastEventId, so cached state
        // is potentially stale. Re-fetch every directory we currently have a
        // store for. Cheaper than triggering a full re-bootstrap.
        triggerAllRecovery()
      },
    })
    return () => {
      clearInterval(activeRecoveryWatchdog)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible)
      }
      cleanup()
    }
  }, [props.sdk, childStores, routingIndex, messageStreamTransport])

  // Ensure current directory's child store exists
  useEffect(() => {
    if (props.directory) {
      const store = childStores.ensureChild(props.directory)
      ingestDirectoryStateIntoRoutingIndex(routingIndex, props.directory, store.getState())
    }
  }, [props.directory, childStores, routingIndex])

  // Set refs so non-React code (session-actions, session-ui-store) can access sync state
  useEffect(() => {
    setSyncRefs(props.sdk, childStores, props.directory, (sessionID, dir) => {
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
    })
    setActionRefs(
      props.sdk,
      childStores,
      () => opencodeClient.getDirectory() || props.directory,
    )
  }, [props.sdk, props.directory, childStores, routingIndex])

  // Subscribe to child store for streaming state derivation
  useEffect(() => {
    if (!props.directory) return
    const store = childStores.getChild(props.directory)
    if (!store) return
    const unsubscribe = store.subscribe((state) => {
      updateStreamingState(state)
    })
    return unsubscribe
  }, [props.directory, childStores])

  return <SyncContext.Provider value={system}>{props.children}</SyncContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Access the global sync store */
export function useGlobalSync() {
  return useGlobalSyncStore()
}

/** Access the global sync store with a selector */
export function useGlobalSyncSelector<T>(selector: (state: GlobalSyncStore) => T): T {
  return useGlobalSyncStore(selector)
}

/** Get the child store for a directory (defaults to current) */
export function useDirectoryStore(directory?: string): StoreApi<DirectoryStore> {
  const system = useSyncSystem()
  const dir = directory ?? system.directory
  return system.childStores.ensureChild(dir)
}

/** Select from the current directory's store */
export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

export function useEnsureSessionChildren(
  parentSessionId?: string,
  directory?: string,
  enabled = true,
  refreshKey = "default",
): { isLoading: boolean; hasFetched: boolean } {
  const system = useSyncSystem()
  const resolvedDirectory = directory ?? system.directory
  const [status, setStatus] = React.useState<SessionChildrenHookStatus>({ isLoading: false, hasFetched: false })
  const parentID = typeof parentSessionId === "string" ? parentSessionId.trim() : ""
  const dir = typeof resolvedDirectory === "string" ? resolvedDirectory.trim() : ""

  React.useEffect(() => {
    if (!enabled || !parentID || !dir) {
      setStatus({ isLoading: false, hasFetched: false })
      return
    }

    let cancelled = false
    const key = getSessionChildrenFetchKey(dir, parentID)
    const store = system.childStores.ensureChild(dir)
    const fetchResult = ensureSessionChildrenFetch(sessionChildrenFetches, key, refreshKey, async () => {
      const result = await system.sdk.session.children({ sessionID: parentID, directory: dir })
      const childSessions = unwrapSdkResult(result, "session.children") ?? []
      store.setState((state: DirectoryStore) => {
        const nextSessions = mergeChildSessions(state.session, childSessions, { directory: dir })
        if (nextSessions === state.session) {
          return state
        }
        return { session: nextSessions }
      })
    })

    setStatus({ isLoading: fetchResult.isLoading, hasFetched: fetchResult.hasFetched, parentID, directory: dir, refreshKey })

    if (fetchResult.promise) {
      fetchResult.promise.finally(() => {
        if (cancelled) return
        const latest = sessionChildrenFetches.get(key)
        setStatus({ isLoading: false, hasFetched: typeof latest?.fetchedAt === "number", parentID, directory: dir, refreshKey })
      })
    }

    return () => {
      cancelled = true
    }
  }, [dir, enabled, parentID, refreshKey, system])

  return getEffectiveSessionChildrenFetchStatus({
    enabled,
    parentID,
    directory: dir,
    refreshKey,
    status,
  })
}

/** Get the revert messageID for a session (if reverted) */
export function useSessionRevertMessageID(sessionID: string, directory?: string): string | undefined {
  return useDirectorySync(
    useCallback((state: State) => {
      const session = state.session.find((s) => s.id === sessionID)
      return getEffectiveSessionRevertMessageID(state, sessionID, session)
    }, [sessionID]),
    directory,
  )
}

/** Get session messages for a specific session */
export function useSessionMessages(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.message[sessionID] ?? EMPTY_MESSAGES, [sessionID]),
    directory,
  )
}

/**
 * Get visible session messages — filters out reverted messages.
 * Filters out reverted messages (id >= session.revert.messageID).
 */
export function useVisibleSessionMessages(sessionID: string, directory?: string) {
  const messages = useSessionMessages(sessionID, directory)
  const revertMessageID = useSessionRevertMessageID(sessionID, directory)
  return useMemo(() => {
    if (!revertMessageID) return messages
    return messages.filter((m) => m.id < revertMessageID)
  }, [messages, revertMessageID])
}

/** Check whether the message list for a session has been loaded into sync state. */
export function useSessionMessagesResolved(sessionID: string, directory?: string): boolean {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return false
      return Object.prototype.hasOwnProperty.call(state.message, sessionID)
    }, [sessionID]),
    directory,
  )
}

/** Get parts for a specific message */
export function useSessionParts(messageID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.part[messageID] ?? EMPTY_PARTS, [messageID]),
    directory,
  )
}

/** Get status for a specific session */
export function useSessionStatus(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session_status?.[sessionID], [sessionID]),
    directory,
  )
}

/** Get permissions for a specific session */
export function useSessionPermissions(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS, [sessionID]),
    directory,
  )
}

/** Get questions for a specific session */
export function useSessionQuestions(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.question[sessionID] ?? EMPTY_QUESTION_REQUESTS, [sessionID]),
    directory,
  )
}

/** Get sessions list for a directory */
export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

const getSidebarSessionSignature = (session: Session, stableUpdatedAt: number): string => {
  const directory = (session as Session & { directory?: string | null }).directory ?? ''
  const parentID = (session as Session & { parentID?: string | null }).parentID ?? ''
  const projectWorktree = (session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? ''
  const shared = session.share?.url ?? ''
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.archived ? 1 : 0,
    directory,
    parentID,
    projectWorktree,
    shared,
    stableUpdatedAt,
  ].join('|')
}

const isSidebarSessionWorking = (state: State, sessionID: string): boolean => {
  const messages = state.message[sessionID] ?? EMPTY_MESSAGES
  const lastMessage = messages[messages.length - 1]
  const liveParts = lastMessage ? (state.part[lastMessage.id] ?? EMPTY_PARTS) : EMPTY_PARTS
  const liveStreamingMessageId = useStreamingStore.getState().streamingMessageIds.get(sessionID) ?? null

  return isSessionWorkingFromState({
    status: state.session_status?.[sessionID],
    permissions: state.permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS,
    messages,
    liveStreamingMessageId,
    liveParts,
  })
}

/** Get sessions stabilized for sidebar tree rendering */
export function useSidebarSessions(directory?: string): Session[] {
  const store = useDirectoryStore(directory)
  const cacheRef = React.useRef<{
    source: Session[]
    streamingSignature: string
    array: Session[]
    signatures: Map<string, string>
    sessionsById: Map<string, Session>
    stableUpdatedAtById: Map<string, number>
    streamingById: Map<string, boolean>
  } | null>(null)

  const getSnapshot = React.useCallback(() => {
    const state = store.getState()
    const source = state.session
    const cached = cacheRef.current
    const streamingSignature = source
      .map((session) => {
        const isStreaming = isSidebarSessionWorking(state, session.id)
        return `${session.id}:${isStreaming ? 1 : 0}`
      })
      .join('|')

    if (cached && cached.source === source && cached.streamingSignature === streamingSignature) {
      return cached.array
    }

    const signatures = new Map<string, string>()
    const sessionsById = new Map<string, Session>()
    const stableUpdatedAtById = new Map<string, number>()
    const streamingById = new Map<string, boolean>()
    let changed = !cached || cached.array.length !== source.length

    const array = source.map((session) => {
      const rawUpdatedAt = Number(session.time?.updated ?? session.time?.created ?? 0)
      const isStreaming = isSidebarSessionWorking(state, session.id)
      const cachedUpdatedAt = cached?.stableUpdatedAtById.get(session.id) ?? rawUpdatedAt
      const wasStreaming = cached?.streamingById.get(session.id) ?? false
      const stableUpdatedAt = isStreaming
        ? (wasStreaming ? cachedUpdatedAt : Math.max(rawUpdatedAt, cachedUpdatedAt, Date.now()))
        : cachedUpdatedAt
      const signature = getSidebarSessionSignature(session, stableUpdatedAt)
      signatures.set(session.id, signature)
      stableUpdatedAtById.set(session.id, stableUpdatedAt)
      streamingById.set(session.id, isStreaming)

      const cachedSession = cached?.sessionsById.get(session.id)
      if (
        cachedSession
        && cached?.signatures.get(session.id) === signature
      ) {
        sessionsById.set(session.id, cachedSession)
        return cachedSession
      }

      changed = true
      const nextSession = stableUpdatedAt === rawUpdatedAt
        ? session
        : {
            ...session,
            time: {
              ...session.time,
              updated: stableUpdatedAt,
            },
          }
      sessionsById.set(session.id, nextSession)
      return nextSession
    })

    if (!changed && cached) {
      cacheRef.current = {
        source,
        streamingSignature,
        array: cached.array,
        signatures,
        sessionsById: cached.sessionsById,
        stableUpdatedAtById,
        streamingById,
      }
      return cached.array
    }

    cacheRef.current = { source, streamingSignature, array, signatures, sessionsById, stableUpdatedAtById, streamingById }
    return array
  }, [store])

  return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/** Get one session by id for a directory */
export function useSession(sessionID?: string | null, directory?: string) {
  const { childStores } = useSyncSystem()
  const getSnapshot = useCallback(() => {
    if (directory) {
      return childStores.getChild(directory)?.getState().session.find((session) => session.id === sessionID)
    }
    return findLiveSession(getLiveStates(childStores), sessionID)
  }, [childStores, directory, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory).subscribe(notify)
    }
    return childStores.subscribeAll(notify)
  }, [childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get one session directory by id for a directory */
export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  const session = useSession(sessionID, directory)
  return (session as (typeof session & { directory?: string | null }) | undefined)?.directory ?? undefined
}

/** Get the SDK client */
export function useSyncSDK() {
  return useSyncSystem().sdk
}

/** Get the current directory */
export function useSyncDirectory() {
  return useSyncSystem().directory
}

/** Get the child store manager (for advanced operations) */
export function useChildStoreManager() {
  return useSyncSystem().childStores
}

export function useSyncResyncSession() {
  return useSyncSystem().resyncSession
}

export type SessionTextMessage = {
  id: string
  role: string | null
  text: string
}

const getPartText = (part: Part): string => {
  if (part?.type !== "text") return ""
  const text = (part as { text?: unknown }).text
  return typeof text === "string" ? text : ""
}

const getConcatenatedTextFromParts = (parts: Part[]): string => {
  let text = ""
  for (const part of parts) {
    text += getPartText(part)
  }
  return text
}

const getFirstTextFromParts = (parts: Part[]): string => {
  for (const part of parts) {
    const text = getPartText(part)
    if (text.length > 0) return text
  }
  return ""
}

type SessionMessageRecord = { info: Message; parts: Part[] }

type SessionMessageRecordsSnapshot = {
  sessionID: string
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
  list: SessionMessageRecord[]
  byId: Map<string, SessionMessageRecord>
}

function getVisibleMessagesForSession(state: State, sessionID: string, previous?: SessionMessageRecordsSnapshot): {
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
} {
  const sourceMessages = state.message[sessionID] ?? EMPTY_MESSAGES
  const session = state.session.find((candidate) => candidate.id === sessionID)
  const revertMessageID = getEffectiveSessionRevertMessageID(state, sessionID, session)

  if (
    previous
    && previous.sourceMessages === sourceMessages
    && previous.revertMessageID === revertMessageID
  ) {
    return {
      sourceMessages,
      visibleMessages: previous.visibleMessages,
      revertMessageID,
    }
  }

  return {
    sourceMessages,
    visibleMessages: revertMessageID ? sourceMessages.filter((message) => message.id < revertMessageID) : sourceMessages,
    revertMessageID,
  }
}

export function buildSessionMessageRecordsSnapshot(
  state: State,
  sessionID: string,
  previous?: SessionMessageRecordsSnapshot,
  suspendPartUpdates = false,
): SessionMessageRecordsSnapshot {
  const { sourceMessages, visibleMessages, revertMessageID } = getVisibleMessagesForSession(state, sessionID, previous)
  const nextById = new Map<string, SessionMessageRecord>()
  const nextList = visibleMessages.map((message) => {
    const previousRecord = previous?.byId.get(message.id)
    const parts = suspendPartUpdates && previousRecord
      ? previousRecord.parts
      : (state.part[message.id] ?? EMPTY_PARTS)

    const nextRecord = previousRecord && previousRecord.info === message && previousRecord.parts === parts
      ? previousRecord
      : { info: message, parts }

    nextById.set(message.id, nextRecord)
    return nextRecord
  })

  const unchanged = Boolean(previous)
    && previous?.visibleMessages === visibleMessages
    && previous.list.length === nextList.length
    && previous.list.every((record, index) => record === nextList[index])

  if (unchanged && previous) {
    return previous
  }

  return {
    sessionID,
    sourceMessages,
    visibleMessages,
    revertMessageID,
    list: nextList,
    byId: nextById,
  }
}

export function useSessionMessageCount(sessionID: string, directory?: string): number {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return 0
      return state.message[sessionID]?.length ?? 0
    }, [sessionID]),
    directory,
  )
}

export function useSessionTextMessages(sessionID: string, directory?: string): SessionTextMessage[] {
  const records = useSessionMessageRecords(sessionID, directory)

  return useMemo(
    () => records.map((record) => ({
      id: record.info.id,
      role: typeof record.info.role === "string" ? record.info.role : null,
      text: getConcatenatedTextFromParts(record.parts),
    })),
    [records],
  )
}

export function useUserMessageHistory(sessionID: string, directory?: string): string[] {
  const records = useSessionMessageRecords(sessionID, directory)
  const userMessages = useMemo(() => records.filter((record) => record.info.role === 'user'), [records])

  return useMemo(() => {
    const history: string[] = []
    for (let index = userMessages.length - 1; index >= 0; index -= 1) {
      const message = userMessages[index]
      const text = getFirstTextFromParts(message.parts)
      if (text.length > 0) {
        history.push(text)
      }
    }
    return history
  }, [userMessages])
}

/**
 * Get messages for a session in the old {info, parts}[] format.
 * Uses visible messages (filtered by revert state).
 *
 * Uses a ref-stable parts lookup that only triggers re-renders when
 * a part array for one of our displayed messages actually changes.
 */
export function useSessionMessageRecords(
  sessionID: string,
  directory?: string,
  options?: { suspendPartUpdates?: boolean },
) {
  const store = useDirectoryStore(directory)
  const snapshotRef = useRef<SessionMessageRecordsSnapshot>({
    sessionID,
    sourceMessages: EMPTY_MESSAGES,
    visibleMessages: EMPTY_MESSAGES,
    revertMessageID: undefined,
    list: [],
    byId: new Map(),
  })

  const getSnapshot = useCallback(() => {
    const nextSnapshot = buildSessionMessageRecordsSnapshot(
      store.getState(),
      sessionID,
      snapshotRef.current.sessionID === sessionID ? snapshotRef.current : undefined,
      Boolean(options?.suspendPartUpdates),
    )
    snapshotRef.current = nextSnapshot
    return nextSnapshot.list
  }, [options?.suspendPartUpdates, sessionID, store])

  return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/**
 * Ensures a session's messages are loaded into the sync store.
 * If the session exists in state.session but messages haven't been fetched
 * (state.message[sessionID] is absent), triggers a background API fetch.
 *
 * This covers the case where a user navigates to an old parent session
 * whose child session messages were never loaded — bootstrap only loads
 * session metadata, not messages.
 */

// Module-level in-flight tracking for useEnsureSessionMessages.
// Prevents redundant parallel fetches when multiple component instances
// (e.g. multiple ToolParts) request the same session's messages.
const _ensureMessagesLoading = new Set<string>()

export function useEnsureSessionMessages(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)

  React.useEffect(() => {
    if (!sessionID) return

    const state = store.getState()
    // Already loaded into a renderable message/part snapshot — nothing to do.
    if (getSessionMaterializationStatus(state, sessionID).renderable) return
    // Session doesn't exist — nothing to load
    if (!state.session.some((s) => s.id === sessionID)) return

    const dir = directory ?? opencodeClient.getDirectory()
    const loadingKey = `${dir ?? ""}:${sessionID}`
    // Already loading this session for this directory
    if (_ensureMessagesLoading.has(loadingKey)) return

    _ensureMessagesLoading.add(loadingKey)

    void (async () => {
      try {
        await materializeSessionFromServer(dir ?? "", sessionID, store)
      } catch {
        // Transient failure — next navigation or reconnect will retry
      } finally {
        _ensureMessagesLoading.delete(loadingKey)
      }
    })()
  }, [sessionID, store, directory])
}

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to
 * incomplete assistant messages. The message check keeps working indicators
 * stable while status events are delayed without overriding authoritative idle.
 * Returns false when permissions are pending (permission indicator takes priority).
 */
export function useIsSessionWorking(sessionID: string, directory?: string): boolean {
  const status = useSessionStatus(sessionID, directory)
  const permissions = useSessionPermissions(sessionID, directory)
  const messages = useSessionMessages(sessionID, directory)
  const lastMessageId = messages[messages.length - 1]?.id ?? ""
  const liveStreamingMessageId = useStreamingStore(
    React.useCallback(
      (state) => state.streamingMessageIds.get(sessionID) ?? null,
      [sessionID],
    ),
  )
  const livePartsMessageId = liveStreamingMessageId ?? lastMessageId
  const liveParts = useSessionParts(livePartsMessageId, directory)

  return useMemo(() => {
    return isSessionWorkingFromState({ status, permissions, messages, liveStreamingMessageId, liveParts })
  }, [status, permissions, messages, liveStreamingMessageId, liveParts])
}
