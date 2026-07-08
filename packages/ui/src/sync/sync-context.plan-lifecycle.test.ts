import { beforeEach, describe, expect, mock, test } from "bun:test"

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: () => false }),
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
import { useSessionUIStore } from "./session-ui-store"
import { applySyncEventForTest, setActiveSession, setExternallyViewedSession } from "./sync-context"
import { useNotificationStore } from "./notification-store"

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
  await Promise.resolve()
  await Promise.resolve()
}

const SESSION_COMPLETION_INDICATOR_SETTLE_MS = 250

const waitForCompletionIndicatorSettlement = async () => {
  await new Promise((resolve) => setTimeout(resolve, SESSION_COMPLETION_INDICATOR_SETTLE_MS + 20))
}

describe("sync plan lifecycle on message.part.delta", () => {
  beforeEach(() => {
    useSessionUIStore.setState({
      sessionPlanIndicator: new Map(),
      sessionPlanAvailable: new Map(),
      sessionCompletionIndicator: new Map(),
      sessionAbortFlags: new Map(),
      implementedPlanRequests: new Set(),
      planModeUserMessages: new Set(),
      planModeUserMessagesBySession: new Map(),
    })
    setActiveSession("", "")
    setExternallyViewedSession(DIRECTORY, SESSION_ID, false)
    useNotificationStore.setState({
      list: [],
      index: {
        session: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
        project: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
      },
    })
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

  test("marks proposed and settles stale busy status when a completed Cursor plan arrives via delta", async () => {
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

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "proposed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
    })
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "idle" })
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

  test("settles stale busy completed normal turn and records completion without a separate idle event", async () => {
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

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "idle" })

    expect(useNotificationStore.getState().list).toHaveLength(1)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
      messageId: ASSISTANT_MESSAGE_ID,
      completedAt: 3,
    })
  })

  test("shows viewed normal turn completion indicator without unread notification", async () => {
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

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
      messageId: ASSISTANT_MESSAGE_ID,
      completedAt: 3,
    })
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

  test("preserves normal completion when a stale busy status arrives", async () => {
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

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get(SESSION_ID)).toEqual({
      messageId: ASSISTANT_MESSAGE_ID,
      completedAt: 3,
    })
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "idle" })
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

  test("settles stale busy completed plan implementation and marks plan completed", async () => {
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

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "idle" })
    expect(useNotificationStore.getState().list).toHaveLength(1)

    await waitForCompletionIndicatorSettlement()

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

  test("settles stale busy status to idle when a terminal assistant message lands", async () => {
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

    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "idle" })
  })

  test("clones session status when terminal assistant message settlement happens through sync", () => {
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

    expect(store.getState().session_status).not.toBe(previousStatusMap)
    expect(store.getState().session_status[SESSION_ID]).toEqual({ type: "idle" })
  })

  test("preserves completed plan and completion notifications when a stale busy status arrives", async () => {
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

    applySyncEventForTest(DIRECTORY, sessionStatusEvent({ type: "busy" } as SessionStatus), childStores, routingIndexFor())
    await flushAsync()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get(SESSION_ID)).toEqual({
      state: "completed",
      sourceMessageId: ASSISTANT_MESSAGE_ID,
      implementationMessageId: IMPLEMENT_USER_MESSAGE_ID,
    })
    expect(useSessionUIStore.getState().sessionPlanAvailable.get(SESSION_ID)).toBe(true)
    expect(useNotificationStore.getState().sessionHasCompletion(SESSION_ID)).toBe(true)
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
})
