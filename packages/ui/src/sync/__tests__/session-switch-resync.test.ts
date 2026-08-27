import { describe, expect, test, beforeEach, mock } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"

const listPendingQuestionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
const listPendingPermissionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
const sessionStatusCalls: Array<Record<string, never>> = []
const sessionGetCalls: Array<{ sessionID?: string }> = []
const sessionMessagesCalls: Array<{ sessionID?: string; limit?: number }> = []
let sessionStatusGate: Promise<void> | null = null
let sessionMessagesGate: Promise<void> | null = null
let pendingQuestionsResponse: QuestionRequest[] = []
let pendingPermissionsResponse: PermissionRequest[] = []
let sessionStatusResponse: Record<string, { type: "idle" | "busy" | "retry" }> = {}
let pendingQuestionsError: unknown = null
let pendingPermissionsError: unknown = null
let sessionStatusError: unknown = null
let sessionGetResponse: Record<string, State["session"][number] | null> = {}
let sessionMessagesResponse: Record<string, Array<{ info: State["message"][string][number]; parts?: State["part"][string] }>> = {}
let autoAcceptingSessions = new Set<string>()
const respondToPermissionCalls: Array<{ sessionID: string; requestID: string; reply: string }> = []

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    listPendingQuestions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingQuestionsCalls.push(opts ?? {})
      if (pendingQuestionsError) throw pendingQuestionsError
      return pendingQuestionsResponse
    }),
    listPendingPermissions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingPermissionsCalls.push(opts ?? {})
      if (pendingPermissionsError) throw pendingPermissionsError
      return pendingPermissionsResponse
    }),
    getDirectory: () => "/repo",
    getScopedSdkClient: () => ({
      session: {
        status: mock(() => {
          sessionStatusCalls.push({})
          if (sessionStatusError) throw sessionStatusError
          return (sessionStatusGate ?? Promise.resolve()).then(() => ({ data: sessionStatusResponse }))
        }),
        get: mock((params: { sessionID?: string }) => {
          sessionGetCalls.push(params)
          return Promise.resolve({ data: sessionGetResponse[String(params.sessionID)] ?? null })
        }),
        messages: mock((params: { sessionID?: string; limit?: number }) => {
          sessionMessagesCalls.push(params)
          return (sessionMessagesGate ?? Promise.resolve()).then(() => ({
            data: sessionMessagesResponse[String(params.sessionID)] ?? [],
          }))
        }),
      },
    }),
    setDirectory: () => undefined,
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: (sessionId: string) => autoAcceptingSessions.has(sessionId) }),
  },
}))

mock.module("../session-actions", () => ({
  setActionRefs: () => undefined,
  respondToPermission: mock(async (sessionID: string, requestID: string, reply: string) => {
    respondToPermissionCalls.push({ sessionID, requestID, reply })
  }),
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
    setState: () => undefined,
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: { getState: () => ({}) },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}))

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import {
  createForegroundRecoveryHandlers,
  resyncBlockingRequestsForDirectory,
  setActiveSession,
} from "../sync-context"
import { useSessionUIStore } from "../session-ui-store"
import { appendNotification, useNotificationStore } from "../notification-store"
import { getSafeStorage } from "@/stores/utils/safeStorage"

const COMPLETION_NOTIFICATION_STORAGE_KEY = "openchamber:notification-completions:v1"

function resetNotificationStore() {
  useNotificationStore.setState({
    list: [],
    index: {
      session: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
      project: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
    },
  })
  getSafeStorage().removeItem(COMPLETION_NOTIFICATION_STORAGE_KEY)
}

function buildQuestion(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "que_1",
    sessionID: "ses_a",
    questions: [{ question: "Continue?", header: "Q", options: [{ label: "Yes", description: "" }] }],
    ...overrides,
  } as QuestionRequest
}

function buildPermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm_1",
    sessionID: "ses_a",
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
    ...overrides,
  } as PermissionRequest
}

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [{ id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

describe("foreground recovery", () => {
  test("recovers on window focus even when visibility did not transition", () => {
    let visibilityState: DocumentVisibilityState = "hidden"
    let recoveryCount = 0
    const handlers = createForegroundRecoveryHandlers(
      () => {
        recoveryCount += 1
      },
      () => visibilityState,
    )

    handlers.onVisibilityChange()
    expect(recoveryCount).toBe(0)

    handlers.onWindowFocus()
    expect(recoveryCount).toBe(1)

    visibilityState = "visible"
    handlers.onVisibilityChange()
    expect(recoveryCount).toBe(2)
  })
})

describe("resyncBlockingRequestsForDirectory", () => {
  beforeEach(() => {
    listPendingQuestionsCalls.length = 0
    listPendingPermissionsCalls.length = 0
    sessionStatusCalls.length = 0
    sessionGetCalls.length = 0
    sessionMessagesCalls.length = 0
    sessionStatusGate = null
    sessionMessagesGate = null
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []
    sessionStatusResponse = {}
    pendingQuestionsError = null
    pendingPermissionsError = null
    sessionStatusError = null
    sessionGetResponse = {}
    sessionMessagesResponse = {}
    autoAcceptingSessions = new Set<string>()
    respondToPermissionCalls.length = 0
  })

  test("calls listPendingQuestions and listPendingPermissions exactly once for the directory", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(listPendingQuestionsCalls).toHaveLength(1)
    expect(listPendingQuestionsCalls[0]).toEqual({ directories: ["/repo"] })
    expect(listPendingPermissionsCalls).toHaveLength(1)
    expect(listPendingPermissionsCalls[0]).toEqual({ directories: ["/repo"] })
  })

  test("merges newly fetched questions/permissions into the directory store", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_1")
    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_1")
  })

  test("preserves an in-flight SSE-delivered question whose signature changed during the fetch", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_initial" }] },
    })
    pendingQuestionsResponse = []

    const promise = resyncBlockingRequestsForDirectory("/repo", store)
    store.setState({
      question: { ses_a: [{ ...buildQuestion(), id: "que_sse_arrived" }] },
    })
    await promise

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_sse_arrived")
  })

  test("clears stale entries when API returns no pending requests and signature unchanged", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_stale" }] },
    })
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toEqual(undefined)
  })

  test("ignores questions for sessions the directory does not know about", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [{ ...buildQuestion(), sessionID: "ses_unknown" }]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_unknown"]).toEqual(undefined)
  })

  test("auto-responds to pending permissions instead of retaining them", async () => {
    const store = createDirectoryStore({
      session: [
        { id: "parent", title: "parent", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number],
        { id: "child", parentID: "parent", title: "child", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number],
      ],
    })
    pendingPermissionsResponse = [buildPermission({ id: "perm_child", sessionID: "child" })]
    autoAcceptingSessions.add("child")

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(respondToPermissionCalls).toEqual([
      { sessionID: "child", requestID: "perm_child", reply: "once" },
    ])
    expect(store.getState().permission.child).toEqual(undefined)
  })

  test("materializes an unknown child session before merging its pending permission", async () => {
    const store = createDirectoryStore({
      session: [
        { id: "parent", title: "parent", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number],
      ],
    })
    pendingPermissionsResponse = [buildPermission({
      id: "perm_child_file",
      sessionID: "child",
      permission: "external_directory",
      patterns: ["/Users/dev/private-note.md"],
      metadata: { path: "/Users/dev/private-note.md" },
      always: ["/Users/dev/*"],
    })]
    sessionGetResponse = {
      child: { id: "child", parentID: "parent", title: "child", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number],
    }

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(sessionGetCalls).toEqual([{ sessionID: "child" }])
    expect(store.getState().session.map((session) => session.id)).toEqual(["child", "parent"])
    expect(store.getState().permission.child?.map((permission) => permission.id)).toEqual(["perm_child_file"])
  })

  test("returns early without fetching when no candidate sessions are known", async () => {
    const store = createDirectoryStore({ session: [] })
    await resyncBlockingRequestsForDirectory("/repo", store)
    expect(listPendingQuestionsCalls).toHaveLength(0)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })
})

describe("resyncDirectoryAfterReconnect", () => {
  beforeEach(() => {
    listPendingQuestionsCalls.length = 0
    listPendingPermissionsCalls.length = 0
    sessionStatusCalls.length = 0
    sessionGetCalls.length = 0
    sessionMessagesCalls.length = 0
    sessionStatusGate = null
    sessionMessagesGate = null
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []
    sessionStatusResponse = {}
    pendingQuestionsError = null
    pendingPermissionsError = null
    sessionStatusError = null
    sessionGetResponse = {}
    sessionMessagesResponse = {}
    autoAcceptingSessions = new Set<string>()
    respondToPermissionCalls.length = 0
    resetNotificationStore()
  })

  test("resyncs an explicitly targeted session even when reconnect heuristics have no candidates", async () => {
    const store = createDirectoryStore({
      session_status: {},
      message: {},
      part: {},
    })
    const completedAssistant = {
      id: "msg_assistant",
      sessionID: "ses_a",
      role: "assistant",
      time: { created: 1, completed: 2 },
    } as State["message"][string][number]
    sessionStatusResponse = { ses_a: { type: "idle" } }
    sessionGetResponse = {
      ses_a: { id: "ses_a", title: "ses_a", time: { created: 1, updated: 2 }, version: "1" } as State["session"][number],
    }
    sessionMessagesResponse = {
      ses_a: [{ info: completedAssistant, parts: [] }],
    }
    const routingIndex = {
      sessionDirectoryById: new Map<string, string>(),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {
      candidateSessionIds: ["ses_a"],
    })

    expect(sessionStatusCalls).toHaveLength(1)
    expect(sessionGetCalls).toEqual([{ sessionID: "ses_a" }])
    expect(sessionMessagesCalls).toEqual([{ sessionID: "ses_a", limit: 30 }])
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(store.getState().message.ses_a).toEqual([completedAssistant])
    expect(routingIndex.sessionDirectoryById.get("ses_a")).toBe("/repo")
    expect(routingIndex.messageSessionById.get("msg_assistant")).toBe("ses_a")
  })

  test("foreground recovery replaces a stale completed snapshot and restores the proposed plan lifecycle", async () => {
    const sessionID = "ses_plan"
    const userMessageID = "msg_1_user"
    const assistantMessageID = "msg_2_assistant"
    const planText = [
      "<!--plan-->",
      "# Background Plan",
      "",
      "## Implementation",
      "",
      "1. Inspect the package metadata.",
      "",
      "## Verification",
      "",
      "1. Confirm no files changed.",
    ].join("\n")
    const userMessage = {
      id: userMessageID,
      sessionID,
      role: "user",
      time: { created: 1 },
    } as State["message"][string][number]
    const completedAssistant = {
      id: assistantMessageID,
      sessionID,
      role: "assistant",
      providerID: "cursor-acp",
      time: { created: 2, completed: 3 },
    } as State["message"][string][number]
    const planModePart = {
      id: "prt_plan_mode",
      sessionID,
      messageID: userMessageID,
      type: "text",
      text: "User has requested to enter plan mode.",
      synthetic: true,
    } as State["part"][string][number]
    const staleAssistantPart = {
      id: "prt_assistant",
      sessionID,
      messageID: assistantMessageID,
      type: "text",
      text: "Preparing the plan...",
    } as State["part"][string][number]
    const completedPlanPart = {
      ...staleAssistantPart,
      text: planText,
    } as State["part"][string][number]
    const session = {
      id: sessionID,
      title: "Background plan",
      time: { created: 1, updated: 3 },
      version: "1",
    } as State["session"][number]
    const store = createDirectoryStore({
      session: [session],
      session_status: { [sessionID]: { type: "idle" } },
      message: { [sessionID]: [userMessage, completedAssistant] },
      part: {
        [userMessageID]: [planModePart],
        [assistantMessageID]: [staleAssistantPart],
      },
    })
    sessionStatusResponse = { [sessionID]: { type: "idle" } }
    sessionGetResponse = { [sessionID]: session }
    sessionMessagesResponse = {
      [sessionID]: [
        { info: userMessage, parts: [planModePart] },
        { info: completedAssistant, parts: [completedPlanPart] },
      ],
    }
    const routingIndex = {
      sessionDirectoryById: new Map([[sessionID, "/repo"]]),
      messageSessionById: new Map([
        [userMessageID, sessionID],
        [assistantMessageID, sessionID],
      ]),
      sessionMessageIdsById: new Map([[sessionID, new Set([userMessageID, assistantMessageID])]]),
    }
    const previousParts = store.getState().part[assistantMessageID]

    useSessionUIStore.getState().recordUserMessagePlanMode(sessionID, userMessageID, true)
    setActiveSession("/repo", sessionID)

    try {
      const { resyncDirectoryAfterReconnect } = await import("../sync-context")
      await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {
        candidateSessionIds: [sessionID],
        restoreSessionLifecycleFor: sessionID,
      })

      const nextParts = store.getState().part[assistantMessageID]
      expect(nextParts).not.toBe(previousParts)
      expect(nextParts?.[0]).toEqual(completedPlanPart)
      expect(useSessionUIStore.getState().sessionPlanIndicator.get(sessionID)).toEqual({
        state: "proposed",
        sourceMessageId: assistantMessageID,
      })
    } finally {
      setActiveSession("", "")
      useSessionUIStore.setState((state) => {
        const planModeUserMessages = new Set(state.planModeUserMessages)
        planModeUserMessages.delete(userMessageID)
        const planModeUserMessagesBySession = new Map(state.planModeUserMessagesBySession)
        planModeUserMessagesBySession.delete(sessionID)
        const sessionPlanIndicator = new Map(state.sessionPlanIndicator)
        sessionPlanIndicator.delete(sessionID)
        const sessionPlanAvailable = new Map(state.sessionPlanAvailable)
        sessionPlanAvailable.delete(sessionID)
        return {
          planModeUserMessages,
          planModeUserMessagesBySession,
          sessionPlanIndicator,
          sessionPlanAvailable,
        }
      })
    }
  })

  test("preserves existing status and pending blockers when reconnect fetches fail", async () => {
    const existingQuestion = buildQuestion({ id: "que_existing" })
    const existingPermission = buildPermission({ id: "perm_existing" })
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" } },
      question: { ses_a: [existingQuestion] },
      permission: { ses_a: [existingPermission] },
    })
    sessionStatusError = Object.assign(new Error("status endpoint missing"), { status: 404 })
    pendingQuestionsError = new Error("questions unavailable")
    pendingPermissionsError = new Error("permissions unavailable")
    const routingIndex = {
      sessionDirectoryById: new Map<string, string>(),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {
      candidateSessionIds: ["ses_a"],
    })

    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
    expect(store.getState().question.ses_a).toEqual([existingQuestion])
    expect(store.getState().permission.ses_a).toEqual([existingPermission])
  })

  test("preserves a projected title when reconnect materialization still returns a placeholder", async () => {
    const projectedSession = {
      id: "ses_a",
      title: "Plan large-integer edge-case tests",
      time: { created: 1, updated: 10 },
      version: "1",
    } as State["session"][number]
    const canonicalPlaceholder = {
      ...projectedSession,
      title: "New session - 2026-08-23T22:40:35.991Z",
      time: { created: 1, updated: 11 },
    } as State["session"][number]
    const store = createDirectoryStore({
      session: [projectedSession],
      session_status: { ses_a: { type: "busy" } },
    })
    sessionStatusResponse = { ses_a: { type: "busy" } }
    sessionGetResponse = { ses_a: canonicalPlaceholder }
    sessionMessagesResponse = { ses_a: [] }
    const routingIndex = {
      sessionDirectoryById: new Map([["ses_a", "/repo"]]),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {
      candidateSessionIds: ["ses_a"],
    })

    expect(store.getState().session[0]).toEqual({
      ...canonicalPlaceholder,
      title: projectedSession.title,
    })
  })

  test("preserves a newer live status while the reconnect status snapshot is delayed", async () => {
    const delayedStatus = deferred()
    sessionStatusGate = delayedStatus.promise
    sessionStatusResponse = { ses_a: { type: "busy" } }
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" } },
    })
    const routingIndex = {
      sessionDirectoryById: new Map<string, string>(),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    const resync = resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {
      candidateSessionIds: ["ses_a"],
    })
    await Promise.resolve()
    expect(sessionStatusCalls).toHaveLength(1)

    store.setState({ session_status: { ses_a: { type: "idle" } } })
    delayedStatus.resolve()
    await resync

    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  test("does not reapply a reconnect status snapshot over a later live event", async () => {
    const delayedMessages = deferred()
    sessionMessagesGate = delayedMessages.promise
    sessionStatusResponse = { ses_a: { type: "busy" } }
    sessionGetResponse = {
      ses_a: { id: "ses_a", title: "ses_a", time: { created: 1, updated: 2 }, version: "1" } as State["session"][number],
    }
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "idle" } },
    })
    const routingIndex = {
      sessionDirectoryById: new Map<string, string>(),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    const resync = resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {
      candidateSessionIds: ["ses_a"],
    })
    for (let attempt = 0; attempt < 10 && sessionMessagesCalls.length === 0; attempt += 1) {
      await Promise.resolve()
    }
    expect(sessionMessagesCalls).toEqual([{ sessionID: "ses_a", limit: 30 }])
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })

    store.setState({ session_status: { ses_a: { type: "idle" } } })
    delayedMessages.resolve()
    await resync

    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  // Fixtures for gap-recovery lifecycle detection: locally the session was
  // observed busy with an in-flight assistant message; the server reports the
  // turn finished (idle status + completed assistant summary).
  function buildGapCompletionFixture(sessionID: string, options?: { localStatus?: State["session_status"][string] | null }) {
    const userMessageID = `msg_1_user_${sessionID}`
    const assistantMessageID = `msg_2_assistant_${sessionID}`
    const userMessage = {
      id: userMessageID,
      sessionID,
      role: "user",
      time: { created: 1 },
    } as State["message"][string][number]
    const inFlightAssistant = {
      id: assistantMessageID,
      sessionID,
      role: "assistant",
      time: { created: 2 },
    } as State["message"][string][number]
    const completedAssistant = {
      ...inFlightAssistant,
      time: { created: 2, completed: 3 },
    } as State["message"][string][number]
    const userPart = {
      id: `prt_user_${sessionID}`,
      sessionID,
      messageID: userMessageID,
      type: "text",
      text: "Run the task",
    } as State["part"][string][number]
    const summaryPart = {
      id: `prt_summary_${sessionID}`,
      sessionID,
      messageID: assistantMessageID,
      type: "text",
      text: "Done. All checks pass.",
    } as State["part"][string][number]
    const session = {
      id: sessionID,
      title: sessionID,
      time: { created: 1, updated: 3 },
      version: "1",
    } as State["session"][number]
    const localStatus = options?.localStatus === undefined ? { type: "busy" as const } : options.localStatus
    const store = createDirectoryStore({
      session: [session],
      session_status: localStatus ? { [sessionID]: localStatus } : {},
      message: { [sessionID]: [userMessage, inFlightAssistant] },
      part: { [userMessageID]: [userPart], [assistantMessageID]: [] },
    })
    sessionStatusResponse = { [sessionID]: { type: "idle" } }
    sessionGetResponse = { [sessionID]: session }
    sessionMessagesResponse = {
      [sessionID]: [
        { info: userMessage, parts: [userPart] },
        { info: completedAssistant, parts: [summaryPart] },
      ],
    }
    const routingIndex = {
      sessionDirectoryById: new Map([[sessionID, "/repo"]]),
      messageSessionById: new Map([
        [userMessageID, sessionID],
        [assistantMessageID, sessionID],
      ]),
      sessionMessageIdsById: new Map([[sessionID, new Set([userMessageID, assistantMessageID])]]),
    }
    return { store, routingIndex, userMessageID, assistantMessageID }
  }

  test("marks a background session's missed completion as unread after gap recovery", async () => {
    const sessionID = "ses_bg_done"
    const { store, routingIndex, assistantMessageID } = buildGapCompletionFixture(sessionID)

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {})

    expect(store.getState().session_status[sessionID]).toEqual({ type: "idle" })
    const notifications = useNotificationStore.getState()
    expect(notifications.index.session.unseenHasCompletion[sessionID]).toBe(true)
    expect(notifications.list).toHaveLength(1)
    expect(notifications.list[0]?.messageId).toBe(assistantMessageID)
  })

  test("restores a background session's proposed-plan indicator after gap recovery", async () => {
    const sessionID = "ses_bg_plan"
    const { store, routingIndex, userMessageID, assistantMessageID } = buildGapCompletionFixture(sessionID)
    const planText = [
      "<!--plan-->",
      "# Background Plan",
      "",
      "## Implementation",
      "",
      "1. Inspect the package metadata.",
      "",
      "## Verification",
      "",
      "1. Confirm no files changed.",
    ].join("\n")
    const planModePart = {
      id: `prt_plan_mode_${sessionID}`,
      sessionID,
      messageID: userMessageID,
      type: "text",
      text: "User has requested to enter plan mode.",
      synthetic: true,
    } as State["part"][string][number]
    const completedAssistant = {
      ...sessionMessagesResponse[sessionID][1].info,
      providerID: "cursor-acp",
    } as State["message"][string][number]
    sessionMessagesResponse = {
      [sessionID]: [
        { info: sessionMessagesResponse[sessionID][0].info, parts: [planModePart] },
        {
          info: completedAssistant,
          parts: [{
            id: `prt_plan_${sessionID}`,
            sessionID,
            messageID: assistantMessageID,
            type: "text",
            text: planText,
          } as State["part"][string][number]],
        },
      ],
    }
    useSessionUIStore.getState().recordUserMessagePlanMode(sessionID, userMessageID, true)

    try {
      const { resyncDirectoryAfterReconnect } = await import("../sync-context")
      await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {})

      expect(useSessionUIStore.getState().sessionPlanIndicator.get(sessionID)).toEqual({
        state: "proposed",
        sourceMessageId: assistantMessageID,
      })
      expect(useNotificationStore.getState().index.session.unseenHasCompletion[sessionID]).toBeFalsy()
    } finally {
      useSessionUIStore.setState((state) => {
        const planModeUserMessages = new Set(state.planModeUserMessages)
        planModeUserMessages.delete(userMessageID)
        const planModeUserMessagesBySession = new Map(state.planModeUserMessagesBySession)
        planModeUserMessagesBySession.delete(sessionID)
        const sessionPlanIndicator = new Map(state.sessionPlanIndicator)
        sessionPlanIndicator.delete(sessionID)
        const sessionPlanAvailable = new Map(state.sessionPlanAvailable)
        sessionPlanAvailable.delete(sessionID)
        return {
          planModeUserMessages,
          planModeUserMessagesBySession,
          sessionPlanIndicator,
          sessionPlanAvailable,
        }
      })
    }
  })

  test("suppresses the unread completion for a session viewed in a chat surface", async () => {
    const sessionID = "ses_bg_viewed"
    const { store, routingIndex } = buildGapCompletionFixture(sessionID)
    // setExternallyViewedSession feeds the same isViewedInCurrentSession guard
    // as the active-session check. Unlike setActiveSession it is not shadowed
    // by session-ui-store.send.test.ts's leaked mock.module("./sync-context")
    // stub in whole-folder runs, so the suppression state reliably reaches the
    // module instance that runs detection.
    const { resyncDirectoryAfterReconnect, setExternallyViewedSession } = await import("../sync-context")
    setExternallyViewedSession("/repo", sessionID, true)

    try {
      await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {})

      const notifications = useNotificationStore.getState()
      expect(notifications.index.session.unseenHasCompletion[sessionID]).toBeFalsy()
      expect(notifications.list).toHaveLength(0)
    } finally {
      setExternallyViewedSession("/repo", sessionID, false)
    }
  })

  test("does not duplicate a completion notification already recorded for the message", async () => {
    const sessionID = "ses_bg_dup"
    const { store, routingIndex, assistantMessageID } = buildGapCompletionFixture(sessionID)
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: sessionID,
      messageId: assistantMessageID,
      time: Date.now(),
      viewed: true,
    })

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {})

    const notifications = useNotificationStore.getState()
    expect(notifications.list).toHaveLength(1)
    expect(notifications.index.session.unseenHasCompletion[sessionID]).toBeFalsy()
  })

  test("does not resurface completions for sessions never observed busy by this client", async () => {
    const sessionID = "ses_bg_stale"
    const { store, routingIndex } = buildGapCompletionFixture(sessionID, { localStatus: null })

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {})

    expect(store.getState().session_status[sessionID]).toEqual({ type: "idle" })
    const notifications = useNotificationStore.getState()
    expect(notifications.list).toHaveLength(0)
    expect(notifications.index.session.unseenHasCompletion[sessionID]).toBeFalsy()
  })

  test("defers lifecycle detection when the status snapshot fetch fails", async () => {
    const sessionID = "ses_bg_statusfail"
    const { store, routingIndex } = buildGapCompletionFixture(sessionID)
    sessionStatusError = Object.assign(new Error("status endpoint missing"), { status: 404 })

    const { resyncDirectoryAfterReconnect } = await import("../sync-context")
    await resyncDirectoryAfterReconnect("/repo", store, routingIndex as never, {})

    expect(store.getState().session_status[sessionID]).toEqual({ type: "busy" })
    expect(useNotificationStore.getState().list).toHaveLength(0)
  })
})
