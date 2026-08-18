import { beforeEach, describe, expect, mock, test } from "bun:test"

const clearSessionAutoAcceptCalls: string[] = []

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({
      isSessionAutoAccepting: () => false,
      clearSessionAutoAccept: (sessionId: string) => {
        clearSessionAutoAcceptCalls.push(sessionId)
        return Promise.resolve()
      },
    }),
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: { getState: () => ({ setSessionTodos: () => undefined }) },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined, dismiss: () => undefined },
}))

import type { Event, Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { INITIAL_STATE } from "./types"
import { opencodeClient } from "@/lib/opencode/client"
import { useSessionUIStore } from "./session-ui-store"
import {
  applySyncEventForTest,
  captureDirectorySessionListRevision,
  handleUserNotificationEvent,
  reconcileDirectorySessionListSnapshot,
  resetDirectorySessionLifecycleOverlaysForTest,
  restorePersistedSessionIndicatorsForDirectory,
  setActiveSession,
  setExternallyViewedSession,
} from "./sync-context"
import { useNotificationStore } from "./notification-store"
import { isAbortGuardActive, registerManualAbortGuard, resetAbortGuardState } from "./abort-retry-guard"
import { useSelectionStore } from "./selection-store"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { useContextStore } from "@/stores/contextStore"
import type { EditPermissionMode, SessionContextUsage } from "@/stores/types/sessionTypes"
import { getSafeStorage } from "@/stores/utils/safeStorage"
import { useSessionWorktreeStore } from "./session-worktree-store"
import { useSessionPlanFileStore } from "@/stores/useSessionPlanFileStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import {
  getSessionChangeAttributionKey,
  useSessionChangeAttributionStore,
} from "@/stores/useSessionChangeAttributionStore"
import { buildPlanImplementationRequestMarker } from "@/lib/messages/actionablePlan"
import {
  resetGlobalSessionLifecycleOverlayForTest,
  useGlobalSessionsStore,
} from "@/stores/useGlobalSessionsStore"
import { resolveSidebarIndicator } from "@/components/session/sidebar/sessionIndicator"
import * as sessionActions from "./session-actions"
import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { RuntimeAPIs } from "@/lib/api/types"
import { useStreamingStore } from "./streaming"

const DIRECTORY = "/repo"
const SESSION_ID = "ses_1"
const USER_MESSAGE_ID = "msg_1_user"
const ASSISTANT_MESSAGE_ID = "msg_2_assistant"
const PART_ID = "prt_assistant_1"
const IMPLEMENT_USER_MESSAGE_ID = "msg_3_implement_user"
const IMPLEMENT_ASSISTANT_MESSAGE_ID = "msg_4_implement_assistant"
const IMPLEMENT_PART_ID = "prt_implement_assistant_1"

const structuredPlanBody = [
  "# Cursor Plan Indicator Fix",
  "",
  "## Context",
  "",
  "Cursor models omit the sentinel.",
  "",
  "## Implementation",
  "",
  "1. Add fallback detection.",
  "",
  "## Verification",
  "",
  "1. Run tests.",
].join("\n")

const userMessage = (): Message => ({
  id: USER_MESSAGE_ID,
  sessionID: SESSION_ID,
  role: "user",
  time: { created: 1 },
} as Message)

const assistantMessage = (): Message => ({
  id: ASSISTANT_MESSAGE_ID,
  sessionID: SESSION_ID,
  role: "assistant",
  providerID: "cursor-acp",
  time: { created: 2, completed: 3 },
} as Message)

const toolCallsAssistantMessage = (): Message => ({
  id: ASSISTANT_MESSAGE_ID,
  sessionID: SESSION_ID,
  role: "assistant",
  providerID: "cursor-acp",
  finish: "tool-calls",
  time: { created: 2, completed: 3 },
} as unknown as Message)

const implementingUserMessage = (): Message => ({
  id: IMPLEMENT_USER_MESSAGE_ID,
  sessionID: SESSION_ID,
  role: "user",
  time: { created: 4 },
} as Message)

const implementingAssistantMessage = (completed = 6): Message => ({
  id: IMPLEMENT_ASSISTANT_MESSAGE_ID,
  sessionID: SESSION_ID,
  role: "assistant",
  providerID: "cursor-acp",
  time: { created: 5, completed },
} as Message)

const textPart = (text: string): Part => ({
  id: PART_ID,
  sessionID: SESSION_ID,
  messageID: ASSISTANT_MESSAGE_ID,
  type: "text",
  text,
} as Part)

const implementTextPart = (text: string): Part => ({
  id: IMPLEMENT_PART_ID,
  sessionID: SESSION_ID,
  messageID: IMPLEMENT_ASSISTANT_MESSAGE_ID,
  type: "text",
  text,
} as Part)

const toolPart = (
  messageID: string,
  status: "pending" | "running" | "completed",
  id = `${messageID}_tool`,
): Part => ({
  id,
  sessionID: SESSION_ID,
  messageID,
  type: "tool",
  tool: "apply_patch",
  state: { status },
} as Part)

const planModePart = (): Part => ({
  id: `${USER_MESSAGE_ID}_part`,
  sessionID: SESSION_ID,
  messageID: USER_MESSAGE_ID,
  type: "text",
  text: "User has requested to enter plan mode.",
  synthetic: true,
} as Part)

const deltaEvent = (delta: string): Event => ({
  type: "message.part.delta",
  properties: {
    messageID: ASSISTANT_MESSAGE_ID,
    partID: PART_ID,
    field: "text",
    delta,
  },
} as Event)

const partUpdatedEvent = (part: Part): Event => ({
  type: "message.part.updated",
  properties: { part },
} as Event)

const messageUpdatedEvent = (info: Message): Event => ({
  type: "message.updated",
  properties: { info },
} as Event)

const sessionStatusEvent = (status: SessionStatus): Event => ({
  type: "session.status",
  properties: { sessionID: SESSION_ID, status },
} as Event)

const routingIndexFor = (messageIds: string[] = [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID]) => ({
  sessionDirectoryById: new Map([[SESSION_ID, DIRECTORY]]),
  messageSessionById: new Map(messageIds.map((messageId) => [messageId, SESSION_ID])),
  sessionMessageIdsById: new Map([[SESSION_ID, new Set(messageIds)]]),
})

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const SESSION_COMPLETION_INDICATOR_SETTLE_MS = 250

const waitForCompletionIndicatorSettlement = async () => {
  await new Promise((resolve) => setTimeout(resolve, SESSION_COMPLETION_INDICATOR_SETTLE_MS + 20))
}

const contextUsage = (activeInputTokens: number): SessionContextUsage => ({
  activeInputTokens,
  lastOutputTokens: 0,
  source: "message-fallback",
  updatedAt: 1,
  percentage: activeInputTokens / 100,
  capacityLimit: 10_000,
  capacityBasis: "context",
  inputLimit: null,
  contextLimit: 10_000,
  outputLimit: null,
  tokenBreakdown: {
    input: activeInputTokens,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: activeInputTokens,
  },
  hasTokenBreakdown: true,
})

describe("sync plan lifecycle on message.part.delta", () => {
  beforeEach(() => {
    registerRuntimeAPIs(null)
    resetGlobalSessionLifecycleOverlayForTest()
    resetDirectorySessionLifecycleOverlaysForTest()
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      hasLoaded: true,
      status: "ready",
    })
    clearSessionAutoAcceptCalls.length = 0
    resetAbortGuardState()
    useSessionUIStore.setState({
      currentSessionId: null,
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
      worktreeMetadata: new Map(),
      sessionDirectoryHints: new Map(),
      webUICreatedSessions: new Set(),
      sessionPlanIndicator: new Map(),
      sessionPlanAvailable: new Map(),
      sessionCompletionIndicator: new Map(),
      sessionAbortFlags: new Map(),
      abortControllers: new Map(),
      implementedPlanRequests: new Set(),
      planModeUserMessages: new Set(),
      planModeUserMessagesBySession: new Map(),
      starterAssistantMessages: new Map(),
      pendingChangesBarDismissed: new Map(),
    })
    useSessionWorktreeStore.setState({ attachments: new Map() })
    useSessionPlanFileStore.setState({ recordsBySession: {} })
    useSessionChangeAttributionStore.setState({ entries: new Map() })
    useStreamingStore.setState({ streamingMessageIds: new Map(), messageStreamStates: new Map() })
    setActiveSession("", "")
    setExternallyViewedSession(DIRECTORY, SESSION_ID, false)
    useNotificationStore.setState({
      list: [],
      index: {
        session: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
        project: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
      },
    })
    useMessageQueueStore.getState().clearAllQueues()
    useContextStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      sessionAgentModelVariantSelections: new Map(),
      currentAgentContext: new Map(),
      sessionContextUsage: new Map(),
      sessionAgentEditModes: new Map(),
    })
  })

  test("projects completed file tools into the session attribution store", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Edits", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [assistantMessage()],
      },
    })
    const completedEdit = {
      id: "prt_edit",
      sessionID: SESSION_ID,
      messageID: ASSISTANT_MESSAGE_ID,
      callID: "call_edit",
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        input: { path: `${DIRECTORY}/src/app.ts` },
      },
    } as unknown as Part

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(completedEdit),
      childStores,
      routingIndexFor(),
    )

    expect(useSessionChangeAttributionStore.getState().entries.get(
      getSessionChangeAttributionKey(DIRECTORY, SESSION_ID),
    )).toEqual({
      paths: ["src/app.ts"],
      hasUnattributedMutations: false,
    })
  })

  test("projects a remote implementation marker into the exact plan card state", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const implementationMarker = {
      id: "prt_implementation_marker",
      sessionID: SESSION_ID,
      messageID: IMPLEMENT_USER_MESSAGE_ID,
      type: "text",
      text: buildPlanImplementationRequestMarker({
        sourceSessionId: SESSION_ID,
        sourceMessageId: ASSISTANT_MESSAGE_ID,
        planIndex: 0,
      }),
      synthetic: true,
    } as Part
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Cross-client plan", time: { created: 1, updated: 4 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage(), implementingUserMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
      },
    })

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(implementationMarker),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID]),
    )
    await flushAsync()

    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`
    expect(useSessionUIStore.getState().implementedPlanRequests.has(implementationKey)).toBe(true)
    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "implementing",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(implementationMarker),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID]),
    )
    await flushAsync()
    expect(useSessionUIStore.getState().implementedPlanRequests.size).toBe(1)
  })

  test("reconciles the implementation when its marker part arrives before the user message", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const implementationMarker = {
      id: "prt_implementation_marker_early",
      sessionID: SESSION_ID,
      messageID: IMPLEMENT_USER_MESSAGE_ID,
      type: "text",
      text: buildPlanImplementationRequestMarker({
        sourceSessionId: SESSION_ID,
        sourceMessageId: ASSISTANT_MESSAGE_ID,
        planIndex: 0,
      }),
      synthetic: true,
    } as Part
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Cross-client race", time: { created: 1, updated: 4 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
      },
    })
    const routingIndex = routingIndexFor([
      USER_MESSAGE_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    ])

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(implementationMarker), childStores, routingIndex)
    await flushAsync()
    expect(useSessionUIStore.getState().implementedPlanRequests.size).toBe(0)

    applySyncEventForTest(
      DIRECTORY,
      messageUpdatedEvent(implementingUserMessage()),
      childStores,
      routingIndex,
    )
    await flushAsync()

    expect(useSessionUIStore.getState().implementedPlanRequests.has(
      `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`,
    )).toBe(true)
  })

  test("drops a stale session update before allocating replacement store branches", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const current = {
      id: SESSION_ID,
      title: "Newest title",
      time: { created: 1, updated: 10 },
    } as Session
    store.setState({ session: [current], sessionTotal: 1 })
    const before = store.getState()

    applySyncEventForTest(DIRECTORY, {
      type: "session.updated",
      properties: {
        info: {
          ...current,
          title: "Stale title",
          time: { created: 1, updated: 9 },
        },
      },
    } as Event, childStores, routingIndexFor(), DIRECTORY)

    expect(store.getState()).toBe(before)
    expect(store.getState().session[0]).toBe(current)
    expect(store.getState().permission).toBe(before.permission)
    expect(store.getState().todo).toBe(before.todo)
    expect(store.getState().part).toBe(before.part)
  })

  test("keeps an unguarded provider retry authoritative at the sync event boundary", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Missing model", time: { created: 1, updated: 2 } } as Session],
      session_status: {},
    })

    const retryStatus = {
      type: "retry",
      attempt: 1,
      message: "Model not found gpt-5.6-luna",
      next: Date.now() + 1_000,
    } as SessionStatus

    applySyncEventForTest(DIRECTORY, sessionStatusEvent(retryStatus), childStores, routingIndexFor([]))

    expect(isAbortGuardActive(SESSION_ID)).toBe(false)
    expect(store.getState().session_status[SESSION_ID]).toEqual(retryStatus)
  })

  test("routes Cursor execution-worktree events through the session's logical directory mapping", () => {
    const executionDirectory = "/repo/.cursor/worktrees/run-1"
    const childStores = new ChildStoreManager()
    const logicalStore = childStores.ensureChild(DIRECTORY)
    const executionStore = childStores.ensureChild(executionDirectory)
    const session = { id: SESSION_ID, title: "Mapped task", time: { created: 1, updated: 2 } } as Session

    logicalStore.setState({
      ...INITIAL_STATE,
      session: [session],
      session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
    })
    executionStore.setState({
      ...INITIAL_STATE,
      session: [session],
      session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
    })

    applySyncEventForTest(
      executionDirectory,
      sessionStatusEvent({ type: "busy" } as SessionStatus),
      childStores,
      routingIndexFor([]),
    )

    expect(logicalStore.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
    expect(executionStore.getState().session_status[SESSION_ID]).toEqual({ type: "idle" })
  })

  test("canonical session idle retires stale streaming ownership without opening the chat", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const incompleteAssistant = {
      id: ASSISTANT_MESSAGE_ID,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: 2 },
    } as Message
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Background task", time: { created: 1, updated: 2 } } as Session],
      session_status: { [SESSION_ID]: { type: "busy" } as SessionStatus },
      message: { [SESSION_ID]: [userMessage(), incompleteAssistant] },
      part: { [ASSISTANT_MESSAGE_ID]: [textPart("Finishing in the background")] },
    })
    useStreamingStore.setState({
      streamingMessageIds: new Map([[SESSION_ID, ASSISTANT_MESSAGE_ID]]),
      messageStreamStates: new Map([[
        ASSISTANT_MESSAGE_ID,
        { phase: "streaming", startedAt: 1, lastUpdateAt: 2 },
      ]]),
    })

    applySyncEventForTest(DIRECTORY, {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "idle" } },
    } as Event, childStores, routingIndexFor())

    expect(useStreamingStore.getState().streamingMessageIds.get(SESSION_ID)).toBeNull()

    applySyncEventForTest(DIRECTORY, {
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    } as Event, childStores, routingIndexFor())

    expect(useStreamingStore.getState().streamingMessageIds.get(SESSION_ID)).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get(ASSISTANT_MESSAGE_ID)?.phase).toBe("completed")
  })

  test("settles stale terminal attention for a resumed root and its loaded descendants", async () => {
    const childSessionID = "ses_child_failed"
    const unrelatedSessionID = "ses_unrelated_failed"
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [
        { id: SESSION_ID, title: "Root", time: { created: 1, updated: 2 } } as Session,
        {
          id: childSessionID,
          parentID: SESSION_ID,
          title: "Failed child",
          time: { created: 1, updated: 2 },
        } as Session,
        { id: unrelatedSessionID, title: "Unrelated", time: { created: 1, updated: 2 } } as Session,
      ],
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
        [childSessionID]: { type: "idle" } as SessionStatus,
        [unrelatedSessionID]: { type: "idle" } as SessionStatus,
      },
    })
    useNotificationStore.getState().append({
      type: "error",
      directory: DIRECTORY,
      session: SESSION_ID,
      time: Date.now(),
      viewed: false,
    })
    useNotificationStore.getState().append({
      type: "error",
      directory: DIRECTORY,
      session: childSessionID,
      time: Date.now() + 1,
      viewed: false,
    })
    useNotificationStore.getState().append({
      type: "error",
      directory: DIRECTORY,
      session: unrelatedSessionID,
      time: Date.now() + 2,
      viewed: false,
    })
    useSessionUIStore.setState({
      sessionCompletionIndicator: new Map([
        [SESSION_ID, { messageId: "msg_root_complete", completedAt: 1 }],
        [childSessionID, { messageId: "msg_child_complete", completedAt: 2 }],
        [unrelatedSessionID, { messageId: "msg_unrelated_complete", completedAt: 3 }],
      ]),
    })

    applySyncEventForTest(
      DIRECTORY,
      sessionStatusEvent({ type: "busy" } as SessionStatus),
      childStores,
      routingIndexFor([]),
    )
    await flushAsync()

    const notifications = useNotificationStore.getState()
    expect(notifications.sessionHasError(SESSION_ID)).toBe(false)
    expect(notifications.sessionHasError(childSessionID)).toBe(false)
    expect(notifications.sessionHasError(unrelatedSessionID)).toBe(true)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(childSessionID)).toBe(false)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(unrelatedSessionID)).toBe(true)
  })

  test("does not resurrect a deleted session from late blocking-request materialization", async () => {
    const deletedSessionID = "ses_late_permission_materialization"
    const deletedSession = {
      id: deletedSessionID,
      parentID: "ses_parent",
      title: "Delete while materializing",
      time: { created: 1, updated: 2 },
    } as Session
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({ ...INITIAL_STATE })

    let markSessionGetStarted!: () => void
    let resolveSessionGet!: (value: { data: Session }) => void
    const sessionGetStarted = new Promise<void>((resolve) => {
      markSessionGetStarted = resolve
    })
    const sessionGetResult = new Promise<{ data: Session }>((resolve) => {
      resolveSessionGet = resolve
    })
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          get: () => {
            markSessionGetStarted()
            return sessionGetResult
          },
        },
      }),
    })

    try {
      const routingIndex = {
        sessionDirectoryById: new Map<string, string>(),
        messageSessionById: new Map<string, string>(),
        sessionMessageIdsById: new Map<string, Set<string>>(),
      }
      applySyncEventForTest(DIRECTORY, {
        type: "permission.asked",
        properties: { id: "perm_late", sessionID: deletedSessionID },
      } as Event, childStores, routingIndex)
      await sessionGetStarted

      applySyncEventForTest(DIRECTORY, {
        type: "session.deleted",
        properties: { sessionID: deletedSessionID, info: deletedSession },
      } as Event, childStores, routingIndex)
      resolveSessionGet({ data: deletedSession })
      await flushAsync()
      await flushAsync()

      expect(store.getState().session.some((session) => session.id === deletedSessionID)).toBe(false)
      expect(store.getState().permission[deletedSessionID]).toBe(undefined)
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("does not restore deleted messages from late snapshot materialization", async () => {
    const deletedSessionID = "ses_late_message_materialization"
    const deletedMessageID = "msg_late_message_materialization"
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete while loading messages",
      time: { created: 1, updated: 2 },
    } as Session
    const deletedMessage = {
      id: deletedMessageID,
      sessionID: deletedSessionID,
      role: "assistant",
      time: { created: 2, completed: 3 },
    } as Message
    const deletedPart = {
      id: "prt_late_message_materialization",
      sessionID: deletedSessionID,
      messageID: deletedMessageID,
      type: "text",
      text: "A stale snapshot must not return.",
    } as Part
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
      sessionTotal: 1,
    })

    let markMessagesStarted!: () => void
    let resolveMessages!: (value: { data: Array<{ info: Message; parts: Part[] }> }) => void
    const messagesStarted = new Promise<void>((resolve) => {
      markMessagesStarted = resolve
    })
    const messagesResult = new Promise<{ data: Array<{ info: Message; parts: Part[] }> }>((resolve) => {
      resolveMessages = resolve
    })
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => {
            markMessagesStarted()
            return messagesResult
          },
        },
      }),
    })

    try {
      const routingIndex = {
        sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
        messageSessionById: new Map<string, string>(),
        sessionMessageIdsById: new Map<string, Set<string>>(),
      }
      applySyncEventForTest(DIRECTORY, {
        type: "message.updated",
        properties: { sessionID: deletedSessionID, info: deletedMessage },
      } as Event, childStores, routingIndex)
      await messagesStarted

      applySyncEventForTest(DIRECTORY, {
        type: "session.deleted",
        properties: { sessionID: deletedSessionID, info: deletedSession },
      } as Event, childStores, routingIndex)
      resolveMessages({ data: [{ info: deletedMessage, parts: [deletedPart] }] })
      await flushAsync()
      await flushAsync()

      expect(store.getState().message[deletedSessionID]).toBe(undefined)
      expect(store.getState().part[deletedMessageID]).toBe(undefined)
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("does not restore deleted messages from late unexpected-abort reconciliation", async () => {
    const deletedSessionID = "ses_late_unexpected_abort_reconciliation"
    const deletedMessageID = "msg_late_unexpected_abort_reconciliation"
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete while reconciling an unexpected abort",
      time: { created: 1, updated: 2 },
    } as Session
    const deletedMessage = {
      id: deletedMessageID,
      sessionID: deletedSessionID,
      role: "assistant",
      time: { created: 2, completed: 3 },
    } as Message
    const deletedPart = {
      id: "prt_late_unexpected_abort_reconciliation",
      sessionID: deletedSessionID,
      messageID: deletedMessageID,
      type: "text",
      text: "A stale abort reconciliation must not return.",
    } as Part
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
      sessionTotal: 1,
    })

    let markMessagesStarted!: () => void
    let resolveMessages!: (value: { data: Array<{ info: Message; parts: Part[] }> }) => void
    const messagesStarted = new Promise<void>((resolve) => {
      markMessagesStarted = resolve
    })
    const messagesResult = new Promise<{ data: Array<{ info: Message; parts: Part[] }> }>((resolve) => {
      resolveMessages = resolve
    })
    const fakeSdk = {
      session: {
        messages: () => {
          markMessagesStarted()
          return messagesResult
        },
      },
    }
    sessionActions.setActionRefs(
      fakeSdk as unknown as Parameters<typeof sessionActions.setActionRefs>[0],
      childStores,
      () => DIRECTORY,
    )

    try {
      const reconciliation = sessionActions.reconcileUnexpectedAbort(deletedSessionID, DIRECTORY)
      await messagesStarted

      applySyncEventForTest(DIRECTORY, {
        type: "session.deleted",
        properties: { sessionID: deletedSessionID, info: deletedSession },
      } as Event, childStores, routingIndexFor([]))
      resolveMessages({ data: [{ info: deletedMessage, parts: [deletedPart] }] })
      await reconciliation

      expect(store.getState().message[deletedSessionID]).toBe(undefined)
      expect(store.getState().part[deletedMessageID]).toBe(undefined)
    } finally {
      sessionActions.clearActionRefs(childStores)
    }
  })

  test("cancels late plan lifecycle restoration for a deleted session", async () => {
    const deletedSessionID = "ses_late_plan_restoration"
    const deletedUserMessageID = "msg_late_plan_user"
    const deletedAssistantMessageID = "msg_late_plan_assistant"
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete while restoring a plan",
      time: { created: 1, updated: 2 },
    } as Session
    const deletedUserMessage = {
      id: deletedUserMessageID,
      sessionID: deletedSessionID,
      role: "user",
      time: { created: 2 },
    } as Message
    const deletedAssistantMessage = {
      id: deletedAssistantMessageID,
      sessionID: deletedSessionID,
      parentID: deletedUserMessageID,
      role: "assistant",
      providerID: "cursor-acp",
      time: { created: 3, completed: 4 },
    } as Message
    const deletedUserPart = {
      id: "prt_late_plan_user",
      sessionID: deletedSessionID,
      messageID: deletedUserMessageID,
      type: "text",
      text: "User has requested to enter plan mode.",
      synthetic: true,
    } as Part
    const deletedAssistantPart = {
      id: "prt_late_plan_assistant",
      sessionID: deletedSessionID,
      messageID: deletedAssistantMessageID,
      type: "text",
      text: `<!--plan-->\n${structuredPlanBody}`,
    } as Part
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
      sessionTotal: 1,
    })
    useSessionUIStore.setState({
      planModeUserMessages: new Set([deletedUserMessageID]),
      planModeUserMessagesBySession: new Map([[deletedSessionID, deletedUserMessageID]]),
    })

    let markMessagesStarted!: () => void
    let resolveMessages!: (value: { data: Array<{ info: Message; parts: Part[] }> }) => void
    const messagesStarted = new Promise<void>((resolve) => {
      markMessagesStarted = resolve
    })
    const messagesResult = new Promise<{ data: Array<{ info: Message; parts: Part[] }> }>((resolve) => {
      resolveMessages = resolve
    })
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => {
            markMessagesStarted()
            return messagesResult
          },
        },
      }),
    })

    try {
      const restoration = restorePersistedSessionIndicatorsForDirectory(DIRECTORY, store)
      await messagesStarted

      applySyncEventForTest(DIRECTORY, {
        type: "session.deleted",
        properties: { sessionID: deletedSessionID, info: deletedSession },
      } as Event, childStores, {
        sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
        messageSessionById: new Map<string, string>(),
        sessionMessageIdsById: new Map<string, Set<string>>(),
      })
      resolveMessages({
        data: [
          { info: deletedUserMessage, parts: [deletedUserPart] },
          { info: deletedAssistantMessage, parts: [deletedAssistantPart] },
        ],
      })
      await restoration
      await flushAsync()

      expect(store.getState().message[deletedSessionID]).toBe(undefined)
      expect(store.getState().part[deletedAssistantMessageID]).toBe(undefined)
      expect(useSessionUIStore.getState().sessionPlanIndicator.get(deletedSessionID)).toBe(undefined)
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("retires an exact abort-retry guard only on permanent deletion", () => {
    const deletedSessionID = "ses_deleted_abort_guard"
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete guarded retry",
      time: { created: 1, updated: 2 },
    } as Session
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
      sessionTotal: 1,
    })
    const routingIndex = {
      sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }

    registerManualAbortGuard(deletedSessionID, DIRECTORY, { type: "retry", attempt: 1, message: "wait", next: 1_000 })
    applySyncEventForTest(DIRECTORY, {
      type: "session.updated",
      properties: {
        sessionID: deletedSessionID,
        info: { ...deletedSession, time: { ...deletedSession.time, archived: 3 } },
      },
    } as Event, childStores, routingIndex)
    expect(isAbortGuardActive(deletedSessionID)).toBe(true)

    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, info: deletedSession },
    } as Event, childStores, routingIndex)
    expect(isAbortGuardActive(deletedSessionID)).toBe(false)
  })

  test("clears per-session selections when an authoritative delete event lands", () => {
    const deletedSessionID = "ses_selection_delete"
    const retainedSessionID = "ses_selection_keep"
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete me",
      time: { created: 1, updated: 2 },
    } as Session
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
    })

    const selections = useSelectionStore.getState()
    selections.saveSessionModelSelection(deletedSessionID, "openai", "gpt-5.5")
    selections.saveSessionAgentSelection(deletedSessionID, "builder")
    selections.setSessionPlanMode(deletedSessionID, true)
    selections.saveAgentModelForSession(deletedSessionID, "builder", "openai", "gpt-5.5")
    selections.saveAgentModelVariantForSession(deletedSessionID, "builder", "openai", "gpt-5.5", "high")
    selections.saveSessionModelSelection(retainedSessionID, "anthropic", "claude")

    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, info: deletedSession },
    } as Event, childStores, {
      sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })

    const next = useSelectionStore.getState()
    expect(store.getState().session).toEqual([])
    expect(next.getSessionModelSelection(deletedSessionID)).toBe(null)
    expect(next.getSessionAgentSelection(deletedSessionID)).toBe(null)
    expect(next.getSessionPlanMode(deletedSessionID)).toBe(false)
    expect(next.getAgentModelForSession(deletedSessionID, "builder")).toBe(null)
    expect(next.getAgentModelVariantForSession(deletedSessionID, "builder", "openai", "gpt-5.5")).toBe(undefined)
    expect(next.getSessionModelSelection(retainedSessionID)).toEqual({ providerId: "anthropic", modelId: "claude" })
  })

  test("clears only the deleted session from persisted context state", () => {
    const deletedSessionID = "ses_context_delete"
    const retainedSessionID = "ses_context_keep"
    const globalEditModeID = "__global__"
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete persisted context",
      time: { created: 1, updated: 2 },
    } as Session
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
    })

    useContextStore.setState({
      sessionModelSelections: new Map([
        [deletedSessionID, { providerId: "openai", modelId: "gpt-5.5" }],
        [retainedSessionID, { providerId: "anthropic", modelId: "claude" }],
      ]),
      sessionAgentSelections: new Map([
        [deletedSessionID, "builder"],
        [retainedSessionID, "planner"],
      ]),
      sessionAgentModelSelections: new Map([
        [deletedSessionID, new Map([["builder", { providerId: "openai", modelId: "gpt-5.5" }]])],
        [retainedSessionID, new Map([["planner", { providerId: "anthropic", modelId: "claude" }]])],
      ]),
      sessionAgentModelVariantSelections: new Map([
        [deletedSessionID, new Map([["builder", new Map([["openai/gpt-5.5", "high"]])]])],
        [retainedSessionID, new Map([["planner", new Map([["anthropic/claude", "fast"]])]])],
      ]),
      currentAgentContext: new Map([
        [deletedSessionID, "builder"],
        [retainedSessionID, "planner"],
      ]),
      sessionContextUsage: new Map([
        [deletedSessionID, contextUsage(100)],
        [retainedSessionID, contextUsage(200)],
      ]),
      sessionAgentEditModes: new Map<string, Map<string, EditPermissionMode>>([
        [deletedSessionID, new Map([["builder", "full"]])],
        [retainedSessionID, new Map([["planner", "allow"]])],
        [globalEditModeID, new Map([["builder", "ask"]])],
      ]),
    })

    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, info: deletedSession },
    } as Event, childStores, {
      sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })

    const next = useContextStore.getState()
    const sessionMaps = [
      next.sessionModelSelections,
      next.sessionAgentSelections,
      next.sessionAgentModelSelections,
      next.sessionAgentModelVariantSelections,
      next.currentAgentContext,
      next.sessionContextUsage,
      next.sessionAgentEditModes,
    ]

    expect(store.getState().session).toEqual([])
    for (const sessionMap of sessionMaps) {
      expect(sessionMap.has(deletedSessionID)).toBe(false)
      expect(sessionMap.has(retainedSessionID)).toBe(true)
    }
    expect(next.sessionAgentEditModes.get(globalEditModeID)?.get("builder")).toBe("ask")
    const persistedContext = getSafeStorage().getItem("context-store")
    expect(persistedContext).not.toContain(deletedSessionID)
    expect(persistedContext).toContain(retainedSessionID)
    expect(persistedContext).toContain(globalEditModeID)
  })

  test("retires permission auto-accept only after authoritative deletion", () => {
    const deletedSessionID = "ses_permission_delete"
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete permission policy",
      time: { created: 1, updated: 2 },
    } as Session
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
    })

    applySyncEventForTest(DIRECTORY, {
      type: "session.updated",
      properties: {
        info: { ...deletedSession, time: { ...deletedSession.time, archived: Date.now() } },
      },
    } as Event, childStores, {
      sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })
    expect(clearSessionAutoAcceptCalls).toEqual([])

    store.setState({ session: [deletedSession] })
    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, info: deletedSession },
    } as Event, childStores, {
      sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })

    expect(clearSessionAutoAcceptCalls).toEqual([deletedSessionID])
  })

  test("clears only the deleted session's persisted queued prompts", () => {
    const deletedSessionID = "ses_queue_delete"
    const retainedSessionID = "ses_queue_keep"
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete queued prompt",
      time: { created: 1, updated: 2 },
    } as Session
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
    })

    const queue = useMessageQueueStore.getState()
    queue.addToQueue(deletedSessionID, {
      directory: DIRECTORY,
      content: "Unreachable prompt after deletion",
      sendConfig: { providerID: "openai", modelID: "gpt-5.5", agent: "builder" },
    })
    queue.addToQueue(retainedSessionID, {
      directory: "/other/repo",
      content: "Keep this queued prompt",
    })

    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, info: deletedSession },
    } as Event, childStores, {
      sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })

    const nextQueue = useMessageQueueStore.getState()
    expect(store.getState().session).toEqual([])
    expect(nextQueue.getQueueForSession(deletedSessionID)).toEqual([])
    expect(nextQueue.getQueueForSession(retainedSessionID).map((message) => message.content)).toEqual([
      "Keep this queued prompt",
    ])
  })

  test("removes only the deleted session's persisted composer text and mentions", () => {
    const deletedSessionID = "ses_composer_delete"
    const retainedSessionID = "ses_composer_keep"
    const deletedDraftKey = `openchamber_chat_input_draft_${deletedSessionID}`
    const deletedMentionsKey = `openchamber_chat_confirmed_mentions_${deletedSessionID}`
    const retainedDraftKey = `openchamber_chat_input_draft_${retainedSessionID}`
    const storage = getSafeStorage()
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete composer",
      time: { created: 1, updated: 2 },
    } as Session
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
    })
    storage.setItem(deletedDraftKey, "Unsent private text")
    storage.setItem(deletedMentionsKey, JSON.stringify(["README.md"]))
    storage.setItem(retainedDraftKey, "Keep unrelated text")

    try {
      applySyncEventForTest(DIRECTORY, {
        type: "session.deleted",
        properties: { sessionID: deletedSessionID, info: deletedSession },
      } as Event, childStores, {
        sessionDirectoryById: new Map([[deletedSessionID, DIRECTORY]]),
        messageSessionById: new Map(),
        sessionMessageIdsById: new Map(),
      })

      expect(store.getState().session).toEqual([])
      expect(storage.getItem(deletedDraftKey)).toBeNull()
      expect(storage.getItem(deletedMentionsKey)).toBeNull()
      expect(storage.getItem(retainedDraftKey)).toBe("Keep unrelated text")
    } finally {
      storage.removeItem(deletedDraftKey)
      storage.removeItem(deletedMentionsKey)
      storage.removeItem(retainedDraftKey)
    }
  })

  test("clears only the currently selected session when authoritative deletion arrives", () => {
    const deletedSessionID = "ses_current_delete"
    const retainedSessionID = "ses_current_keep"
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete selected session",
      time: { created: 1, updated: 2 },
    } as Session
    const retainedSession = {
      id: retainedSessionID,
      title: "Keep selected session",
      time: { created: 1, updated: 2 },
    } as Session
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession, retainedSession],
    })

    useSessionUIStore.setState({ currentSessionId: deletedSessionID })
    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, info: deletedSession },
    } as Event, childStores, {
      sessionDirectoryById: new Map([
        [deletedSessionID, DIRECTORY],
        [retainedSessionID, DIRECTORY],
      ]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })

    expect(useSessionUIStore.getState().currentSessionId).toBeNull()

    useSessionUIStore.setState({ currentSessionId: retainedSessionID })
    store.setState({ session: [deletedSession, retainedSession] })
    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, info: deletedSession },
    } as Event, childStores, {
      sessionDirectoryById: new Map([
        [deletedSessionID, DIRECTORY],
        [retainedSessionID, DIRECTORY],
      ]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })

    expect(useSessionUIStore.getState().currentSessionId).toBe(retainedSessionID)
  })

  test("retires exact session UI ownership when authoritative deletion arrives", () => {
    const deletedSessionID = "ses_ui_delete"
    const retainedSessionID = "ses_ui_keep"
    const deletedSession = {
      id: deletedSessionID,
      title: "Delete UI ownership",
      time: { created: 1, updated: 2 },
    } as Session
    const retainedSession = {
      id: retainedSessionID,
      title: "Keep UI ownership",
      time: { created: 1, updated: 2 },
    } as Session
    const deletedController = new AbortController()
    const retainedController = new AbortController()
    const childStores = new ChildStoreManager()
    childStores.ensureChild(DIRECTORY).setState({
      ...INITIAL_STATE,
      session: [deletedSession, retainedSession],
    })
    useSessionUIStore.setState({
      sessionDirectoryHints: new Map([
        [deletedSessionID, "/repo/deleted"],
        [retainedSessionID, "/repo/retained"],
      ]),
      webUICreatedSessions: new Set([deletedSessionID, retainedSessionID]),
      abortControllers: new Map([
        [deletedSessionID, deletedController],
        [retainedSessionID, retainedController],
      ]),
      sessionPlanIndicator: new Map([
        [deletedSessionID, { state: "proposed", sourceMessageId: "msg-delete-plan" }],
        [retainedSessionID, { state: "proposed", sourceMessageId: "msg-keep-plan" }],
      ]),
      planModeUserMessages: new Set(["msg-delete-user", "msg-keep-user"]),
      planModeUserMessagesBySession: new Map([
        [deletedSessionID, "msg-delete-user"],
        [retainedSessionID, "msg-keep-user"],
      ]),
    })

    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, info: deletedSession },
    } as Event, childStores, {
      sessionDirectoryById: new Map([
        [deletedSessionID, DIRECTORY],
        [retainedSessionID, DIRECTORY],
      ]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })

    const state = useSessionUIStore.getState()
    expect(deletedController.signal.aborted).toBe(true)
    expect(retainedController.signal.aborted).toBe(false)
    expect(state.sessionDirectoryHints).toEqual(new Map([[retainedSessionID, "/repo/retained"]]))
    expect(state.webUICreatedSessions).toEqual(new Set([retainedSessionID]))
    expect(state.abortControllers.has(deletedSessionID)).toBe(false)
    expect(state.sessionPlanIndicator.has(deletedSessionID)).toBe(false)
    expect(state.sessionPlanIndicator.get(retainedSessionID)).toEqual({
      state: "proposed",
      sourceMessageId: "msg-keep-plan",
    })
    expect(state.planModeUserMessages).toEqual(new Set(["msg-keep-user"]))
    expect(state.planModeUserMessagesBySession).toEqual(new Map([[retainedSessionID, "msg-keep-user"]]))
  })

  test("preserves session UI ownership when a session is archived", () => {
    const archivedSessionID = "ses_ui_archive"
    const archivedSession = {
      id: archivedSessionID,
      title: "Archive UI ownership",
      time: { created: 1, updated: 2, archived: 3 },
    } as Session
    const controller = new AbortController()
    const childStores = new ChildStoreManager()
    childStores.ensureChild(DIRECTORY).setState({
      ...INITIAL_STATE,
      session: [{ ...archivedSession, time: { created: 1, updated: 2 } } as Session],
    })
    useSessionUIStore.setState({
      sessionDirectoryHints: new Map([[archivedSessionID, "/repo/archive"]]),
      webUICreatedSessions: new Set([archivedSessionID]),
      abortControllers: new Map([[archivedSessionID, controller]]),
      planModeUserMessages: new Set(["msg-archive-user"]),
      planModeUserMessagesBySession: new Map([[archivedSessionID, "msg-archive-user"]]),
    })

    applySyncEventForTest(DIRECTORY, {
      type: "session.updated",
      properties: { sessionID: archivedSessionID, info: archivedSession },
    } as Event, childStores, {
      sessionDirectoryById: new Map([[archivedSessionID, DIRECTORY]]),
      messageSessionById: new Map(),
      sessionMessageIdsById: new Map(),
    })

    const state = useSessionUIStore.getState()
    expect(controller.signal.aborted).toBe(false)
    expect(state.sessionDirectoryHints.get(archivedSessionID)).toBe("/repo/archive")
    expect(state.webUICreatedSessions.has(archivedSessionID)).toBe(true)
    expect(state.abortControllers.get(archivedSessionID)).toBe(controller)
    expect(state.planModeUserMessages.has("msg-archive-user")).toBe(true)
    expect(state.planModeUserMessagesBySession.get(archivedSessionID)).toBe("msg-archive-user")
  })

  test("marks sessionPlanIndicator proposed when structured plan text arrives via delta on an idle session", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const session = {
      id: SESSION_ID,
      title: "Plan session",
      time: { created: 1, updated: 2 },
    } as Session

    store.setState({
      ...INITIAL_STATE,
      session: [session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart("")],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)

    const routingIndex = routingIndexFor()

    applySyncEventForTest(DIRECTORY, deltaEvent(structuredPlanBody), childStores, routingIndex)
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
  })

  test("saves a completed background plan before its PlanCard mounts", async () => {
    const originalProjects = useProjectsStore.getState().projects
    let writes = 0
    registerRuntimeAPIs({
      sessionPlans: {
        ensureRevision: async () => {
          writes += 1
          return { path: '/plans/plan.md', created: true }
        },
      },
    } as unknown as RuntimeAPIs)
    useProjectsStore.setState({
      projects: [{ id: 'repo', path: DIRECTORY, label: 'Repo' }],
    })

    try {
      const childStores = new ChildStoreManager()
      const store = childStores.ensureChild(DIRECTORY)
      store.setState({
        ...INITIAL_STATE,
        session: [{
          id: SESSION_ID,
          title: "Plan session",
          slug: "plan-session",
          directory: DIRECTORY,
          time: { created: 1, updated: 2 },
        } as Session],
        message: {
          [SESSION_ID]: [userMessage(), assistantMessage()],
        },
        part: {
          [USER_MESSAGE_ID]: [planModePart()],
          [ASSISTANT_MESSAGE_ID]: [textPart("")],
        },
        session_status: {
          [SESSION_ID]: { type: "idle" } as SessionStatus,
        },
      })
      useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)

      applySyncEventForTest(DIRECTORY, deltaEvent(structuredPlanBody), childStores, routingIndexFor())
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (useSessionPlanFileStore.getState().recordsBySession[SESSION_ID]?.status === 'saved') break
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      const record = useSessionPlanFileStore.getState().recordsBySession[SESSION_ID]
      expect(record?.sourceMessageId).toBe(ASSISTANT_MESSAGE_ID)
      expect(record?.status).toBe('saved')
      expect(writes).toBe(1)
    } finally {
      registerRuntimeAPIs(null)
      useProjectsStore.setState({ projects: originalProjects })
    }
  })

  test("restores a persisted proposed plan indicator from authoritative materialized messages", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 3 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(structuredPlanBody)],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.setState({
      planModeUserMessages: new Set([USER_MESSAGE_ID]),
      planModeUserMessagesBySession: new Map([[SESSION_ID, USER_MESSAGE_ID]]),
    })

    await restorePersistedSessionIndicatorsForDirectory(DIRECTORY, store)

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
  })

  test("force-refreshes and retires a stale persisted proposal during directory bootstrap", async () => {
    const bootstrapDirectory = `${DIRECTORY}/stale-persisted-proposal`
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(bootstrapDirectory)
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Stale plan", time: { created: 1, updated: 3 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart("A cached answer that is already renderable.")],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.setState({
      planModeUserMessages: new Set([USER_MESSAGE_ID]),
      planModeUserMessagesBySession: new Map([[SESSION_ID, USER_MESSAGE_ID]]),
      sessionPlanIndicator: new Map([[
        SESSION_ID,
        { state: "proposed", sourceMessageId: ASSISTANT_MESSAGE_ID },
      ]]),
    })

    let messageFetches = 0
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => {
            messageFetches += 1
            return Promise.resolve({
              data: [
                { info: userMessage(), parts: [planModePart()] },
                { info: assistantMessage(), parts: [textPart("The plan was superseded.")] },
              ],
            })
          },
        },
      }),
    })

    try {
      await restorePersistedSessionIndicatorsForDirectory(bootstrapDirectory, store)

      expect(messageFetches).toBe(1)
      expect(useSessionUIStore.getState().sessionPlanIndicator.has(SESSION_ID)).toBe(false)
      expect(useSessionUIStore.getState().planModeUserMessagesBySession.has(SESSION_ID)).toBe(false)
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("preserves a persisted proposal when authoritative bootstrap validation fails", async () => {
    const bootstrapDirectory = `${DIRECTORY}/failed-proposal-validation`
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(bootstrapDirectory)
    const proposal = { state: "proposed" as const, sourceMessageId: ASSISTANT_MESSAGE_ID }
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Unavailable plan", time: { created: 1, updated: 3 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(structuredPlanBody)],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.setState({
      planModeUserMessages: new Set([USER_MESSAGE_ID]),
      planModeUserMessagesBySession: new Map([[SESSION_ID, USER_MESSAGE_ID]]),
      sessionPlanIndicator: new Map([[SESSION_ID, proposal]]),
    })

    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => Promise.reject(new Error("validation unavailable")),
        },
      }),
    })

    try {
      await restorePersistedSessionIndicatorsForDirectory(bootstrapDirectory, store)

      expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toBe(proposal)
      expect(useSessionUIStore.getState().planModeUserMessagesBySession.get(SESSION_ID)).toBe(USER_MESSAGE_ID)
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("restores the saved plan pointer without mounting the chat after a reload", async () => {
    const originalProjects = useProjectsStore.getState().projects
    registerRuntimeAPIs({
      sessionPlans: {
        ensureRevision: async () => ({ path: '/plans/plan.md', created: false }),
      },
    } as unknown as RuntimeAPIs)
    useProjectsStore.setState({
      projects: [{ id: 'repo', path: DIRECTORY, label: 'Repo' }],
    })

    try {
      const childStores = new ChildStoreManager()
      const store = childStores.ensureChild(DIRECTORY)
      store.setState({
        ...INITIAL_STATE,
        session: [{
          id: SESSION_ID,
          title: "Plan session",
          slug: "plan-session",
          directory: DIRECTORY,
          time: { created: 1, updated: 3 },
        } as Session],
        message: {
          [SESSION_ID]: [userMessage(), assistantMessage()],
        },
        part: {
          [USER_MESSAGE_ID]: [planModePart()],
          [ASSISTANT_MESSAGE_ID]: [textPart(structuredPlanBody)],
        },
        session_status: {
          [SESSION_ID]: { type: "idle" } as SessionStatus,
        },
      })
      useSessionUIStore.setState({
        planModeUserMessages: new Set([USER_MESSAGE_ID]),
        planModeUserMessagesBySession: new Map([[SESSION_ID, USER_MESSAGE_ID]]),
      })

      await restorePersistedSessionIndicatorsForDirectory(DIRECTORY, store)

      const record = useSessionPlanFileStore.getState().recordsBySession[SESSION_ID]
      expect(record?.sourceMessageId).toBe(ASSISTANT_MESSAGE_ID)
      expect(record?.status).toBe('saved')
    } finally {
      registerRuntimeAPIs(null)
      useProjectsStore.setState({ projects: originalProjects })
    }
  })

  test("restores unread background completion only after authoritative message materialization", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Completed session", time: { created: 1, updated: 3 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [textPart("Completed work.")],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useNotificationStore.getState().append({
      type: "turn-complete",
      directory: DIRECTORY,
      session: SESSION_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      time: Date.now(),
      viewed: false,
    })

    await restorePersistedSessionIndicatorsForDirectory(DIRECTORY, store)
    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
      messageId: ASSISTANT_MESSAGE_ID,
      completedAt: 3,
    })
  })

  test("waits for authoritative idle before marking a completed Cursor plan proposed", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart("")],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)

    const routingIndex = routingIndexFor()

    applySyncEventForTest(DIRECTORY, deltaEvent(structuredPlanBody), childStores, routingIndex)
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toBe(undefined)
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })

    applySyncEventForTest(
      DIRECTORY,
      sessionStatusEvent({ type: "idle" } as SessionStatus),
      childStores,
      routingIndex,
    )
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "idle" })
  })

  test("renders plan-ready yellow after part and message updates complete the plan card lifecycle", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const incompleteAssistantMessage = {
      ...assistantMessage(),
      time: { created: 2 },
    } as Message
    const completedPlanPart = textPart(structuredPlanBody)

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), incompleteAssistantMessage],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart("")],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    const routingIndex = routingIndexFor()

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(completedPlanPart),
      childStores,
      routingIndex,
    )
    await flushAsync()
    expect(useSessionUIStore.getState().sessionPlanIndicator.has(SESSION_ID)).toBe(false)

    applySyncEventForTest(
      DIRECTORY,
      messageUpdatedEvent(assistantMessage()),
      childStores,
      routingIndex,
    )
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: true,
      isActive: true,
      hasUnreadCompletion: false,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: null,
    })).toBeNull()

    applySyncEventForTest(
      DIRECTORY,
      sessionStatusEvent({ type: "idle" } as SessionStatus),
      childStores,
      routingIndex,
    )
    await flushAsync()

    const planEntry = useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)
    expect(planEntry).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: false,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: planEntry?.state ?? null,
    })).toEqual({
      className: "bg-status-warning",
      labelKey: "sessions.sidebar.session.status.planReady",
    })
  })

  test("ingests focused-window Plan Ready events before native notification gating", () => {
    const nativeNotifications: Array<{ title?: string; body?: string; tag?: string }> = []

    handleUserNotificationEvent({
      type: "openchamber:notification",
      properties: {
        kind: "plan-ready",
        sessionId: SESSION_ID,
        sourceMessageId: ASSISTANT_MESSAGE_ID,
        title: "Plan ready",
        body: "A plan is ready for review",
        tag: `plan-ready-${SESSION_ID}-${ASSISTANT_MESSAGE_ID}`,
        requireHidden: true,
      },
    }, {
      isFocused: () => true,
      notify: (notification) => {
        nativeNotifications.push(notification)
      },
    })

    expect(nativeNotifications).toEqual([])
    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
  })

  test("authoritatively refreshes a pending background plan on idle without opening the session", async () => {
    const backgroundDirectory = `${DIRECTORY}/background-plan`
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(backgroundDirectory)
    const staleAssistantPart = textPart("Still preparing the plan.")
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Background plan", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [staleAssistantPart],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })
    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)

    let messageFetches = 0
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => {
            messageFetches += 1
            return Promise.resolve({
              data: [
                { info: userMessage(), parts: [planModePart()] },
                { info: assistantMessage(), parts: [textPart(structuredPlanBody)] },
              ],
            })
          },
        },
      }),
    })

    try {
      applySyncEventForTest(
        backgroundDirectory,
        sessionStatusEvent({ type: "idle" } as SessionStatus),
        childStores,
        {
          sessionDirectoryById: new Map([[SESSION_ID, backgroundDirectory]]),
          messageSessionById: new Map([
            [USER_MESSAGE_ID, SESSION_ID],
            [ASSISTANT_MESSAGE_ID, SESSION_ID],
          ]),
          sessionMessageIdsById: new Map([[SESSION_ID, new Set([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID])]]),
        },
      )
      await flushAsync()
      await flushAsync()

      expect(messageFetches).toBe(1)
      expect(useSessionUIStore.getState().currentSessionId).toBe(null)
      expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
        state: "proposed",
        sourceMessageId: ASSISTANT_MESSAGE_ID,
      })
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("materializes a stale ordinary background session on idle and clears green when opened", async () => {
    const ordinaryDirectory = `${DIRECTORY}/ordinary-session`
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(ordinaryDirectory)
    const staleAssistantMessage = {
      ...assistantMessage(),
      time: { created: 2 },
    } as Message
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Ordinary session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), staleAssistantMessage],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [textPart("Still finishing ordinary work.")],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    let messageFetches = 0
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => {
            messageFetches += 1
            return Promise.resolve({
              data: [
                { info: userMessage(), parts: [] },
                { info: assistantMessage(), parts: [textPart("Completed ordinary work.")] },
              ],
            })
          },
        },
      }),
    })

    try {
      applySyncEventForTest(
        ordinaryDirectory,
        sessionStatusEvent({ type: "idle" } as SessionStatus),
        childStores,
        {
          sessionDirectoryById: new Map([[SESSION_ID, ordinaryDirectory]]),
          messageSessionById: new Map([
            [USER_MESSAGE_ID, SESSION_ID],
            [ASSISTANT_MESSAGE_ID, SESSION_ID],
          ]),
          sessionMessageIdsById: new Map([[SESSION_ID, new Set([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID])]]),
        },
      )
      await flushAsync()
      await flushAsync()
      await waitForCompletionIndicatorSettlement()

      expect(messageFetches).toBe(1)
      expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)
      expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
        messageId: ASSISTANT_MESSAGE_ID,
        completedAt: 3,
      })
      expect(resolveSidebarIndicator({
        isRootSession: true,
        isWorking: false,
        isActive: false,
        hasUnreadCompletion: true,
        hasCompletedStatus: true,
        hasErrorStatus: false,
        pendingQuestionCount: 0,
        planState: null,
      })).toEqual({
        className: "bg-status-success",
        labelKey: "sessions.sidebar.session.status.completed",
      })

      useSessionUIStore.getState().setCurrentSession(SESSION_ID, ordinaryDirectory)

      expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)
      expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("deduplicates background completion materialization across idle event variants", async () => {
    const backgroundDirectory = `${DIRECTORY}/duplicate-idle`
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(backgroundDirectory)
    const staleAssistantMessage = {
      ...assistantMessage(),
      time: { created: 2 },
    } as Message
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Duplicate idle", time: { created: 1, updated: 2 } } as Session],
      message: { [SESSION_ID]: [userMessage(), staleAssistantMessage] },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [textPart("Still finishing.")],
      },
      session_status: { [SESSION_ID]: { type: "busy" } as SessionStatus },
    })

    let messageFetches = 0
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => {
            messageFetches += 1
            return Promise.resolve({
              data: [
                { info: userMessage(), parts: [] },
                { info: assistantMessage(), parts: [textPart("Completed once.")] },
              ],
            })
          },
        },
      }),
    })
    const routingIndex = {
      sessionDirectoryById: new Map([[SESSION_ID, backgroundDirectory]]),
      messageSessionById: new Map([
        [USER_MESSAGE_ID, SESSION_ID],
        [ASSISTANT_MESSAGE_ID, SESSION_ID],
      ]),
      sessionMessageIdsById: new Map([[SESSION_ID, new Set([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID])]]),
    }

    try {
      applySyncEventForTest(
        backgroundDirectory,
        sessionStatusEvent({ type: "idle" } as SessionStatus),
        childStores,
        routingIndex,
      )
      applySyncEventForTest(backgroundDirectory, {
        type: "session.idle",
        properties: { sessionID: SESSION_ID },
      } as Event, childStores, routingIndex)
      await flushAsync()
      await flushAsync()
      await waitForCompletionIndicatorSettlement()

      expect(messageFetches).toBe(1)
      expect(useNotificationStore.getState().list).toHaveLength(1)
      expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
        messageId: ASSISTANT_MESSAGE_ID,
        completedAt: 3,
      })
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("materializes an implementing background plan on idle and shows plan completed", async () => {
    const backgroundDirectory = `${DIRECTORY}/implementing-plan`
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(backgroundDirectory)
    const staleImplementationAssistant = {
      ...implementingAssistantMessage(),
      time: { created: 5 },
    } as Message
    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Implementing plan", time: { created: 1, updated: 5 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          staleImplementationAssistant,
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [implementTextPart("Still implementing.")],
      },
      session_status: { [SESSION_ID]: { type: "busy" } as SessionStatus },
    })
    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    useSessionUIStore.getState().markPlanProposed(SESSION_ID, ASSISTANT_MESSAGE_ID)
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      SESSION_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    )

    let messageFetches = 0
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => {
            messageFetches += 1
            return Promise.resolve({
              data: [
                { info: userMessage(), parts: [planModePart()] },
                { info: assistantMessage(), parts: [textPart(`<!--plan-->\n${structuredPlanBody}`)] },
                { info: implementingUserMessage(), parts: [] },
                { info: implementingAssistantMessage(), parts: [implementTextPart("Implemented the plan.")] },
              ],
            })
          },
        },
      }),
    })

    try {
      applySyncEventForTest(
        backgroundDirectory,
        sessionStatusEvent({ type: "idle" } as SessionStatus),
        childStores,
        {
          sessionDirectoryById: new Map([[SESSION_ID, backgroundDirectory]]),
          messageSessionById: new Map([
            [USER_MESSAGE_ID, SESSION_ID],
            [ASSISTANT_MESSAGE_ID, SESSION_ID],
            [IMPLEMENT_USER_MESSAGE_ID, SESSION_ID],
            [IMPLEMENT_ASSISTANT_MESSAGE_ID, SESSION_ID],
          ]),
          sessionMessageIdsById: new Map([[SESSION_ID, new Set([
            USER_MESSAGE_ID,
            ASSISTANT_MESSAGE_ID,
            IMPLEMENT_USER_MESSAGE_ID,
            IMPLEMENT_ASSISTANT_MESSAGE_ID,
          ])]]),
        },
      )
      await flushAsync()
      await flushAsync()
      await waitForCompletionIndicatorSettlement()

      const sessionUI = useSessionUIStore.getState()
      const planEntry = sessionUI.sessionPlanIndicator.get(SESSION_ID)
      expect(messageFetches).toBe(1)
      expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)
      expect(planEntry).toEqual({
        state: "completed",
        sourceMessageId: ASSISTANT_MESSAGE_ID,
        implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
      })
      expect(resolveSidebarIndicator({
        isRootSession: true,
        isWorking: false,
        isActive: false,
        hasUnreadCompletion: true,
        hasCompletedStatus: false,
        hasErrorStatus: false,
        pendingQuestionCount: 0,
        planState: planEntry?.state ?? null,
      })).toEqual({
        className: "bg-status-success",
        labelKey: "sessions.sidebar.session.status.planCompleted",
      })
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("does not materialize or create unread completion for the viewed session on idle", async () => {
    const viewedDirectory = `${DIRECTORY}/viewed-session`
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(viewedDirectory)
    const staleAssistantMessage = {
      ...assistantMessage(),
      time: { created: 2 },
    } as Message
    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Viewed session", time: { created: 1, updated: 2 } } as Session],
      message: { [SESSION_ID]: [userMessage(), staleAssistantMessage] },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [textPart("Still finishing.")],
      },
      session_status: { [SESSION_ID]: { type: "busy" } as SessionStatus },
    })
    setActiveSession(viewedDirectory, SESSION_ID)

    let messageFetches = 0
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: (directory: string) => ({
        session: {
          messages: () => {
            if (directory === viewedDirectory) messageFetches += 1
            return Promise.resolve({ data: [] })
          },
        },
      }),
    })

    try {
      applySyncEventForTest(
        viewedDirectory,
        sessionStatusEvent({ type: "idle" } as SessionStatus),
        childStores,
        {
          sessionDirectoryById: new Map([[SESSION_ID, viewedDirectory]]),
          messageSessionById: new Map([
            [USER_MESSAGE_ID, SESSION_ID],
            [ASSISTANT_MESSAGE_ID, SESSION_ID],
          ]),
          sessionMessageIdsById: new Map([[SESSION_ID, new Set([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID])]]),
        },
      )
      await flushAsync()
      await waitForCompletionIndicatorSettlement()

      expect(messageFetches).toBe(0)
      expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)
      expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
    } finally {
      Object.defineProperty(opencodeClient, "getScopedSdkClient", {
        configurable: true,
        value: originalGetScopedSdkClient,
      })
    }
  })

  test("does not mark proposed when the busy Cursor plan turn is not complete", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          {
            ...assistantMessage(),
            time: { created: 2 },
          } as Message,
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart("")],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)

    const routingIndex = routingIndexFor()

    applySyncEventForTest(DIRECTORY, deltaEvent(structuredPlanBody), childStores, routingIndex)
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.has(SESSION_ID)).toBe(false)
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
  })

  test("records unread completion when a background normal turn completes via part update", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = textPart("Completed work.")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()

    const notificationState = useNotificationStore.getState()
    expect(notificationState.list).toHaveLength(1)
    expect(notificationState.list[0]?.type).toBe("turn-complete")
    expect(notificationState.list[0]?.directory).toBe(DIRECTORY)
    expect(notificationState.list[0]?.session).toBe(SESSION_ID)
    expect(notificationState.list[0]?.messageId).toBe(ASSISTANT_MESSAGE_ID)
    expect(notificationState.list[0]?.viewed).toBe(false)
    expect(notificationState.sessionHasCompletion(SESSION_ID)).toBe(true)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
      messageId: ASSISTANT_MESSAGE_ID,
      completedAt: 3,
    })
  })

  test("retires notifications and pending completion settlement only after authoritative deletion", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = textPart("Completed before deletion.")
    const deletedSession = {
      id: SESSION_ID,
      title: "Delete completed session",
      time: { created: 1, updated: 2 },
    } as Session
    const retainedNotification = {
      type: "turn-complete" as const,
      directory: DIRECTORY,
      session: "ses_retained_completion",
      messageId: "msg_retained_completion",
      time: Date.now(),
      viewed: false,
    }

    store.setState({
      ...INITIAL_STATE,
      session: [deletedSession],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useNotificationStore.getState().append(retainedNotification)

    const routingIndex = routingIndexFor()
    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndex)
    await flushAsync()
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)

    applySyncEventForTest(DIRECTORY, {
      type: "session.deleted",
      properties: { sessionID: SESSION_ID, info: deletedSession },
    } as Event, childStores, routingIndex)

    expect(useNotificationStore.getState().list).toEqual([retainedNotification])
    expect(useNotificationStore.getState().list[0]).toBe(retainedNotification)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
  })

  test("preserves completion notification and settlement when a session is archived", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = textPart("Completed before archive.")
    const session = {
      id: SESSION_ID,
      title: "Archive completed session",
      time: { created: 1, updated: 2 },
    } as Session

    store.setState({
      ...INITIAL_STATE,
      session: [session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    const routingIndex = routingIndexFor()
    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndex)
    await flushAsync()
    applySyncEventForTest(DIRECTORY, {
      type: "session.updated",
      properties: {
        info: { ...session, time: { ...session.time, archived: Date.now() } },
      },
    } as Event, childStores, routingIndex)

    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
      messageId: ASSISTANT_MESSAGE_ID,
      completedAt: 3,
    })
  })

  test("does not record normal completion while a completed assistant still has running patch work", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = toolPart(ASSISTANT_MESSAGE_ID, "running")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()
    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(useNotificationStore.getState().list).toHaveLength(0)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
    expect(useSessionUIStore.getState().sessionPlanIndicator.has(SESSION_ID)).toBe(false)
  })

  test("does not record normal completion from a finalized tool row before the final assistant summary", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = toolPart(ASSISTANT_MESSAGE_ID, "completed")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(useNotificationStore.getState().list).toHaveLength(0)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
  })

  test("does not settle or record completion for an intermediate tool-calls assistant turn", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = toolPart(ASSISTANT_MESSAGE_ID, "completed")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), toolCallsAssistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
    expect(useNotificationStore.getState().list).toHaveLength(0)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
  })

  test("keeps a delayed finalization tail active until authoritative idle", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = toolPart(ASSISTANT_MESSAGE_ID, "completed")
    const summaryPart = textPart("Completed work.")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [summaryPart, completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
    expect(useNotificationStore.getState().list).toHaveLength(0)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)

    applySyncEventForTest(
      DIRECTORY,
      sessionStatusEvent({ type: "idle" } as SessionStatus),
      childStores,
      routingIndexFor(),
    )
    await flushAsync()

    await waitForCompletionIndicatorSettlement()

    expect(useNotificationStore.getState().list).toHaveLength(1)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
      messageId: ASSISTANT_MESSAGE_ID,
      completedAt: 3,
    })
  })

  test("does not show a completion indicator for the viewed active session", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = textPart("Completed work.")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    setActiveSession(DIRECTORY, SESSION_ID)

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()

    expect(useNotificationStore.getState().list).toHaveLength(0)
    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
  })

  test("does not show externally viewed normal turn completion indicator", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = textPart("Completed work.")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    setExternallyViewedSession(DIRECTORY, SESSION_ID, true)

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()

    expect(useNotificationStore.getState().list).toHaveLength(0)
    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
  })

  test("does not create a green indicator from an unread completion notification alone", async () => {
    useNotificationStore.getState().append({
      type: "turn-complete",
      directory: DIRECTORY,
      session: SESSION_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      time: Date.now(),
      viewed: false,
    })

    await waitForCompletionIndicatorSettlement()

    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
  })

  test("clears normal completion attention when authoritative busy starts", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [textPart("Completed work.")],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.getState().markSessionTurnCompleted(SESSION_ID, ASSISTANT_MESSAGE_ID, 3)
    useNotificationStore.getState().append({
      type: "turn-complete",
      directory: DIRECTORY,
      session: SESSION_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      time: Date.now(),
      viewed: false,
    })

    applySyncEventForTest(DIRECTORY, sessionStatusEvent({ type: "busy" } as SessionStatus), childStores, routingIndexFor())
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toBe(undefined)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
  })

  test("cancels pending normal completion when a new busy turn starts before settlement", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const nextUserMessage = {
      id: "msg_next_user",
      sessionID: SESSION_ID,
      role: "user",
      time: { created: 4 },
    } as Message

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 4 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage(), nextUserMessage],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [textPart("Completed work.")],
        [nextUserMessage.id]: [],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().markSessionTurnCompleted(SESSION_ID, ASSISTANT_MESSAGE_ID, 3)
    applySyncEventForTest(DIRECTORY, sessionStatusEvent({ type: "busy" } as SessionStatus), childStores, routingIndexFor([
      USER_MESSAGE_ID,
      ASSISTANT_MESSAGE_ID,
      nextUserMessage.id,
    ]))
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
  })

  test("marks implemented plan completed and records unread completion from part update", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = implementTextPart("Implemented the plan.")
    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    useSessionUIStore.getState().markPlanProposed(SESSION_ID, ASSISTANT_MESSAGE_ID)
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      SESSION_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    )

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(completedPart),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "implementing",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
    const notificationState = useNotificationStore.getState()
    expect(notificationState.list).toHaveLength(1)
    expect(notificationState.list[0]?.type).toBe("turn-complete")
    expect(notificationState.list[0]?.directory).toBe(DIRECTORY)
    expect(notificationState.list[0]?.session).toBe(SESSION_ID)
    expect(notificationState.list[0]?.messageId).toBe(IMPLEMENT_ASSISTANT_MESSAGE_ID)
    expect(notificationState.list[0]?.viewed).toBe(false)

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "completed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
  })

  test("marks implemented plan completed from part update without session id", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = implementTextPart("Implemented the plan.")
    const completedPartWithoutSessionId = { ...completedPart, sessionID: undefined } as unknown as Part
    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    useSessionUIStore.getState().markPlanProposed(SESSION_ID, ASSISTANT_MESSAGE_ID)
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      SESSION_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    )

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(completedPartWithoutSessionId),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "completed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
  })

  test("keeps plan implementation active through final parts until authoritative idle", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = toolPart(IMPLEMENT_ASSISTANT_MESSAGE_ID, "completed")
    const summaryPart = implementTextPart("Implemented the plan.")
    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [summaryPart, completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    useSessionUIStore.getState().markPlanProposed(SESSION_ID, ASSISTANT_MESSAGE_ID)
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      SESSION_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    )

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(completedPart),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
    expect(useNotificationStore.getState().list).toHaveLength(0)
    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)?.state).toBe("implementing")

    applySyncEventForTest(
      DIRECTORY,
      sessionStatusEvent({ type: "idle" } as SessionStatus),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()

    await waitForCompletionIndicatorSettlement()

    expect(useNotificationStore.getState().list).toHaveLength(1)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "completed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
  })

  test("does not settle or mark implemented plan completed while implementation tool work is running", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const runningTool = toolPart(IMPLEMENT_ASSISTANT_MESSAGE_ID, "running")
    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [runningTool],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    useSessionUIStore.getState().markPlanProposed(SESSION_ID, ASSISTANT_MESSAGE_ID)
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      SESSION_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    )

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(runningTool),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
    expect(useNotificationStore.getState().list).toHaveLength(0)
    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "implementing",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
  })

  test("marks structured fallback implemented plan completed without a generic green completion blink", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = implementTextPart("Implemented the plan.")
    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(structuredPlanBody)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    useSessionUIStore.getState().markPlanProposed(SESSION_ID, ASSISTANT_MESSAGE_ID)
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      SESSION_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    )

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(completedPart),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "completed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
  })

  test("manual abort suppresses matching ordinary turn completion and notifications only for that message", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const abortedPart = textPart("Aborted output.")
    const laterAssistantId = "msg_3_assistant"
    const laterPart = {
      id: "prt_assistant_2",
      sessionID: SESSION_ID,
      messageID: laterAssistantId,
      type: "text",
      text: "Completed later work.",
    } as Part

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [abortedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.setState({
      sessionAbortFlags: new Map([
        [SESSION_ID, { reason: "manual", id: ASSISTANT_MESSAGE_ID, acknowledged: false, timestamp: 1 }],
      ]),
    })

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(abortedPart), childStores, routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, laterAssistantId]))
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has(SESSION_ID)).toBe(false)
    expect(useNotificationStore.getState().list).toHaveLength(0)

    store.setState((current) => ({
      message: {
        ...current.message,
        [SESSION_ID]: [
          ...(current.message[SESSION_ID] ?? []),
          { ...assistantMessage(), id: laterAssistantId, time: { created: 4, completed: 5 } } as Message,
        ],
      },
      part: {
        ...current.part,
        [laterAssistantId]: [laterPart],
      },
    }))

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(laterPart), childStores, routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, laterAssistantId]))
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
      messageId: laterAssistantId,
      completedAt: 5,
    })
    expect(useNotificationStore.getState().list).toHaveLength(1)
    expect(useNotificationStore.getState().list[0]?.messageId).toBe(laterAssistantId)
  })

  test("manual abort suppresses matching plan completion and notifications", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = implementTextPart("Implemented the plan.")
    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(structuredPlanBody)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    useSessionUIStore.getState().markPlanProposed(SESSION_ID, ASSISTANT_MESSAGE_ID)
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      SESSION_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    )
    useSessionUIStore.setState({
      sessionAbortFlags: new Map([
        [SESSION_ID, { reason: "manual", id: IMPLEMENT_ASSISTANT_MESSAGE_ID, acknowledged: false, timestamp: 1 }],
      ]),
    })

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(completedPart),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()
    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "implementing",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
    expect(useNotificationStore.getState().list).toHaveLength(0)
  })

  test("keeps busy status when a terminal assistant message lands", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = textPart("Completed work.")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
  })

  test("preserves the status map when terminal assistant metadata lands", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const nonCursorAssistant = {
      ...assistantMessage(),
      providerID: "anthropic",
      time: { created: 2 },
    } as Message

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), nonCursorAssistant],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [],
      },
      session_status: {
        [SESSION_ID]: { type: "busy" } as SessionStatus,
      },
    })

    const previousStatusMap = store.getState().session_status

    applySyncEventForTest(
      DIRECTORY,
      {
        type: "message.updated",
        properties: {
          info: {
            ...nonCursorAssistant,
            finish: "stop",
            time: { created: 2, completed: 3 },
          } as Message,
        },
      } as Event,
      childStores,
      routingIndexFor(),
    )

    expect(store.getState().session_status).toBe(previousStatusMap)
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
  })

  test("clears completed plan attention when authoritative busy starts", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [implementTextPart("Implemented the plan.")],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([[SESSION_ID, true]]),
      sessionPlanIndicator: new Map([
        [SESSION_ID, {
          state: "completed",
          sourceMessageId: ASSISTANT_MESSAGE_ID,
          implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
        }],
      ]),
    })
    useNotificationStore.getState().append({
      type: "turn-complete",
      directory: DIRECTORY,
      session: SESSION_ID,
      messageId: IMPLEMENT_ASSISTANT_MESSAGE_ID,
      time: Date.now(),
      viewed: false,
    })
    useNotificationStore.getState().append({
      type: "error",
      directory: DIRECTORY,
      session: SESSION_ID,
      time: Date.now() + 1,
      viewed: false,
    })

    applySyncEventForTest(DIRECTORY, sessionStatusEvent({ type: "busy" } as SessionStatus), childStores, routingIndexFor())
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toBe(undefined)
    expect(useSessionUIStore.getState().sessionPlanAvailable.get(SESSION_ID)).toBe(true)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(false)
    expect(useNotificationStore.getState().sessionHasError(SESSION_ID)).toBe(false)
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "busy" })
  })

  test("preserves proposed plan indicator when a stale busy status arrives", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([[SESSION_ID, true]]),
      sessionPlanIndicator: new Map([
        [SESSION_ID, {
          state: "proposed",
          sourceMessageId: ASSISTANT_MESSAGE_ID,
        }],
      ]),
    })

    applySyncEventForTest(DIRECTORY, sessionStatusEvent({ type: "busy" } as SessionStatus), childStores, routingIndexFor())
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
    expect(useSessionUIStore.getState().sessionPlanAvailable.get(SESSION_ID)).toBe(true)
  })

  test("preserves proposed plan indicator when a stale retry status arrives", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([[SESSION_ID, true]]),
      sessionPlanIndicator: new Map([
        [SESSION_ID, {
          state: "proposed",
          sourceMessageId: ASSISTANT_MESSAGE_ID,
        }],
      ]),
    })

    applySyncEventForTest(
      DIRECTORY,
      sessionStatusEvent({ type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus),
      childStores,
      routingIndexFor(),
    )
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
    expect(useSessionUIStore.getState().sessionPlanAvailable.get(SESSION_ID)).toBe(true)
  })

  test("preserves implementing plan indicator when implementation turn retries", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [implementTextPart("Still implementing.")],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([[SESSION_ID, true]]),
      sessionPlanIndicator: new Map([
        [SESSION_ID, {
          state: "implementing",
          sourceMessageId: ASSISTANT_MESSAGE_ID,
          implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
        }],
      ]),
    })

    applySyncEventForTest(
      DIRECTORY,
      sessionStatusEvent({ type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "implementing",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
    expect(useSessionUIStore.getState().sessionPlanAvailable.get(SESSION_ID)).toBe(true)
  })

  test("marks viewed implemented plan completed without recording unread notification", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = implementTextPart("Implemented the plan.")
    const implementationKey = `${SESSION_ID}:${ASSISTANT_MESSAGE_ID}:plan:0`

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Plan session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [planModePart()],
        [ASSISTANT_MESSAGE_ID]: [textPart(`<!--plan-->\n${structuredPlanBody}`)],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })
    setActiveSession(DIRECTORY, SESSION_ID)

    useSessionUIStore.getState().recordUserMessagePlanMode(SESSION_ID, USER_MESSAGE_ID, true)
    useSessionUIStore.getState().markPlanProposed(SESSION_ID, ASSISTANT_MESSAGE_ID)
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      SESSION_ID,
      ASSISTANT_MESSAGE_ID,
      IMPLEMENT_USER_MESSAGE_ID,
    )

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(completedPart),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()

    expect(useNotificationStore.getState().list).toHaveLength(0)

    await waitForCompletionIndicatorSettlement()

    const sessionUIState = useSessionUIStore.getState()
    expect(sessionUIState.sessionPlanAvailable.get(SESSION_ID)).toBe(true)
    expect(sessionUIState.sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "completed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
  })

  test("does not record stale completion when part update finalizes a different message", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const oldPart = textPart("Old completed work.")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [
          userMessage(),
          assistantMessage(),
          implementingUserMessage(),
          implementingAssistantMessage(),
        ],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [oldPart],
        [IMPLEMENT_USER_MESSAGE_ID]: [],
        [IMPLEMENT_ASSISTANT_MESSAGE_ID]: [implementTextPart("Latest completed work.")],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    applySyncEventForTest(
      DIRECTORY,
      partUpdatedEvent(oldPart),
      childStores,
      routingIndexFor([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID, IMPLEMENT_USER_MESSAGE_ID, IMPLEMENT_ASSISTANT_MESSAGE_ID]),
    )
    await flushAsync()

    expect(useNotificationStore.getState().list).toHaveLength(0)
  })

  test("deduplicates repeated part update completion notifications for the same message", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild(DIRECTORY)
    const completedPart = textPart("Completed work.")

    store.setState({
      ...INITIAL_STATE,
      session: [{ id: SESSION_ID, title: "Task session", time: { created: 1, updated: 2 } } as Session],
      message: {
        [SESSION_ID]: [userMessage(), assistantMessage()],
      },
      part: {
        [USER_MESSAGE_ID]: [],
        [ASSISTANT_MESSAGE_ID]: [completedPart],
      },
      session_status: {
        [SESSION_ID]: { type: "idle" } as SessionStatus,
      },
    })

    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()
    applySyncEventForTest(DIRECTORY, partUpdatedEvent(completedPart), childStores, routingIndexFor())
    await flushAsync()

    expect(useNotificationStore.getState().list).toHaveLength(1)
    expect(useNotificationStore.getState().sessionUnseenCount(SESSION_ID)).toBe(1)
  })

  test("treats empty session snapshots as authoritative while replaying concurrent lifecycle events", () => {
    const childStores = new ChildStoreManager()
    const routingIndex = routingIndexFor()
    const concurrentSession = {
      id: "ses_concurrent",
      title: "Created during refresh",
      directory: DIRECTORY,
      time: { created: 10, updated: 10 },
    } as Session

    const emptyRevision = captureDirectorySessionListRevision(DIRECTORY)
    expect(reconcileDirectorySessionListSnapshot(DIRECTORY, [], emptyRevision)).toEqual([])

    const createRevision = captureDirectorySessionListRevision(DIRECTORY)
    applySyncEventForTest(DIRECTORY, {
      type: "session.created",
      properties: { info: concurrentSession },
    } as Event, childStores, routingIndex, DIRECTORY)
    expect(reconcileDirectorySessionListSnapshot(DIRECTORY, [], createRevision)).toEqual([concurrentSession])

    const updateRevision = captureDirectorySessionListRevision(DIRECTORY)
    const updatedSession = {
      ...concurrentSession,
      title: "Updated during refresh",
      time: { created: 10, updated: 20 },
    } as Session
    applySyncEventForTest(DIRECTORY, {
      type: "session.updated",
      properties: { info: updatedSession },
    } as Event, childStores, routingIndex, DIRECTORY)
    expect(reconcileDirectorySessionListSnapshot(
      DIRECTORY,
      [concurrentSession],
      updateRevision,
    )).toEqual([updatedSession])

    const deleteRevision = captureDirectorySessionListRevision(DIRECTORY)
    applySyncEventForTest("/wrong-directory", {
      type: "session.deleted",
      properties: { sessionID: concurrentSession.id, info: concurrentSession },
    } as Event, childStores, routingIndex, DIRECTORY)
    expect(reconcileDirectorySessionListSnapshot(
      DIRECTORY,
      [concurrentSession],
      deleteRevision,
    )).toEqual([])
  })

  test("deletes a session from every initialized child store despite a wrong event directory", () => {
    const secondDirectory = "/repo-worktree"
    const deletedSession = {
      id: "ses_duplicated_cache",
      title: "Stale duplicate",
      time: { created: 1, updated: 2 },
    } as Session
    const message = {
      id: "msg_duplicated_cache",
      sessionID: deletedSession.id,
      role: "assistant",
      time: { created: 2 },
    } as Message
    const part = {
      id: "prt_duplicated_cache",
      sessionID: deletedSession.id,
      messageID: message.id,
      type: "text",
      text: "stale",
    } as Part
    const childStores = new ChildStoreManager()
    for (const directory of [DIRECTORY, secondDirectory]) {
      childStores.ensureChild(directory).setState({
        ...INITIAL_STATE,
        session: [deletedSession],
        sessionTotal: 1,
        message: { [deletedSession.id]: [message] },
        part: { [message.id]: [part] },
        session_status: { [deletedSession.id]: { type: "idle" } as SessionStatus },
      })
    }
    useGlobalSessionsStore.setState({
      activeSessions: [deletedSession],
      sessionsByDirectory: new Map([[DIRECTORY, [deletedSession]]]),
    })

    applySyncEventForTest("/wrong-directory", {
      type: "session.deleted",
      properties: { sessionID: deletedSession.id, info: deletedSession },
    } as Event, childStores, routingIndexFor(), DIRECTORY)

    for (const directory of [DIRECTORY, secondDirectory]) {
      const state = childStores.getChild(directory)?.getState()
      expect(state?.session).toEqual([])
      expect(state?.message[deletedSession.id]).toBe(undefined)
      expect(state?.part[message.id]).toBe(undefined)
      expect(state?.session_status[deletedSession.id]).toBe(undefined)
    }
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
  })

  test("mirrors inactive-directory session lifecycle without allocating a child store", () => {
    const remoteDirectory = "/remote-repo"
    const remoteSessionID = "ses_remote"
    const childStores = new ChildStoreManager()
    const routingIndex = {
      sessionDirectoryById: new Map<string, string>(),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }
    const created = {
      id: remoteSessionID,
      title: "Created through tunnel",
      directory: remoteDirectory,
      time: { created: 10, updated: 10 },
    } as Session

    applySyncEventForTest(remoteDirectory, {
      type: "session.created",
      properties: { info: created },
    } as Event, childStores, routingIndex, DIRECTORY)

    expect(childStores.getChild(remoteDirectory)).toBe(undefined)
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([created])

    applySyncEventForTest(remoteDirectory, {
      type: "message.part.delta",
      properties: {
        sessionID: remoteSessionID,
        messageID: "msg_remote",
        partID: "prt_remote",
        field: "text",
        delta: "streaming",
      },
    } as Event, childStores, routingIndex, DIRECTORY)

    expect(childStores.getChild(remoteDirectory)).toBe(undefined)
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([created])

    const archived = {
      ...created,
      time: { created: 10, updated: 20, archived: 20 },
    } as Session
    applySyncEventForTest(remoteDirectory, {
      type: "session.updated",
      properties: { info: archived },
    } as Event, childStores, routingIndex, DIRECTORY)

    expect(childStores.getChild(remoteDirectory)).toBe(undefined)
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([archived])

    applySyncEventForTest(remoteDirectory, {
      type: "session.deleted",
      properties: { sessionID: remoteSessionID, info: archived },
    } as Event, childStores, routingIndex, DIRECTORY)

    expect(childStores.getChild(remoteDirectory)).toBe(undefined)
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([])
  })
})
