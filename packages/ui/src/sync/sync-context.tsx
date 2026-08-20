/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"
import {
  resolveEventPipelineConnectionUpdate,
  type EventPipelineConnectionEvent,
} from "./event-pipeline-connection-state"
import {
  reduceGlobalEvent,
  applyGlobalProject,
  applyDirectoryEvent,
} from "./event-reducer"
import { useGlobalSyncStore, type GlobalSyncStore } from "./global-sync-store"
import {
  ChildStoreManager,
  getActiveDirectoryStoreKeys,
  getReconnectRecoveryDirectoryStoreKeys,
  shouldBootstrapDirectorySubscription,
  type DirectoryStore,
} from "./child-store"
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
import { settleStreamingSessions, updateStreamingState, useStreamingStore } from "./streaming"
import { isSessionWorkingFromState } from "./session-working"
import {
  clearActionRefs,
  releaseSessionActionDirectory,
  releaseSessionActionSession,
  setActionRefs,
} from "./session-actions"
import { clearSyncRefs, getSessionUIStoreIfInitialized, setSyncRefs } from "./sync-refs"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { syncDebug } from "./debug"
import {
  ACTIVE_SESSION_STATUS_STALE_MS,
  PROVIDER_STALL_SEMANTIC_SILENCE_MS,
  captureSessionStatusBaseline,
  filterUnchangedSessionStatusCandidates,
  getActiveSessionRecoveryActivityAt,
  getActiveSessionRecoveryCooldownMs,
  getLongRunningToolFingerprint,
  getProviderStallFingerprint,
  getReconnectCandidateSessionIds,
  haveSameLongRunningToolFingerprint,
  haveSameProviderStallFingerprint,
  mergeRecoveredSessionStatuses,
  shouldConfirmLongRunningTool,
  shouldRecoverStaleActiveSession,
  unwrapSdkResult,
} from "./reconnect-recovery"
import { stopStalledProviderAndOfferRecovery } from "./provider-stall-recovery"
import { hasMessageRecordInfo, unwrapMessageRecordsResult } from "./message-fetch"
import {
  addPendingPartDelta,
  applyPendingPartDeltasToState,
  clearPendingPartDeltasForDirectory,
  clearPendingPartDeltasForMessages,
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
  managedOrchestrationSelectors,
  useManagedOrchestrationStore,
} from "@/stores/useManagedOrchestrationStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { useContextStore } from "@/stores/contextStore"
import { useProviderRecoveryStore } from "@/stores/useProviderRecoveryStore"
import { useProviderStallStore } from "@/stores/useProviderStallStore"
import { useLongRunningToolStore } from "@/stores/useLongRunningToolStore"
import {
  clearDirectorySessionChangeAttributions,
  clearSessionChangeAttribution,
  reconcileSessionChangeAttribution,
} from "@/stores/useSessionChangeAttributionStore"
import { applyGlobalSessionLifecycleEvent } from "@/stores/useGlobalSessionsStore"
import {
  postRendererTurnTimingMark,
  responsivenessPerfCount,
  responsivenessPerfObserve,
  streamDebugEnabled,
  streamDebugMark,
} from "@/stores/utils/streamDebug"
import { toast } from "@/components/ui"
import { clearAbortGuard, clearAbortGuards } from "./abort-retry-guard"
import { appendNotification, useNotificationStore } from "./notification-store"
import { useSelectionStore } from "./selection-store"
import type { State } from "./types"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"
import * as sessionActions from "./session-actions"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { updateSessionUserActivityFromMessages } from "./session-user-activity"
import {
  clearCommittedRevertResendsForSessions,
  getEffectiveSessionRevertMessageID,
} from "./revert-transactions"
import {
  clearSessionMaterializerChildStores,
  markArchived,
  markUnarchived,
  releaseSessionMaterializerDirectory,
  setSessionMaterializerChildStores,
} from "./session-materializer"
import { detectPlanCompletedCandidate } from "./plan-completion-detection"
import { detectPlanImplementationRequestCandidate } from "./plan-implementation-detection"
import { detectPlanProposedCandidate } from "./plan-proposed-detection"
import { resolveEffectivePlanIndicatorState } from "./plan-indicator"
import { persistSessionPlanRevision } from "@/lib/plans/sessionPlanPersistence"
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"
import { isStrictlyOlderSession } from "./session-recency"
import {
  isSessionTurnSettledForCompletion,
} from "./plan-idle-settlement"
import { detectTurnCompletedCandidate } from "./turn-completion-detection"
import {
  getTerminalSessionIdForParentMaterialization,
  resolveParentSessionIdForTerminalChild,
} from "./subtaskParentMaterialization"
import {
  ensureSessionChildrenFetch,
  clearSessionChildrenForDirectory,
  getEffectiveSessionChildrenFetchStatus,
  getSessionChildrenFetchKey,
  mergeChildSessions,
  type SessionChildrenFetchCacheEntry,
  type SessionChildrenHookStatus,
} from "./session-children"
import { clearSessionPrefetch, clearSessionPrefetchDirectory } from "./session-prefetch-cache"
import {
  clearSessionMessagePagination,
  clearSessionMessagePaginationDirectory,
} from "./message-pagination-store"
import {
  EMPTY_SESSION_MESSAGE_LOAD_STATE,
  SessionMessageLoader,
  type SessionMessageLoadState,
} from "./session-message-loader"
import { removePersistedSessionInput } from "./session-draft-storage"
import { dropSessionCaches } from "./session-cache"
import {
  clearDirectoryMaterializations,
  clearDirectoryPrefixedEntries,
  createRestartSafeOwnershipCleanup,
  releaseDirectoryRoutingIndex,
  type DirectoryRoutingIndex,
} from "./directory-disposal"
import {
  normalizeChatOwnedDiffSummary,
  stripUntrustedSessionDiffSummary,
  type SessionSummaryDiffStats,
} from "@/lib/sessionDiffStats"
import { requestSignature } from "./request-signature"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import {
  clearAllProviderContextUsageForSession,
  getProviderContextUsageStoreKey,
  invalidateProviderContextUsageForCompaction,
  refreshProviderContextUsage,
  useProviderContextUsageStore,
} from "@/stores/useProviderContextUsageStore"
import { extractTokenBreakdownFromMessage } from "@/stores/utils/tokenUtils"
import {
  selectSessionById,
  selectSessionChildren,
  selectSessionDirectoryById,
  subscribeToSessionBranch,
} from "./session-selectors"

const EMPTY_SESSION_STATUS_MAP: Record<string, SessionStatus> = {}
const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_QUESTION_REQUESTS: QuestionRequest[] = []

function applyEventPipelineConnectionEvent(event: EventPipelineConnectionEvent): void {
  const update = resolveEventPipelineConnectionUpdate(useConfigStore.getState(), event)
  if (update) {
    useConfigStore.setState(update)
  }
}
const FIRST_ASSISTANT_DELTA_MARK_LIMIT = 1_000
const firstAssistantDeltaMarkedMessages = new Set<string>()
const sessionChildrenFetches = new Map<string, SessionChildrenFetchCacheEntry>()
const blockingRequestSessionMaterializationsInFlight = new Map<string, symbol>()

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
  return (
    typeof completed === "number"
    && Number.isFinite(completed)
    && completed > 0
  ) || (typeof finish === "string" && finish.length > 0)
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
  messageLoader: SessionMessageLoader
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

export function useSessionMessageLoader(): SessionMessageLoader {
  return useSyncSystem().messageLoader
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
type SessionLifecycleRestoration = {
  promise: Promise<void>
  detectsTurnCompletion: boolean
  forcesRefresh: boolean
  cancelled: boolean
}

type DirectoryIndicatorRestoration = {
  promise: Promise<void>
  token: symbol
}

const lifecycleRestorationsBySession = new Map<string, SessionLifecycleRestoration>()
const indicatorRestorationsByDirectory = new Map<string, DirectoryIndicatorRestoration>()

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
    const isCurrent = () => (
      pendingSessionMaterializations.get(key) === pending
      && childStores.getChild(pending.directory) === store
    )
    const stillPending = await materializeSessionFromServer(
      pending.directory,
      pending.sessionID,
      store,
      isCurrent,
    )
    if (
      pendingSessionMaterializations.get(key) !== pending
      || childStores.getChild(pending.directory) !== store
    ) {
      return
    }
    await detectAndMarkPlanLifecycle(
      pending.sessionID,
      pending.directory,
      store,
      pending.detectTurnCompletionAfterLoad,
      undefined,
      isCurrent,
    ).catch(() => undefined)
    if (
      pendingSessionMaterializations.get(key) !== pending
      || childStores.getChild(pending.directory) !== store
    ) {
      return
    }
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
  return isIdleOrTerminalSessionStatus(state.session_status?.[sessionID])
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
  isCurrent: () => boolean = () => true,
) {
  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  const result = await retry(() =>
    scopedClient.session.messages({ sessionID, limit: SESSION_MATERIALIZATION_MESSAGE_LIMIT }).then(unwrapMessageRecordsResult),
  )
  if (!isCurrent()) return false
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
  reconcileSessionChangeAttribution(directory, sessionID, store.getState())

  // Report whether buffered deltas for this session are still orphaned after the
  // fetch+replay (the streamed part wasn't in the snapshot yet). The caller retries.
  const messageIDs = (store.getState().message[sessionID] ?? EMPTY_MESSAGES).map((message) => message.id)
  return hasPendingPartDeltasForMessages(pendingPartDeltas, directory, messageIDs)
}

async function materializeAndRestoreSessionLifecycle(
  directory: string,
  sessionID: string,
  store: StoreApi<DirectoryStore>,
  detectTurnCompletion = false,
  forceRefresh = false,
): Promise<void> {
  const key = `${directory}\u0000${sessionID}`
  const existing = lifecycleRestorationsBySession.get(key)
  if (existing) {
    await existing.promise
    if (existing.cancelled) return
    if (forceRefresh && !existing.forcesRefresh) {
      if (lifecycleRestorationsBySession.get(key) === existing) {
        lifecycleRestorationsBySession.delete(key)
      }
      await materializeAndRestoreSessionLifecycle(
        directory,
        sessionID,
        store,
        detectTurnCompletion,
        true,
      )
      return
    }
    if (detectTurnCompletion && !existing.detectsTurnCompletion) {
      await detectAndMarkPlanLifecycle(
        sessionID,
        directory,
        store,
        true,
        undefined,
        () => !existing.cancelled,
      )
    }
    return
  }

  const restoration: SessionLifecycleRestoration = {
    promise: Promise.resolve(),
    detectsTurnCompletion: detectTurnCompletion,
    forcesRefresh: forceRefresh,
    cancelled: false,
  }
  const promise = Promise.resolve().then(async () => {
    if (lifecycleRestorationsBySession.get(key) !== restoration) return
    if (forceRefresh || !getSessionMaterializationStatus(store.getState(), sessionID).renderable) {
      await materializeSessionFromServer(
        directory,
        sessionID,
        store,
        () => lifecycleRestorationsBySession.get(key) === restoration,
      )
    }
    if (lifecycleRestorationsBySession.get(key) !== restoration) return
    await detectAndMarkPlanLifecycle(
      sessionID,
      directory,
      store,
      detectTurnCompletion,
      undefined,
      () => lifecycleRestorationsBySession.get(key) === restoration,
    )
  })
  restoration.promise = promise
  lifecycleRestorationsBySession.set(key, restoration)

  try {
    await promise
  } finally {
    if (lifecycleRestorationsBySession.get(key) === restoration) {
      lifecycleRestorationsBySession.delete(key)
    }
  }
}

export async function restorePersistedSessionIndicatorsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
): Promise<void> {
  if (!directory || directory === "global") return

  const existing = indicatorRestorationsByDirectory.get(directory)
  if (existing) return existing.promise

  const token = Symbol(directory)
  const promise = Promise.resolve().then(async () => {
    if (indicatorRestorationsByDirectory.get(directory)?.token !== token) return
    const { useSessionUIStore } = await import("./session-ui-store")
    if (indicatorRestorationsByDirectory.get(directory)?.token !== token) return
    const sessionIDs = store.getState().session
      .map((session) => session.id)
      .filter((sessionID) => {
        const sessionUI = useSessionUIStore.getState()
        const hasPendingPlan = sessionUI.planModeUserMessagesBySession.has(sessionID)
        const hasPersistedProposal = sessionUI.sessionPlanIndicator.get(sessionID)?.state === "proposed"
        const hasUnreadCompletion = useNotificationStore.getState()
          .index.session.unseenHasCompletion[sessionID] ?? false
        return hasPendingPlan || hasPersistedProposal || hasUnreadCompletion
      })
      .sort()

    // Persisted plan ownership and unread completion records narrow startup
    // restoration to sessions with an unresolved indicator. Restore
    // sequentially so many candidates cannot create an unbounded request burst.
    for (const sessionID of sessionIDs) {
      if (indicatorRestorationsByDirectory.get(directory)?.token !== token) return
      const sessionUI = useSessionUIStore.getState()
      const hasPendingPlan = sessionUI.planModeUserMessagesBySession.has(sessionID)
      const persistedProposal = sessionUI.sessionPlanIndicator.get(sessionID)?.state === "proposed"
        ? sessionUI.sessionPlanIndicator.get(sessionID)
        : undefined
      const hasUnreadCompletion = useNotificationStore.getState()
        .index.session.unseenHasCompletion[sessionID] ?? false
      if (!hasPendingPlan && !persistedProposal && !hasUnreadCompletion) continue
      try {
        await materializeAndRestoreSessionLifecycle(
          directory,
          sessionID,
          store,
          hasUnreadCompletion,
          Boolean(persistedProposal),
        )
        if (indicatorRestorationsByDirectory.get(directory)?.token !== token) return
        if (persistedProposal?.sourceMessageId) {
          const latestSessionUI = useSessionUIStore.getState()
          const currentProposal = latestSessionUI.sessionPlanIndicator.get(sessionID)
          const materialization = getSessionMaterializationStatus(store.getState(), sessionID)
          if (
            materialization.hasMessages
            && currentProposal?.state === "proposed"
            && currentProposal.sourceMessageId === persistedProposal.sourceMessageId
          ) {
            const candidate = detectPlanProposedCandidate({
              sessionID,
              state: store.getState(),
              isRecordedPlanModeUserMessage: (messageId) => latestSessionUI.isUserMessagePlanMode(messageId),
              implementedPlanRequests: latestSessionUI.implementedPlanRequests,
              externallyHandedOffPlanRequests: latestSessionUI.externallyHandedOffPlanRequests,
            })
            if (!candidate || candidate.sourceMessageId !== persistedProposal.sourceMessageId) {
              latestSessionUI.retirePlanProposal(sessionID, persistedProposal.sourceMessageId)
            }
          }
        }
      } catch {
        // Restore other sessions independently; a transient failure for one
        // plan must not hide every later plan in the directory.
      }
    }
  })
  const restoration = { promise, token }
  indicatorRestorationsByDirectory.set(directory, restoration)

  try {
    await promise
  } finally {
    if (indicatorRestorationsByDirectory.get(directory) === restoration) {
      indicatorRestorationsByDirectory.delete(directory)
    }
  }
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
    const token = Symbol(materializationKey)
    blockingRequestSessionMaterializationsInFlight.set(materializationKey, token)
    try {
      const session = await retry(() =>
        scopedClient.session.get({ sessionID }).then((result) => unwrapSdkResult(result, "session.get")),
      ).catch(() => null)
      if (blockingRequestSessionMaterializationsInFlight.get(materializationKey) !== token) return
      if (!session?.id) return

      const recoveredSession = stripSessionDiffSnapshots(session) as Session
      recoveredSessions.push(recoveredSession)
      if (routingIndex) {
        setIndexedSessionDirectory(routingIndex, recoveredSession.id, directory)
      }
    } finally {
      if (blockingRequestSessionMaterializationsInFlight.get(materializationKey) === token) {
        blockingRequestSessionMaterializationsInFlight.delete(materializationKey)
      }
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
const recoveryFailureCountBySessionKey = new Map<string, number>()
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

function markStatusEventObserved(
  directory: string,
  sessionId: string,
  resetRecovery: boolean,
  timestamp = Date.now(),
) {
  if (!directory || !sessionId || directory === "global") return
  const key = statusTrackingKey(directory, sessionId)
  rememberBoundedTimestamp(lastStatusEventAtBySessionKey, key, timestamp)
  if (!resetRecovery) return
  lastRecoveryAtBySessionKey.delete(key)
  recoveryFailureCountBySessionKey.delete(key)
}

function markOutputEventObserved(directory: string, sessionId: string | null | undefined, timestamp = Date.now()) {
  if (!directory || !sessionId || directory === "global") return
  const key = statusTrackingKey(directory, sessionId)
  rememberBoundedTimestamp(lastOutputEventAtBySessionKey, key, timestamp)
  lastRecoveryAtBySessionKey.delete(key)
  recoveryFailureCountBySessionKey.delete(key)
  useProviderStallStore.getState().clearStall(sessionId)
}

function reconcileLongRunningTool(
  directory: string,
  sessionID: string | null | undefined,
  state: State,
  activityPart: Part | undefined,
  timestamp = Date.now(),
) {
  if (!directory || !sessionID || directory === "global") return
  const fingerprint = getLongRunningToolFingerprint({ state, sessionID })
  const longRunningStore = useLongRunningToolStore.getState()
  if (!fingerprint) {
    longRunningStore.clearTool(sessionID)
    return
  }

  const previous = longRunningStore.recordsBySessionId[sessionID]
  const sameCall = haveSameLongRunningToolFingerprint(previous, fingerprint)
  const activityObserved = activityPart?.type === "tool"
    && activityPart.id === fingerprint.partID
    && activityPart.callID === fingerprint.callID
    && activityPart.tool === fingerprint.tool
  longRunningStore.observeTool({
    ...fingerprint,
    directory,
    observedAt: sameCall ? previous.observedAt : timestamp,
    lastActivityAt: activityObserved || !sameCall ? timestamp : previous.lastActivityAt,
  }, activityObserved)
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

const retireDeletedSessionSyncOwnership = (
  directory: string,
  sessionID: string,
  state: State,
  routingIndex: EventRoutingIndex,
) => {
  if (!directory || directory === "global" || !sessionID) return

  const pendingKey = materializationKey(directory, sessionID)
  const pendingMaterialization = pendingSessionMaterializations.get(pendingKey)
  if (pendingMaterialization?.retryTimer) {
    clearTimeout(pendingMaterialization.retryTimer)
  }
  pendingSessionMaterializations.delete(pendingKey)

  const lifecycleKey = `${directory}\u0000${sessionID}`
  const lifecycleRestoration = lifecycleRestorationsBySession.get(lifecycleKey)
  if (lifecycleRestoration) {
    lifecycleRestoration.cancelled = true
    lifecycleRestorationsBySession.delete(lifecycleKey)
  }

  blockingRequestSessionMaterializationsInFlight.delete(`${directory}\n${sessionID}`)
  releaseSessionActionSession(directory, sessionID)
  sessionChildrenFetches.delete(getSessionChildrenFetchKey(directory, sessionID))
  clearSessionPrefetch(directory, [sessionID])
  clearSessionMessagePagination(directory, [sessionID])

  const messageIDs = new Set(routingIndex.sessionMessageIdsById.get(sessionID) ?? [])
  for (const message of state.message[sessionID] ?? EMPTY_MESSAGES) {
    messageIDs.add(message.id)
  }
  clearPendingPartDeltasForMessages(pendingPartDeltas, directory, messageIDs)
  for (const messageID of messageIDs) {
    firstAssistantDeltaMarkedMessages.delete(messageID)
  }

  const trackingKey = statusTrackingKey(directory, sessionID)
  externallyViewedSessions.delete(trackingKey)
  lastStatusEventAtBySessionKey.delete(trackingKey)
  lastOutputEventAtBySessionKey.delete(trackingKey)
  lastRecoveryAtBySessionKey.delete(trackingKey)
  recoveryFailureCountBySessionKey.delete(trackingKey)
  useProviderStallStore.getState().clearStall(sessionID)
  useLongRunningToolStore.getState().clearTool(sessionID)
  clearAbortGuard(sessionID)
  clearCommittedRevertResendsForSessions([sessionID])

  if (_activeDirectory === directory && _activeSession === sessionID) {
    _activeSession = ""
    _activeSessionTrackingKey = ""
  }
}

const releaseDirectoryOwnedSyncState = (
  directory: string,
  snapshot: State,
  routingIndex: DirectoryRoutingIndex,
  releaseEventPipelineDirectory: (directory: string) => void,
) => {
  clearSessionPrefetchDirectory(directory)
  clearSessionMessagePaginationDirectory(directory)
  releaseSessionMaterializerDirectory(directory)
  releaseSessionActionDirectory(directory)
  clearSessionChildrenForDirectory(sessionChildrenFetches, directory)
  clearPendingPartDeltasForDirectory(pendingPartDeltas, directory)
  clearDirectoryMaterializations(pendingSessionMaterializations, directory)
  for (const [key, restoration] of lifecycleRestorationsBySession) {
    if (key.startsWith(`${directory}\u0000`)) {
      restoration.cancelled = true
    }
  }
  clearDirectoryPrefixedEntries(lifecycleRestorationsBySession, directory, "\u0000")
  indicatorRestorationsByDirectory.delete(directory)
  clearDirectoryPrefixedEntries(blockingRequestSessionMaterializationsInFlight, directory)
  clearDirectoryPrefixedEntries(externallyViewedSessions, directory)
  clearDirectoryPrefixedEntries(lastStatusEventAtBySessionKey, directory)
  clearDirectoryPrefixedEntries(lastOutputEventAtBySessionKey, directory)
  clearDirectoryPrefixedEntries(lastRecoveryAtBySessionKey, directory)
  clearDirectoryPrefixedEntries(recoveryFailureCountBySessionKey, directory)
  useProviderStallStore.getState().clearDirectory(directory)
  useLongRunningToolStore.getState().clearDirectory(directory)

  const releasedSessionIDs = releaseDirectoryRoutingIndex(routingIndex, directory, snapshot)
  for (const sessionID of [
    ...Object.keys(snapshot.session_status),
    ...Object.keys(snapshot.question),
    ...Object.keys(snapshot.permission),
  ]) {
    releasedSessionIDs.add(sessionID)
  }
  for (const sessionID of releasedSessionIDs) {
    dropPendingToastKeysForSession(sessionID)
  }
  clearAbortGuards(releasedSessionIDs)
  clearCommittedRevertResendsForSessions(releasedSessionIDs)

  for (const messageID of Object.keys(snapshot.part)) {
    firstAssistantDeltaMarkedMessages.delete(messageID)
  }
  for (const messages of Object.values(snapshot.message)) {
    for (const message of messages) {
      firstAssistantDeltaMarkedMessages.delete(message.id)
    }
  }

  if (_activeDirectory === directory) {
    _activeDirectory = ""
    _activeSession = ""
    _activeSessionTrackingKey = ""
  }
  releaseEventPipelineDirectory(directory)
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
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const { useSessionUIStore } = await import("./session-ui-store")
  if (!isCurrent()) return
  let sessionUI = useSessionUIStore.getState()
  const state = store.getState()

  let planEntry = sessionUI.sessionPlanIndicator.get(sessionID)

  const implementationCandidate = detectPlanImplementationRequestCandidate({
    sessionID,
    state,
  })
  if (implementationCandidate) {
    sessionUI.markPlanImplementationRequested(implementationCandidate.implementationKey)
    sessionUI.markPlanImplementing(
      implementationCandidate.sourceSessionId,
      implementationCandidate.sourceMessageId,
      implementationCandidate.implementationMessageId,
    )
    sessionUI = useSessionUIStore.getState()
    planEntry = sessionUI.sessionPlanIndicator.get(sessionID)
  }

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

  if (settledTurnCandidate && !suppressTurnCandidate && !isViewed) {
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
    externallyHandedOffPlanRequests: sessionUI.externallyHandedOffPlanRequests,
  })
  if (!candidate) return

  sessionUI.markPlanProposed(sessionID, candidate.sourceMessageId)

  // Saving is owned by the lifecycle rather than the rendered PlanCard so a
  // completed background chat has its authoritative file ready before opening.
  const { useProjectsStore } = await import("@/stores/useProjectsStore")
  if (!isCurrent()) return
  const candidateSession = store.getState().session.find((session) => session.id === sessionID)
  if (!candidateSession) return
  const sessionCreated = candidateSession.time?.created
  const sessionSlug = candidateSession.slug
  const sessionDirectory = typeof candidateSession.directory === "string"
    ? candidateSession.directory
    : directory
  const project = resolveProjectForSessionDirectory(
    useProjectsStore.getState().projects,
    useSessionUIStore.getState().availableWorktreesByProject,
    sessionDirectory,
  )
  if (!project || typeof sessionCreated !== "number" || !sessionSlug) return

  await persistSessionPlanRevision({
    sessionId: sessionID,
    identity: {
      projectPath: project.path,
      sessionCreated,
      sessionSlug,
      sourceMessageId: candidate.sourceMessageId,
    },
    markdown: candidate.markdown,
  })
}

export function setActiveSession(directory: string, sessionId: string) {
  const previousDirectory = _activeDirectory
  const previousSession = _activeSession
  _activeDirectory = directory
  _activeSession = sessionId
  if (previousSession && (previousSession !== sessionId || previousDirectory !== directory)) {
    useProviderStallStore.getState().clearStall(previousSession)
    useLongRunningToolStore.getState().clearTool(previousSession)
  }
  const nextKey = directory && sessionId ? statusTrackingKey(directory, sessionId) : ""
  if (nextKey && nextKey !== _activeSessionTrackingKey) {
    _activeSessionTrackingKey = nextKey
    rememberBoundedTimestamp(lastStatusEventAtBySessionKey, nextKey, Date.now())
    lastRecoveryAtBySessionKey.delete(nextKey)
    recoveryFailureCountBySessionKey.delete(nextKey)
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

function collectLoadedSessionScopeIds(state: State, rootSessionID: string): string[] {
  const childrenByParentID = new Map<string, string[]>()
  for (const session of state.session) {
    const parentID = (session as Session & { parentID?: string | null }).parentID
    if (!parentID) continue
    const children = childrenByParentID.get(parentID) ?? []
    children.push(session.id)
    childrenByParentID.set(parentID, children)
  }

  const sessionIDs: string[] = []
  const pending = [rootSessionID]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const sessionID = pending.pop()
    if (!sessionID || seen.has(sessionID)) continue
    seen.add(sessionID)
    sessionIDs.push(sessionID)
    pending.push(...(childrenByParentID.get(sessionID) ?? []))
  }
  return sessionIDs
}

function settleTerminalAttentionForAcceptedWorkingStatus(
  payload: Event,
  store: StoreApi<DirectoryStore>,
): void {
  if (!isWorkingSessionStatusEvent(payload)) return

  const sessionID = getSessionIdFromPayload(payload)
  if (!sessionID) return

  const statusType = store.getState().session_status?.[sessionID]?.type
  if (statusType !== "busy" && statusType !== "retry") return

  const sessionIDs = collectLoadedSessionScopeIds(store.getState(), sessionID)
  useNotificationStore.getState().markSessionsViewed(sessionIDs)

  void import("./session-ui-store")
    .then(({ useSessionUIStore }) => {
      useSessionUIStore.getState().clearReadCompletionIndicators(sessionIDs)
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

type EventRoutingIndex = DirectoryRoutingIndex

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

type DirectorySessionLifecycleChange =
  | { revision: number; type: "upsert"; session: Session }
  | { revision: number; type: "delete"; sessionID: string }

type DirectorySessionLifecycleOverlay = {
  revision: number
  changes: DirectorySessionLifecycleChange[]
}

const DIRECTORY_SESSION_LIFECYCLE_CHANGE_LIMIT = 1_000
const directorySessionLifecycleOverlays = new Map<string, DirectorySessionLifecycleOverlay>()

export const captureDirectorySessionListRevision = (directory: string): number => (
  directorySessionLifecycleOverlays.get(normalizeEventDirectory(directory))?.revision ?? 0
)

const recordDirectorySessionLifecycleChange = (
  directory: string,
  change:
    | { type: "upsert"; session: Session }
    | { type: "delete"; sessionID: string },
): void => {
  const normalizedDirectory = normalizeEventDirectory(directory)
  if (!normalizedDirectory || normalizedDirectory === "global") return

  const overlay = directorySessionLifecycleOverlays.get(normalizedDirectory) ?? {
    revision: 0,
    changes: [],
  }
  const revision = overlay.revision + 1
  overlay.revision = revision
  overlay.changes.push({ ...change, revision } as DirectorySessionLifecycleChange)
  if (overlay.changes.length > DIRECTORY_SESSION_LIFECYCLE_CHANGE_LIMIT) {
    overlay.changes.splice(0, overlay.changes.length - DIRECTORY_SESSION_LIFECYCLE_CHANGE_LIMIT)
  }
  directorySessionLifecycleOverlays.set(normalizedDirectory, overlay)
}

export const reconcileDirectorySessionListSnapshot = (
  directory: string,
  sessions: Session[],
  requestRevision: number,
): Session[] => {
  const overlay = directorySessionLifecycleOverlays.get(normalizeEventDirectory(directory))
  if (!overlay || overlay.revision <= requestRevision) return sessions

  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  for (const change of overlay.changes) {
    if (change.revision <= requestRevision) continue
    if (change.type === "delete") {
      sessionsById.delete(change.sessionID)
      continue
    }

    const current = sessionsById.get(change.session.id)
    if (!current || !isStrictlyOlderSession(change.session, current)) {
      sessionsById.set(change.session.id, change.session)
    }
  }
  return Array.from(sessionsById.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export const resetDirectorySessionLifecycleOverlaysForTest = (): void => {
  directorySessionLifecycleOverlays.clear()
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

  const eventType = String(event.type)
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
    || eventType === "session.compacted"
  ) {
    const sessionID = props.sessionID
    if (typeof sessionID === "string" && sessionID.length > 0) return sessionID
    if (event.type === "session.deleted") {
      const info = props.info
      const infoID = info && typeof info === "object" ? (info as { id?: unknown }).id : undefined
      return typeof infoID === "string" && infoID.length > 0 ? infoID : null
    }
    return null
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

export const getManagedTaskRecoveryRootForIdleEvent = (
  payload: Event,
  hasActiveTasksForRoot: (rootSessionId: string) => boolean,
): string | null => {
  if (payload.type !== "session.idle" && !isIdleSessionStatusEvent(payload)) return null
  const sessionID = getSessionIdFromPayload(payload)
  if (!sessionID || !hasActiveTasksForRoot(sessionID)) return null
  return sessionID
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

const stateContainsSessionData = (state: State, sessionID: string): boolean => (
  state.session.some((session) => session.id === sessionID)
  || Object.prototype.hasOwnProperty.call(state.message, sessionID)
  || Object.prototype.hasOwnProperty.call(state.session_status, sessionID)
  || Object.prototype.hasOwnProperty.call(state.session_diff, sessionID)
  || Object.prototype.hasOwnProperty.call(state.todo, sessionID)
  || Object.prototype.hasOwnProperty.call(state.permission, sessionID)
  || Object.prototype.hasOwnProperty.call(state.question, sessionID)
  || Object.values(state.part).some((parts) => parts.some((part) => (
    (part as Part & { sessionID?: string }).sessionID === sessionID
  )))
)

const resolveSessionRecordDirectory = (session: Session | undefined): string | null => {
  if (!session) return null
  const record = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  const candidate = record.directory ?? record.project?.worktree ?? null
  return candidate ? normalizeEventDirectory(candidate) : null
}

const removeDeletedSessionFromAllChildStores = (
  sessionID: string,
  payload: Event,
  resolvedDirectory: string,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  messageLoader?: SessionMessageLoader,
): void => {
  const targetDirectories: string[] = []
  for (const [directory, store] of childStores.children) {
    if (stateContainsSessionData(store.getState(), sessionID)) {
      targetDirectories.push(directory)
    }
  }
  if (
    resolvedDirectory
    && resolvedDirectory !== "global"
    && childStores.getChild(resolvedDirectory)
    && !targetDirectories.includes(resolvedDirectory)
  ) {
    targetDirectories.push(resolvedDirectory)
  }

  const overlayDirectories = new Set(targetDirectories)
  const deletedSession = (payload.properties as { info?: Session }).info
  const sessionRecordDirectory = resolveSessionRecordDirectory(deletedSession)
  if (sessionRecordDirectory) {
    overlayDirectories.add(sessionRecordDirectory)
  }
  if (resolvedDirectory && resolvedDirectory !== "global") {
    overlayDirectories.add(resolvedDirectory)
  }
  for (const directory of overlayDirectories) {
    recordDirectorySessionLifecycleChange(directory, { type: "delete", sessionID })
    messageLoader?.invalidateSession({ directory, sessionID })
  }

  for (const directory of targetDirectories) {
    const store = childStores.getChild(directory)
    if (!store) continue
    const before = store.getState()
    retireDeletedSessionSyncOwnership(directory, sessionID, before, routingIndex)
    store.setState((current) => {
      const removedSession = current.session.find((session) => session.id === sessionID)
      const next: State = {
        ...current,
        session: current.session.filter((session) => session.id !== sessionID),
        sessionTotal: removedSession && !removedSession.parentID
          ? Math.max(0, current.sessionTotal - 1)
          : current.sessionTotal,
        session_status: { ...current.session_status },
        session_diff: { ...current.session_diff },
        todo: { ...current.todo },
        permission: { ...current.permission },
        question: { ...current.question },
        message: { ...current.message },
        part: { ...current.part },
        session_user_activity: { ...current.session_user_activity },
        revert_transaction: { ...current.revert_transaction },
      }
      dropSessionCaches(next, [sessionID])
      delete next.session_user_activity[sessionID]
      delete next.revert_transaction[sessionID]
      return next
    })
    useTodosPersistStore.getState().setSessionTodos(sessionID, undefined)
    clearSessionChangeAttribution(directory, sessionID)
    childStores.mark(directory)
  }

  removeIndexedSession(routingIndex, sessionID)
  dropPendingToastKeysForSession(sessionID)
  removePersistedSessionInput(sessionID)
  useContextStore.getState().clearSessionContext(sessionID)
  void usePermissionStore.getState().clearSessionAutoAccept(sessionID)
  useNotificationStore.getState().removeSession(sessionID)
  const sessionUI = getSessionUIStoreIfInitialized()?.getState()
  if (sessionUI?.currentSessionId === sessionID) {
    sessionUI.setCurrentSession(null)
  }
  sessionUI?.retireDeletedSession(sessionID)
  useProviderRecoveryStore.getState().clearRecovery(sessionID)
  useProviderStallStore.getState().clearStall(sessionID)
  useLongRunningToolStore.getState().clearTool(sessionID)
  useMessageQueueStore.getState().clearQueue(sessionID)
  useSelectionStore.getState().clearSessionSelection(sessionID)
  syncDebug.dispatch.eventApplied(payload.type, sessionID, undefined)
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
    const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionID)
    if (indexedDirectory && childStores.getChild(indexedDirectory)) {
      return indexedDirectory
    }

    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasSessionState(childStores, normalizedDirectory, sessionID)) {
      setIndexedSessionDirectory(routingIndex, sessionID, normalizedDirectory)
      return normalizedDirectory
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
    const sessionFromMessage = routingIndex.messageSessionById.get(messageID)
    if (sessionFromMessage) {
      const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionFromMessage)
      if (indexedDirectory && childStores.getChild(indexedDirectory)) {
        return indexedDirectory
      }
    }

    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasMessagePartState(childStores, normalizedDirectory, messageID)) {
      return normalizedDirectory
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
  options?: {
    candidateSessionIds?: Iterable<string>
    restoreSessionLifecycleFor?: string
  },
) {
  const current = store.getState()
  const candidateSessionIds = new Set(getReconnectCandidateSessionIds(current, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  }))
  const materializedSessionIds = new Set<string>()
  for (const sessionId of options?.candidateSessionIds ?? []) {
    if (sessionId) candidateSessionIds.add(sessionId)
  }
  if (candidateSessionIds.size === 0) return

  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  const statusBaselineBeforeRequest = captureSessionStatusBaseline(
    store.getState().session_status ?? {},
    candidateSessionIds,
  )
  const nextStatuses = await retry(async () => {
    const result = await scopedClient.session.status()
    return unwrapSdkResult(result, "session.status")
  }).catch(() => null)

  let statusSnapshotCandidates: string[] = []
  let statusBaselineAfterFirstMerge: ReadonlyMap<string, SessionStatus | undefined> = new Map()
  if (nextStatuses) {
    const currentStatuses = store.getState().session_status ?? {}
    statusSnapshotCandidates = filterUnchangedSessionStatusCandidates({
      current: currentStatuses,
      candidateSessionIds,
      baseline: statusBaselineBeforeRequest,
    })
    const mergedStatuses = mergeRecoveredSessionStatuses({
      current: currentStatuses,
      candidateSessionIds: statusSnapshotCandidates,
      authoritative: nextStatuses,
      state: store.getState(),
    })

    if (mergedStatuses !== currentStatuses) {
      store.setState((state: DirectoryStore) => {
        const latestMerged = mergeRecoveredSessionStatuses({
          current: state.session_status ?? {},
          candidateSessionIds: statusSnapshotCandidates,
          authoritative: nextStatuses,
          state,
        })
        if (latestMerged === state.session_status) {
          return state
        }
        return { session_status: latestMerged }
      })
    }
    statusBaselineAfterFirstMerge = captureSessionStatusBaseline(
      store.getState().session_status ?? {},
      statusSnapshotCandidates,
    )
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
    reconcileSessionChangeAttribution(directory, sessionId, store.getState())
    materializedSessionIds.add(sessionId)
  }))

  await resyncBlockingRequestsForDirectory(directory, store, Array.from(candidateSessionIds))

  if (nextStatuses) {
    store.setState((state: DirectoryStore) => {
      const finalStatusSnapshotCandidates = filterUnchangedSessionStatusCandidates({
        current: state.session_status ?? {},
        candidateSessionIds: statusSnapshotCandidates,
        baseline: statusBaselineAfterFirstMerge,
      })
      const latestMerged = mergeRecoveredSessionStatuses({
        current: state.session_status ?? {},
        candidateSessionIds: finalStatusSnapshotCandidates,
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

  const finalStatuses = store.getState().session_status ?? {}
  const lifecycleRestoreIds = new Set<string>()
  if (
    options?.restoreSessionLifecycleFor
    && materializedSessionIds.has(options.restoreSessionLifecycleFor)
  ) {
    lifecycleRestoreIds.add(options.restoreSessionLifecycleFor)
  }
  // Background sessions whose busy→idle transition happened during a connection
  // gap never received the session.idle event, so plan/turn lifecycle detection
  // must run here. Gated on an observed busy/retry baseline: candidates added by
  // the unfinished-message/parent heuristics have no recency evidence, and
  // detection on them would resurface long-viewed completions as unread.
  for (const sessionId of candidateSessionIds) {
    if (lifecycleRestoreIds.has(sessionId)) continue
    if (!materializedSessionIds.has(sessionId)) continue
    const baselineType = statusBaselineBeforeRequest.get(sessionId)?.type
    if (baselineType !== "busy" && baselineType !== "retry") continue
    const finalType = finalStatuses[sessionId]?.type
    if (finalType === "busy" || finalType === "retry") continue
    lifecycleRestoreIds.add(sessionId)
  }
  if (lifecycleRestoreIds.size > 0) {
    await Promise.all(Array.from(lifecycleRestoreIds).map((sessionId) =>
      materializeAndRestoreSessionLifecycle(directory, sessionId, store, true),
    ))
  }
}

function handleEvent(
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  activeDirectory: string,
  messageLoader?: SessionMessageLoader,
) {
  const directory = resolveDirectoryFromRoutingIndex(routingIndex, rawDirectory, payload, childStores)

  if (payload.type === "session.created" || payload.type === "session.updated") {
    const session = (payload.properties as { info?: Session }).info
    if (session) {
      applyGlobalSessionLifecycleEvent({ type: "upsert", session })
      const lifecycleDirectory = resolveSessionRecordDirectory(session)
        ?? (directory && directory !== "global" ? directory : null)
      if (lifecycleDirectory) {
        recordDirectorySessionLifecycleChange(lifecycleDirectory, { type: "upsert", session })
      }
    }
  } else if (payload.type === "session.deleted") {
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID) {
      clearAllProviderContextUsageForSession(sessionID)
      applyGlobalSessionLifecycleEvent({ type: "delete", sessionID })
      removeDeletedSessionFromAllChildStores(
        sessionID,
        payload,
        directory,
        childStores,
        routingIndex,
        messageLoader,
      )
    }
    return
  }

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
    // On server.connected / global.disposed, re-bootstrap the active directory
    // but only if not during recent boot. Passive stores must remain cache-only.
    if (payload.type === "server.connected" || payload.type === "global.disposed") {
      if (!recent) {
        for (const dir of getActiveDirectoryStoreKeys(childStores.children.keys(), activeDirectory)) {
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

  if (payload.type === "session.created" || payload.type === "session.updated") {
    const incoming = (payload.properties as { info?: Session }).info
    const currentSession = incoming
      ? store.getState().session.find((session) => session.id === incoming.id)
      : undefined
    if (incoming && currentSession && isStrictlyOlderSession(incoming, currentSession)) {
      responsivenessPerfCount("sync.event.noop")
      syncDebug.dispatch.eventNoChange(payload.type, incoming.id, undefined)
      return
    }
  }

  childStores.mark(resolvedDirectory)

  if (String(payload.type) === "session.compacted") {
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID) {
      invalidateProviderContextUsageForCompaction(sessionID, resolvedDirectory)
    }
  }

  if (payload.type === "message.updated") {
    const info = (payload.properties as { info?: Message }).info as (Message & {
      providerID?: unknown
      time?: { completed?: unknown }
    }) | undefined
    if (
      info?.role === "assistant"
      && info.providerID === "anthropic"
      && typeof info.time?.completed === "number"
    ) {
      const tokens = extractTokenBreakdownFromMessage(info)
      const activeInputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
      const storeKey = getProviderContextUsageStoreKey(info.sessionID, resolvedDirectory)
      const compactionRevision = useProviderContextUsageStore.getState().compactionRevisions.get(storeKey) ?? 0
      void refreshProviderContextUsage({
        sessionID: info.sessionID,
        directory: resolvedDirectory,
        requestKey: JSON.stringify([info.id, activeInputTokens, info.time.completed, compactionRevision]),
      })
    }
  }

  if (payload.type === "session.status") {
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID) {
      const nextStatus = (payload.properties as {
        status?: { type?: unknown; attempt?: unknown; message?: unknown; next?: unknown }
      }).status
      const currentStatus = store.getState().session_status?.[sessionID] as {
        type?: unknown
        attempt?: unknown
        message?: unknown
        next?: unknown
      } | undefined
      const statusChanged = nextStatus?.type !== currentStatus?.type
        || nextStatus?.attempt !== currentStatus?.attempt
        || nextStatus?.message !== currentStatus?.message
        || nextStatus?.next !== currentStatus?.next
      markStatusEventObserved(resolvedDirectory, sessionID, statusChanged)
      const statusType = nextStatus?.type
      if (statusType !== "busy") {
        useProviderStallStore.getState().clearStall(sessionID)
        useLongRunningToolStore.getState().clearTool(sessionID)
      }
    }
  }

  if (payload.type === "session.idle" || payload.type === "session.error") {
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID) {
      useProviderStallStore.getState().clearStall(sessionID)
      useLongRunningToolStore.getState().clearTool(sessionID)
    }
  }

  if (payload.type === "permission.asked") {
    const permission = payload.properties as PermissionRequest
    useLongRunningToolStore.getState().clearTool(permission.sessionID)
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
    useLongRunningToolStore.getState().clearTool(question.sessionID)
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
  const outputSessionID = getOutputSessionIdFromPayload(current, routingIndex, payload)
  markOutputEventObserved(resolvedDirectory, outputSessionID)
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
    const attributionSessionID = sessionID
      ?? (messageID ? resolveSessionIdForMessage(store.getState(), routingIndex, messageID) ?? undefined : undefined)
    if (
      attributionSessionID
      && (
        payload.type === "message.part.updated"
        || payload.type === "message.part.removed"
        || payload.type === "message.removed"
        || payload.type === "session.updated"
      )
    ) {
      const part = payload.type === "message.part.updated"
        ? (payload.properties as { part?: Part }).part
        : undefined
      if (payload.type !== "message.part.updated" || part?.type === "tool") {
        reconcileSessionChangeAttribution(resolvedDirectory, attributionSessionID, store.getState())
      }
    }
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

  settleTerminalAttentionForAcceptedWorkingStatus(payload, store)

  const managedStore = useManagedOrchestrationStore.getState()
  const managedRecoveryRoot = getManagedTaskRecoveryRootForIdleEvent(
    payload,
    (rootSessionId) => managedOrchestrationSelectors.hasActiveTasksForRoot(rootSessionId)(managedStore),
  )
  if (managedRecoveryRoot) {
    void managedStore.loadSnapshot({ rootSessionId: managedRecoveryRoot })
  }

  replayPendingPartDeltasForEvent(resolvedDirectory, payload, store)

  if (outputSessionID) {
    const incomingPart = payload.type === "message.part.updated"
      ? (payload.properties as { part?: Part }).part
      : undefined
    reconcileLongRunningTool(
      resolvedDirectory,
      outputSessionID,
      store.getState(),
      incomingPart,
    )
  }

  if (
    payload.type === "session.idle"
    || isIdleSessionStatusEvent(payload)
    || payload.type === "session.error"
    || payload.type === "session.updated"
    || payload.type === "message.updated"
    || payload.type === "message.part.updated"
  ) {
    const latestState = store.getState()
    const lifecycleSessionId = resolveLifecycleSessionIdFromPayload(latestState, routingIndex, payload)
    if (lifecycleSessionId) {
      if (
        payload.type === "session.idle"
        || isIdleSessionStatusEvent(payload)
        || payload.type === "session.error"
      ) {
        settleStreamingSessions([lifecycleSessionId])
      }
      if (
        payload.type === "session.idle" || isIdleSessionStatusEvent(payload)
      ) {
        const sessionUI = getSessionUIStoreIfInitialized()?.getState()
        const pendingPlanModeMessageId = sessionUI?.planModeUserMessagesBySession.get(lifecycleSessionId)
        const effectivePlanState = resolveEffectivePlanIndicatorState(
          sessionUI?.sessionPlanIndicator.get(lifecycleSessionId),
          pendingPlanModeMessageId,
        )
        const needsPlanReadyRefresh = Boolean(pendingPlanModeMessageId) && effectivePlanState !== "proposed"
        const lifecycleSession = latestState.session.find((session) => session.id === lifecycleSessionId)
        const isRootSession = !lifecycleSession
          || !((lifecycleSession as Session & { parentID?: string | null }).parentID)
        const needsBackgroundCompletionRefresh = isRootSession
          && !isViewedInCurrentSession(resolvedDirectory, lifecycleSessionId)
        if (
          needsPlanReadyRefresh
          || needsBackgroundCompletionRefresh
          || !getSessionMaterializationStatus(latestState, lifecycleSessionId).renderable
        ) {
          enqueueSessionMaterialization(resolvedDirectory, lifecycleSessionId, childStores, {
            detectTurnCompletionAfterLoad: true,
          })
        }
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
  activeDirectory = "",
) {
  handleEvent(rawDirectory, payload, childStores, routingIndex, activeDirectory)
}

export function createForegroundRecoveryHandlers(
  triggerRecovery: () => void,
  getVisibilityState: () => DocumentVisibilityState | undefined = () => (
    typeof document === "undefined" ? undefined : document.visibilityState
  ),
) {
  return {
    onVisibilityChange: () => {
      if (getVisibilityState() !== "visible") return
      triggerRecovery()
    },
    onWindowFocus: () => {
      triggerRecovery()
    },
  }
}

type UserNotificationHandlerOptions = {
  isFocused?: () => boolean
  notify?: (payload: { title?: string; body?: string; tag?: string }) => void | Promise<void>
}

export function handleUserNotificationEvent(
  payload: unknown,
  options: UserNotificationHandlerOptions = {},
): void {
  if (
    !payload
    || typeof payload !== "object"
    || (payload as { type?: unknown }).type !== "openchamber:notification"
  ) return
  const properties = payload && typeof payload === "object"
    && (payload as { properties?: unknown }).properties
    && typeof (payload as { properties: unknown }).properties === "object"
    ? (payload as { properties: Record<string, unknown> }).properties
    : null
  if (!properties) return

  if (properties.kind === "plan-ready") {
    const sessionId = typeof properties.sessionId === "string" ? properties.sessionId.trim() : ""
    const sourceMessageId = typeof properties.sourceMessageId === "string"
      ? properties.sourceMessageId.trim()
      : ""
    if (sessionId && sourceMessageId) {
      getSessionUIStoreIfInitialized()?.getState().markPlanProposed(sessionId, sourceMessageId)
    }
  }

  // These gates control native delivery only. Lifecycle state above must be
  // ingested even while the user is focused in a different session.
  if (properties.desktopStdoutActive === true) return
  const requireHidden = properties.requireHidden === true
  const isFocused = options.isFocused?.() ?? (typeof document !== "undefined"
    && document.visibilityState === "visible"
    && document.hasFocus())
  if (requireHidden && isFocused) return

  const title = typeof properties.title === "string" ? properties.title : undefined
  const body = typeof properties.body === "string" ? properties.body : undefined
  const tag = typeof properties.tag === "string" ? properties.tag : undefined
  if (!title && !body) return
  const notify = options.notify ?? ((notification) => (
    getRegisteredRuntimeAPIs()?.notifications.notifyAgentCompletion(notification)
  ))
  void notify({ title, body, tag })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SyncProvider(props: {
  sdk: OpencodeClient
  directory: string
  children: React.ReactNode
}) {
  const messageStreamTransport = 'auto' as const
  const childStoresRef = useRef<ChildStoreManager | null>(null)
  if (!childStoresRef.current) childStoresRef.current = new ChildStoreManager()
  const childStores = childStoresRef.current
  const messageLoaderRef = useRef<SessionMessageLoader | null>(null)
  if (!messageLoaderRef.current) messageLoaderRef.current = new SessionMessageLoader(childStores)
  const messageLoader = messageLoaderRef.current
  messageLoader.activate()
  messageLoader.setActivePrefetchDirectory(props.directory)
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current
  const activeDirectoryRef = useRef(props.directory)
  activeDirectoryRef.current = props.directory
  const releaseEventPipelineDirectoryRef = useRef<(directory: string) => void>(() => undefined)
  const activateOwnershipCleanupRef = useRef<(() => () => void) | null>(null)
  if (!activateOwnershipCleanupRef.current) {
    activateOwnershipCleanupRef.current = createRestartSafeOwnershipCleanup(() => {
      messageLoader.dispose()
      childStores.disposeAll()
      clearSessionMaterializerChildStores(childStores)
      clearSyncRefs(childStores)
      clearActionRefs(childStores)
    })
  }
  setSessionMaterializerChildStores(childStores)

  const resyncSession = useCallback(
    async (sessionID: string, options?: { directory?: string | null; reason?: "focus" | "reconnect" | "manual" }) => {
      if (!sessionID) return
      const directory = options?.directory || props.directory
      if (!directory) return
      const store = childStores.ensureChild(directory)
      await resyncDirectoryAfterReconnect(directory, store, routingIndex, {
        candidateSessionIds: [sessionID],
        restoreSessionLifecycleFor: sessionID,
      })
    },
    [childStores, props.directory, routingIndex],
  )

  const system = useMemo<SyncSystem>(
    () => ({
      childStores,
      messageLoader,
      sdk: props.sdk,
      directory: props.directory,
      resyncSession,
    }),
    [childStores, messageLoader, props.sdk, props.directory, resyncSession],
  )

  // Configure child store manager
  useEffect(() => {
    const bootingDirs = new Map<string, symbol>()

    childStores.configure({
      onBootstrap: (directory) => {
        if (bootingDirs.has(directory)) return
        const bootstrapToken = Symbol(directory)
        bootingDirs.set(directory, bootstrapToken)

        const store = childStores.getChild(directory)
        if (!store) {
          if (bootingDirs.get(directory) === bootstrapToken) {
            bootingDirs.delete(directory)
          }
          return
        }
        const isOwned = () => (
          childStores.getChild(directory) === store
          && bootingDirs.get(directory) === bootstrapToken
        )

        const runBootstrap = async () => {
          const globalState = useGlobalSyncStore.getState()
          await bootstrapDirectory({
            directory,
            sdk: props.sdk,
            getState: () => store.getState(),
            set: (patch) => {
              if (!isOwned()) return
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
              if (!isOwned()) return
              const requestLifecycleRevision = captureDirectorySessionListRevision(dir)
              store.setState({ sessionListStatus: "loading", sessionListError: undefined })
              const result = await props.sdk.session.list({
                directory: dir,
                roots: true,
                limit: 50,
              })
              if (!isOwned()) return
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
              const snapshotSessions = (result.data ?? [])
                .filter((s) => !!s?.id)
                .map((session) => stripUntrustedSessionDiffSummary(
                  stripSessionDiffSnapshots(session) as Session & { summary?: SessionSummaryDiffStats | null },
                ) as Session)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              // A successful snapshot is authoritative, including an empty
              // list. Replay only lifecycle events that arrived after this
              // request began so concurrent creates survive and deletes win.
              const sessions = reconcileDirectorySessionListSnapshot(
                dir,
                snapshotSessions,
                requestLifecycleRevision,
              )
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
          if (!isOwned()) return
          void restorePersistedSessionIndicatorsForDirectory(directory, store).catch(() => undefined)
        }

        runBootstrap().finally(() => {
          if (bootingDirs.get(directory) === bootstrapToken) {
            bootingDirs.delete(directory)
          }
        })
      },
      onDispose: (directory, snapshot) => {
        bootingDirs.delete(directory)
        messageLoader.invalidateDirectory(directory)
        directorySessionLifecycleOverlays.delete(normalizeEventDirectory(directory))
        clearDirectorySessionChangeAttributions(directory)
        releaseDirectoryOwnedSyncState(
          directory,
          snapshot,
          routingIndex,
          releaseEventPipelineDirectoryRef.current,
        )
      },
      isBooting: (directory) => bootingDirs.has(directory),
      isLoadingSessions: () => false,
    })
    for (const directory of getActiveDirectoryStoreKeys(childStores.children.keys(), activeDirectoryRef.current)) {
      const store = childStores.children.get(directory)
      if (store && store.getState().status !== "complete") {
        childStores.ensureChild(directory)
      }
    }
    return () => {
      bootingDirs.clear()
    }
  }, [childStores, messageLoader, props.sdk, routingIndex])

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
    const activeSessionRecoveriesInFlight = new Set<string>()
    const triggerReconnectMaterialization = (directory: string) => {
      const store = childStores.children.get(directory)
      if (!store) return
      if (reconnectMaterializing.has(directory)) return

      const activeSessionID = directory === _activeDirectory ? _activeSession : ""
      reconnectMaterializing.add(directory)
      void resyncDirectoryAfterReconnect(directory, store, routingIndex, {
        candidateSessionIds: activeSessionID ? [activeSessionID] : undefined,
        restoreSessionLifecycleFor: activeSessionID || undefined,
      })
        .catch(() => {
          // Transient failure during materialization — next SSE event, transport switch,
          // reconnect, or foreground focus will catch up.
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
      const activityAt = getActiveSessionRecoveryActivityAt({
        status,
        now,
        lastStatusEventAt: lastStatusEventAtBySessionKey.get(key),
        lastOutputEventAt: lastOutputEventAtBySessionKey.get(key),
      })
      const failureCount = recoveryFailureCountBySessionKey.get(key) ?? 0
      const fingerprintBeforeResync = getProviderStallFingerprint({ state, sessionID })
      const longRunningFingerprintBeforeResync = getLongRunningToolFingerprint({
        state,
        sessionID,
      })

      if (!shouldRecoverStaleActiveSession({
        status,
        now,
        lastStatusEventAt: lastStatusEventAtBySessionKey.get(key),
        lastOutputEventAt: lastOutputEventAtBySessionKey.get(key),
        lastRecoveryAt: lastRecoveryAtBySessionKey.get(key),
        staleMs: ACTIVE_SESSION_STATUS_STALE_MS,
        cooldownMs: getActiveSessionRecoveryCooldownMs(failureCount),
      })) {
        return
      }
      if (activeSessionRecoveriesInFlight.has(key)) return

      activeSessionRecoveriesInFlight.add(key)
      rememberBoundedTimestamp(lastRecoveryAtBySessionKey, key, now)
      void resyncDirectoryAfterReconnect(directory, store, routingIndex, {
        candidateSessionIds: [sessionID],
      }).then(() => {
        const currentState = store.getState()
        const currentActivityAt = getActiveSessionRecoveryActivityAt({
          status: currentState.session_status?.[sessionID],
          now: Date.now(),
          lastStatusEventAt: lastStatusEventAtBySessionKey.get(key),
          lastOutputEventAt: lastOutputEventAtBySessionKey.get(key),
        })
        if (currentActivityAt !== activityAt) return
        recoveryFailureCountBySessionKey.delete(key)

        const fingerprintAfterResync = getProviderStallFingerprint({
          state: currentState,
          sessionID,
        })
        const longRunningFingerprintAfterResync = getLongRunningToolFingerprint({
          state: currentState,
          sessionID,
        })
        const managedChildActive = managedOrchestrationSelectors.hasActiveTasksForRoot(sessionID)(
          useManagedOrchestrationStore.getState(),
        )
        const stalledForMs = Date.now() - activityAt
        if (
          !managedChildActive
          && stalledForMs >= PROVIDER_STALL_SEMANTIC_SILENCE_MS
          && haveSameProviderStallFingerprint(fingerprintBeforeResync, fingerprintAfterResync)
          && fingerprintAfterResync
        ) {
          const stallStore = useProviderStallStore.getState()
          const previousStall = stallStore.stallsBySessionId[sessionID]
          stallStore.offerStall({
            ...fingerprintAfterResync,
            directory,
            confirmedAt: Date.now(),
          })
          if (haveSameProviderStallFingerprint(previousStall, fingerprintAfterResync)) {
            return
          }
          const mark = fingerprintAfterResync.kind === "inference"
            ? "renderer_provider_inference_stall_confirmed"
            : "renderer_tool_input_stall_confirmed"
          postRendererTurnTimingMark({
            sessionId: sessionID,
            assistantMessageId: fingerprintAfterResync.assistantMessageID,
            mark,
            directory,
            metadata: {
              source: "active-session-watchdog",
              stalledForMs,
            },
          })
          if (fingerprintAfterResync.kind !== "inference") return

          const record = useProviderStallStore.getState().stallsBySessionId[sessionID]
          if (!record || record.kind !== "inference") return
          useProviderStallStore.getState().setActionState(sessionID, true, null)
          return stopStalledProviderAndOfferRecovery(record, {
            resyncSession,
            getState: () => (
              childStores.getChild(directory) === store ? store.getState() : undefined
            ),
            isCurrent: () => {
              const latest = useProviderStallStore.getState().stallsBySessionId[sessionID]
              return haveSameProviderStallFingerprint(record, latest)
            },
            abort: async (stalledSessionID, stalledStatus) => {
              const latest = useProviderStallStore.getState().stallsBySessionId[stalledSessionID]
              if (!haveSameProviderStallFingerprint(record, latest)) return false
              return sessionActions.abortCurrentOperationConfirmed(stalledSessionID, stalledStatus)
            },
            offerRecovery: (recovery) => useProviderRecoveryStore.getState().offerRecovery(recovery),
          }).then(() => {
            useProviderStallStore.getState().clearStall(sessionID, record)
          }).catch((error) => {
            useProviderStallStore.getState().setActionState(
              sessionID,
              false,
              error instanceof Error ? error.message : String(error),
            )
          })
        }
        if (!fingerprintAfterResync) {
          useProviderStallStore.getState().clearStall(sessionID)
        }

        if (longRunningFingerprintAfterResync) {
          const longRunningStore = useLongRunningToolStore.getState()
          const previousRecord = longRunningStore.recordsBySessionId[sessionID]
          const sameObservedCall = haveSameLongRunningToolFingerprint(
            previousRecord,
            longRunningFingerprintAfterResync,
          )
          const observation = {
            ...longRunningFingerprintAfterResync,
            directory,
            observedAt: sameObservedCall ? previousRecord.observedAt : activityAt,
            lastActivityAt: sameObservedCall ? previousRecord.lastActivityAt : activityAt,
          }
          longRunningStore.observeTool(observation, false)
          const toolNow = Date.now()
          const toolSilentForMs = toolNow - observation.lastActivityAt
          const elapsedMs = toolNow - observation.observedAt

          if (
            shouldConfirmLongRunningTool({
              managedChildActive,
              silentForMs: toolSilentForMs,
              before: longRunningFingerprintBeforeResync,
              after: longRunningFingerprintAfterResync,
            })
            && longRunningStore.confirmTool(observation, toolNow)
          ) {
            postRendererTurnTimingMark({
              sessionId: sessionID,
              assistantMessageId: longRunningFingerprintAfterResync.assistantMessageID,
              mark: "renderer_long_running_tool_confirmed",
              directory,
              metadata: {
                source: "active-session-watchdog",
                elapsedMs,
                tool: longRunningFingerprintAfterResync.tool,
              },
            })
          }
        } else {
          useLongRunningToolStore.getState().clearTool(sessionID)
        }
      }).catch(() => {
        const currentState = store.getState()
        const currentActivityAt = getActiveSessionRecoveryActivityAt({
          status: currentState.session_status?.[sessionID],
          now: Date.now(),
          lastStatusEventAt: lastStatusEventAtBySessionKey.get(key),
          lastOutputEventAt: lastOutputEventAtBySessionKey.get(key),
        })
        if (currentActivityAt !== activityAt) return
        rememberBoundedTimestamp(recoveryFailureCountBySessionKey, key, failureCount + 1)
      }).finally(() => {
        activeSessionRecoveriesInFlight.delete(key)
      })
    }
    const triggerRelevantDirectoryRecovery = () => {
      for (const dir of getReconnectRecoveryDirectoryStoreKeys(
        childStores.children.entries(),
        activeDirectoryRef.current,
      )) {
        triggerReconnectMaterialization(dir)
      }
    }
    const {
      onVisibilityChange,
      onWindowFocus,
    } = createForegroundRecoveryHandlers(triggerRelevantDirectoryRecovery)
    const activeRecoveryWatchdog = setInterval(triggerActiveSessionRecovery, ACTIVE_SESSION_RECOVERY_CHECK_MS)
    ;(activeRecoveryWatchdog as { unref?: () => void }).unref?.()
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange)
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onWindowFocus)
    }

    const { cleanup, releaseDirectory } = createEventPipeline({
      sdk: props.sdk,
      transport: messageStreamTransport,
      routeDirectory: (directory, payload) => {
        return resolveDirectoryFromRoutingIndex(routingIndex, directory, payload, childStores)
      },
      onEvent: (directory, payload) => {
        handleEvent(directory, payload, childStores, routingIndex, activeDirectoryRef.current, messageLoader)
      },
      onManagedOrchestrationEvent: (payload) => {
        useManagedOrchestrationStore.getState().ingestEvent(payload)
      },
      onUserNotificationEvent: (payload) => {
        handleUserNotificationEvent(payload)
      },
      onReconnect: () => {
        applyEventPipelineConnectionEvent({ type: "reconnected" })
        triggerRelevantDirectoryRecovery()
        void useManagedOrchestrationStore.getState().loadSnapshot()
      },
      onDisconnect: (reason) => {
        applyEventPipelineConnectionEvent({ type: "disconnected", reason })
      },
      onTransportSwitch: () => {
        // Transport switched (e.g. WS timeout → SSE fallback) without a full
        // connection. Preserve the current connection state until the fallback
        // stream actually connects; a switch alone does not prove reachability.
        applyEventPipelineConnectionEvent({ type: "transport-switched" })
        // If the active session missed the transition into a busy turn, force
        // a targeted resync for the viewed directory and any initialized
        // background directory that still projects active work.
        triggerRelevantDirectoryRecovery()
      },
      onReplayGap: () => {
        // Server's replay buffer rolled past our lastEventId, so cached state
        // is potentially stale. Re-fetch the active directory plus initialized
        // background directories that still project active work.
        triggerRelevantDirectoryRecovery()
        void useManagedOrchestrationStore.getState().loadSnapshot()
      },
    })
    releaseEventPipelineDirectoryRef.current = releaseDirectory
    return () => {
      clearInterval(activeRecoveryWatchdog)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange)
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onWindowFocus)
      }
      if (releaseEventPipelineDirectoryRef.current === releaseDirectory) {
        releaseEventPipelineDirectoryRef.current = () => undefined
      }
      cleanup()
    }
  }, [props.sdk, childStores, messageLoader, routingIndex, messageStreamTransport, resyncSession])

  // Ensure current directory's child store exists
  useEffect(() => {
    if (!props.directory) return
    const store = childStores.ensureChild(props.directory)
    childStores.pin(props.directory)
    ingestDirectoryStateIntoRoutingIndex(routingIndex, props.directory, store.getState())
    return () => {
      childStores.unpin(props.directory)
    }
  }, [props.directory, childStores, routingIndex])

  useEffect(() => activateOwnershipCleanupRef.current?.(), [childStores])

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
  return system.childStores.ensureChild(dir, {
    bootstrap: shouldBootstrapDirectorySubscription(directory, system.directory),
  })
}

/** Select from the current directory's store */
export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

/** Subscribe to the exact message-loader leaf for one session. */
export function useSessionMessageLoadState(
  sessionID: string,
  directory?: string,
): SessionMessageLoadState {
  const system = useSyncSystem()
  const target = useMemo(
    () => ({ directory: directory ?? system.directory, sessionID }),
    [directory, sessionID, system.directory],
  )
  return React.useSyncExternalStore(
    useCallback(
      (notify) => sessionID && target.directory
        ? system.messageLoader.subscribe(target, notify)
        : () => undefined,
      [sessionID, system.messageLoader, target],
    ),
    useCallback(
      () => sessionID && target.directory
        ? system.messageLoader.getSnapshot(target)
        : EMPTY_SESSION_MESSAGE_LOAD_STATE,
      [sessionID, system.messageLoader, target],
    ),
    useCallback(() => EMPTY_SESSION_MESSAGE_LOAD_STATE, []),
  )
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
    const fetchOwnership: { promise?: Promise<void> } = {}
    const fetchResult = ensureSessionChildrenFetch(sessionChildrenFetches, key, refreshKey, async () => {
      const result = await system.sdk.session.children({ sessionID: parentID, directory: dir })
      if (
        system.childStores.getChild(dir) !== store
        || sessionChildrenFetches.get(key)?.promise !== fetchOwnership.promise
      ) {
        return
      }
      const childSessions = unwrapSdkResult(result, "session.children") ?? []
      store.setState((state: DirectoryStore) => {
        const nextSessions = mergeChildSessions(state.session, childSessions, { directory: dir })
        if (nextSessions === state.session) {
          return state
        }
        return { session: nextSessions }
      })
    })
    fetchOwnership.promise = fetchResult.promise

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

/** Select only whether this session has an in-flight scoped revert. */
export function useSessionRevertPending(sessionID: string, directory?: string): boolean {
  return useDirectorySync(
    useCallback(
      (state: State) => state.revert_transaction[sessionID]?.status === "pending",
      [sessionID],
    ),
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
  const { childStores, directory: activeDirectory } = useSyncSystem()
  const getSnapshot = useCallback(() => {
    if (directory) {
      return selectSessionById(childStores.getChild(directory)?.getState().session ?? [], sessionID)
    }
    return findLiveSession(getLiveStates(childStores), sessionID)
  }, [childStores, directory, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      const store = childStores.ensureChild(directory, {
        bootstrap: shouldBootstrapDirectorySubscription(directory, activeDirectory),
      })
      return subscribeToSessionBranch(store, notify)
    }
    return childStores.subscribeSessionLists(notify)
  }, [activeDirectory, childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get one session directory by id for a directory */
export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  const { childStores, directory: activeDirectory } = useSyncSystem()
  const getSnapshot = useCallback(() => {
    if (directory) {
      return selectSessionDirectoryById(childStores.getChild(directory)?.getState().session ?? [], sessionID)
    }
    const session = findLiveSession(getLiveStates(childStores), sessionID)
    return (session as (Session & { directory?: string | null }) | undefined)?.directory ?? undefined
  }, [childStores, directory, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      const store = childStores.ensureChild(directory, {
        bootstrap: shouldBootstrapDirectorySubscription(directory, activeDirectory),
      })
      return subscribeToSessionBranch(store, notify)
    }
    return childStores.subscribeSessionLists(notify)
  }, [activeDirectory, childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get one parent's direct children with a referentially stable projection. */
export function useSessionChildren(parentID?: string | null, directory?: string): Session[] {
  const store = useDirectoryStore(directory)
  const cacheRef = React.useRef<{
    parentID?: string | null
    source: Session[]
    children: Session[]
  } | null>(null)

  const getSnapshot = useCallback(() => {
    const source = store.getState().session
    const cached = cacheRef.current
    if (cached && cached.parentID === parentID && cached.source === source) {
      return cached.children
    }

    const previousChildren = cached && cached.parentID === parentID
      ? cached.children
      : undefined
    const children = selectSessionChildren(source, parentID, previousChildren)
    cacheRef.current = { parentID, source, children }
    return children
  }, [parentID, store])

  const subscribe = useCallback(
    (notify: () => void) => subscribeToSessionBranch(store, notify),
    [store],
  )

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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

const isContextUsagePart = (part: Part): boolean => {
  if (part.type === "step-finish" || part.type === "compaction") return true
  if (part.type !== "text") return false
  const text = (part as Part & { text?: unknown; content?: unknown }).text
  const content = (part as Part & { content?: unknown }).content
  const value = typeof text === "string" ? text : typeof content === "string" ? content : ""
  return value.trim() === "/compact"
}

export function selectContextUsageParts(parts: Part[], previous?: Part[]): Part[] {
  const next = parts.filter(isContextUsagePart)
  if (
    previous
    && previous.length === next.length
    && previous.every((part, index) => part === next[index])
  ) {
    return previous
  }
  return next.length > 0 ? next : EMPTY_PARTS
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
  options?: { suspendPartUpdates?: boolean; contextUsagePartsOnly?: boolean },
): SessionMessageRecordsSnapshot {
  const { sourceMessages, visibleMessages, revertMessageID } = getVisibleMessagesForSession(state, sessionID, previous)
  const nextById = new Map<string, SessionMessageRecord>()
  const nextList = visibleMessages.map((message) => {
    const previousRecord = previous?.byId.get(message.id)
    const sourceParts = state.part[message.id] ?? EMPTY_PARTS
    const parts = options?.contextUsagePartsOnly
      ? selectContextUsageParts(sourceParts, previousRecord?.parts)
      : options?.suspendPartUpdates && previousRecord
        ? previousRecord.parts
        : sourceParts

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
  options?: { suspendPartUpdates?: boolean; contextUsagePartsOnly?: boolean },
) {
  const store = useDirectoryStore(directory)
  const suspendPartUpdates = Boolean(options?.suspendPartUpdates)
  const contextUsagePartsOnly = Boolean(options?.contextUsagePartsOnly)
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
      { suspendPartUpdates, contextUsagePartsOnly },
    )
    snapshotRef.current = nextSnapshot
    return nextSnapshot.list
  }, [contextUsagePartsOnly, sessionID, store, suspendPartUpdates])

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

export function useEnsureSessionMessages(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)

  React.useEffect(() => {
    if (!sessionID) return

    const state = store.getState()
    // Session doesn't exist — nothing to load
    if (!state.session.some((s) => s.id === sessionID)) return

    const dir = directory ?? opencodeClient.getDirectory()
    void materializeAndRestoreSessionLifecycle(dir ?? "", sessionID, store).catch(() => {
      // Transient failure — next navigation or reconnect will retry.
    })
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
