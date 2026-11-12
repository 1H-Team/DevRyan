import { describe, expect, test } from "bun:test"
import type { Event, Message, Part, PermissionRequest, Project, QuestionRequest, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import { isAbortGuardActive, registerManualAbortGuard, resetAbortGuardState } from "../abort-retry-guard"
import { applyDirectoryEvent, applyGlobalProject, reduceGlobalEvent } from "../event-reducer"
import { INITIAL_GLOBAL_STATE, INITIAL_STATE, type GlobalState, type State } from "../types"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    session_diff: {},
    ...overrides,
  }
}

function deltaEvent(delta = "hello"): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta,
    },
  } as Event
}

function partUpdatedEvent(text = "hello"): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text,
      },
    },
  } as Event
}

function toolPartUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_tool_1",
        messageID: "msg_tool_1",
        sessionID: "ses_1",
        type: "tool",
        tool: "bash",
        state: { status: "running", time: { start: 123 } },
      },
    },
  } as Event
}

function reasoningPartUpdatedEvent(text = ""): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_reasoning_1",
        messageID: "msg_reasoning_1",
        sessionID: "ses_1",
        type: "reasoning",
        text,
        time: { start: 123 },
      },
    },
  } as Event
}

function testSession(id: string, parentID?: string, revertMessageID?: string): Session {
  return {
    id,
    title: id,
    time: { created: 1, updated: 1 },
    ...(parentID ? { parentID } : {}),
    ...(revertMessageID ? { revert: { messageID: revertMessageID } } : {}),
  } as Session
}

function messageUpdatedEvent(message: Message): Event {
  return {
    type: "message.updated",
    properties: { info: message },
  } as Event
}

function testMessage(id: string, sessionID: string, role: Message["role"], created: number): Message {
  return {
    id,
    sessionID,
    role,
    time: { created },
  } as Message
}

function completedToolCallsAssistantMessage(id: string, sessionID: string, created: number, completed: number): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    finish: "tool-calls",
    time: { created, completed },
  } as unknown as Message
}

function completedAssistantMessage(id: string, sessionID: string, created: number, completed: number): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    finish: "stop",
    time: { created, completed },
  } as unknown as Message
}

function todo(id: string, status: Todo["status"]): Todo {
  return {
    id,
    content: id,
    status,
    priority: "medium",
  } as Todo
}

function todoUpdatedEvent(sessionID: string, todos: Todo[]): Event {
  return {
    type: "todo.updated",
    properties: { sessionID, todos },
  } as Event
}

describe("applyDirectoryEvent", () => {
  test("reinserts a message when an update changes its creation time", () => {
    const first = testMessage("msg_fff", "ses_1", "user", 10)
    const second = testMessage("msg_000", "ses_1", "assistant", 20)
    const draft = state({ message: { ses_1: [first, second] } })

    expect(applyDirectoryEvent(draft, messageUpdatedEvent({ ...first, time: { created: 30 } } as Message))).toBe(true)
    expect(draft.message.ses_1.map((message) => message.id)).toEqual(["msg_000", "msg_fff"])
  })

  test("appends new parts in event order across rollover-prone IDs", () => {
    const draft = state({
      message: { ses_1: [testMessage("msg_1", "ses_1", "assistant", 1)] },
      part: {
        msg_1: [{ id: "prt_fff", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "first" } as Part],
      },
    })
    const event = {
      type: "message.part.updated",
      properties: {
        part: { id: "prt_000", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "second" },
      },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect(draft.part.msg_1.map((part) => part.id)).toEqual(["prt_fff", "prt_000"])
  })

  test("returns typed materialization when delta arrives before parts", () => {
    const result = applyDirectoryEvent(state(), deltaEvent())

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("returns typed materialization when delta part is missing", () => {
    const result = applyDirectoryEvent(
      state({ part: { msg_1: [{ id: "prt_2", messageID: "msg_1", type: "text", text: "" } as Part] } }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("resolves session ID for missing delta materialization when message is known", () => {
    const result = applyDirectoryEvent(
      state({
        message: {
          ses_1: [testMessage("msg_1", "ses_1", "assistant", 1)],
        },
      }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update and requests materialization when owning message is absent", () => {
    const draft = state({
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.message.ses_1[0]?.id).toBe("msg_1")
    expect(draft.message.ses_1[0]?.role).toBe("assistant")
    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("hydrates parent identity when an owning message follows a provisional part", () => {
    const draft = state({
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })

    expect(applyDirectoryEvent(draft, partUpdatedEvent())).not.toBe(false)
    const provisional = draft.message.ses_1[0]
    expect((provisional as { parentID?: string }).parentID).toBe(undefined)
    const owning = {
      ...provisional,
      parentID: "msg_user_1",
    } as Message

    expect(applyDirectoryEvent(draft, messageUpdatedEvent(owning))).toBe(true)
    expect(draft.message.ses_1[0]).toBe(owning)
    expect((draft.message.ses_1[0] as { parentID?: string }).parentID).toBe("msg_user_1")
  })

  test("does not create a provisional assistant message for orphan text when the session is not active", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.message.ses_1).toBe(undefined)
    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("creates a provisional assistant message for orphan live tool parts", () => {
    const draft = state({
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })
    const result = applyDirectoryEvent(draft, toolPartUpdatedEvent())

    expect(draft.message.ses_1[0]?.id).toBe("msg_tool_1")
    expect(draft.message.ses_1[0]?.sessionID).toBe("ses_1")
    expect(draft.message.ses_1[0]?.role).toBe("assistant")
    expect(draft.message.ses_1[0]?.time).toEqual({ created: 123 })
    expect(draft.part.msg_tool_1.map((item) => item.id)).toEqual(["prt_tool_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        sessionID: "ses_1",
        messageID: "msg_tool_1",
        partID: "prt_tool_1",
      },
    })
  })

  test("creates a provisional assistant message for orphan live reasoning parts", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, reasoningPartUpdatedEvent())

    expect(draft.message.ses_1[0]?.id).toBe("msg_reasoning_1")
    expect(draft.message.ses_1[0]?.sessionID).toBe("ses_1")
    expect(draft.message.ses_1[0]?.role).toBe("assistant")
    expect(draft.message.ses_1[0]?.time).toEqual({ created: 123 })
    expect((draft.message.ses_1[0] as { finish?: unknown }).finish).toBe(undefined)
    expect((draft.message.ses_1[0]!.time as { completed?: unknown }).completed).toBe(undefined)
    expect(draft.part.msg_reasoning_1.map((item) => item.id)).toEqual(["prt_reasoning_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        sessionID: "ses_1",
        messageID: "msg_reasoning_1",
        partID: "prt_reasoning_1",
      },
    })
  })

  test("preserves semantic reasoning when the assistant message completes", () => {
    const text = "The user requests to continue implementing the complete explanation."
    const draft = state()

    expect(applyDirectoryEvent(draft, reasoningPartUpdatedEvent(text))).not.toBe(false)
    applyDirectoryEvent(draft, messageUpdatedEvent({
      ...testMessage("msg_reasoning_1", "ses_1", "assistant", 1),
      finish: "stop",
      time: { created: 1, completed: 2 },
    } as Message))

    expect((draft.part.msg_reasoning_1[0] as { text?: string }).text).toBe(text)
  })

  test("applies token-only assistant message updates after completion", () => {
    const completed = {
      ...completedAssistantMessage("msg_1", "ses_1", 1, 2),
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as Message
    const draft = state({ message: { ses_1: [completed] } })
    const measured = {
      ...completed,
      tokens: { total: 1_200, input: 200, output: 50, reasoning: 25, cache: { read: 900, write: 25 } },
    } as unknown as Message

    expect(applyDirectoryEvent(draft, messageUpdatedEvent(measured))).toBe(true)
    expect(draft.message.ses_1[0]).toBe(measured)
  })

  test("applies part update without materialization when owning message exists", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toBe(true)
  })

  test("does not duplicate delta text when a later part snapshot catches up", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })

    expect(applyDirectoryEvent(draft, partUpdatedEvent("a"))).toBe(true)
    expect(applyDirectoryEvent(draft, deltaEvent("b"))).toBe(true)
    expect(applyDirectoryEvent(draft, partUpdatedEvent("ab"))).toBe(true)

    expect((draft.part.msg_1[0] as { text?: string }).text).toBe("ab")
  })

  test("keeps longer streamed text when a shorter not-ended snapshot arrives", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })

    expect(applyDirectoryEvent(draft, partUpdatedEvent("Hello"))).toBe(true)
    expect(applyDirectoryEvent(draft, deltaEvent(" world"))).toBe(true)
    // Stale snapshot generated before the delta was applied.
    expect(applyDirectoryEvent(draft, partUpdatedEvent("Hello"))).toBe(true)

    expect((draft.part.msg_1[0] as { text?: string }).text).toBe("Hello world")

    // The armed dedupe replay must still append the next delta correctly.
    expect(applyDirectoryEvent(draft, deltaEvent("!"))).toBe(true)
    expect((draft.part.msg_1[0] as { text?: string }).text).toBe("Hello world!")
  })

  test("keeps longer streamed reasoning text when a shorter not-ended snapshot arrives", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_reasoning_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const reasoningDelta = (delta: string): Event => ({
      type: "message.part.delta",
      properties: {
        messageID: "msg_reasoning_1",
        partID: "prt_reasoning_1",
        field: "text",
        delta,
      },
    } as Event)

    expect(applyDirectoryEvent(draft, reasoningPartUpdatedEvent("Let me follow the planning"))).toBe(true)
    expect(applyDirectoryEvent(draft, reasoningDelta(" instructions carefully."))).toBe(true)
    expect(applyDirectoryEvent(draft, reasoningPartUpdatedEvent("Let me follow the planning"))).toBe(true)

    expect((draft.part.msg_reasoning_1[0] as { text?: string }).text)
      .toBe("Let me follow the planning instructions carefully.")
  })

  test("an ended snapshot replaces longer local text", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const endedSnapshot = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "Hello",
          time: { start: 1, end: 2 },
        },
      },
    } as Event

    expect(applyDirectoryEvent(draft, partUpdatedEvent("Hello"))).toBe(true)
    expect(applyDirectoryEvent(draft, deltaEvent(" world"))).toBe(true)
    expect(applyDirectoryEvent(draft, endedSnapshot)).toBe(true)

    expect((draft.part.msg_1[0] as { text?: string }).text).toBe("Hello")
  })

  test("a non-prefix snapshot rewrite still replaces local text", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })

    expect(applyDirectoryEvent(draft, partUpdatedEvent("Hello"))).toBe(true)
    expect(applyDirectoryEvent(draft, deltaEvent(" world"))).toBe(true)
    expect(applyDirectoryEvent(draft, partUpdatedEvent("Goodbye"))).toBe(true)

    expect((draft.part.msg_1[0] as { text?: string }).text).toBe("Goodbye")
  })

  test("skips duplicate session status events", () => {
    const draft = state()
    const busyStatus = { type: "busy" } as SessionStatus
    const event = {
      type: "session.status",
      properties: { sessionID: "ses_1", status: busyStatus },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("updates live todos and persistence callback when todo progress changes", () => {
    const draft = state()
    const persisted: Array<{ sessionID: string; todos: Todo[] | undefined }> = []
    const callbacks = {
      onSetSessionTodo: (sessionID: string, todos: Todo[] | undefined) => {
        persisted.push({ sessionID, todos })
      },
    }
    const initialTodos = [
      todo("task-1", "in_progress"),
      todo("task-2", "pending"),
      todo("task-3", "pending"),
      todo("task-4", "pending"),
      todo("task-5", "pending"),
      todo("task-6", "pending"),
    ]
    const progressedTodos = [
      todo("task-1", "completed"),
      todo("task-2", "in_progress"),
      todo("task-3", "pending"),
      todo("task-4", "pending"),
      todo("task-5", "pending"),
      todo("task-6", "pending"),
    ]

    expect(applyDirectoryEvent(draft, todoUpdatedEvent("ses_1", initialTodos), callbacks)).toBe(true)
    expect(draft.todo.ses_1).toEqual(initialTodos)

    expect(applyDirectoryEvent(draft, todoUpdatedEvent("ses_1", progressedTodos), callbacks)).toBe(true)

    expect(draft.todo.ses_1).toEqual(progressedTodos)
    expect(draft.todo.ses_1).toHaveLength(6)
    expect(draft.todo.ses_1[0]?.status).toBe("completed")
    expect(draft.todo.ses_1[1]?.status).toBe("in_progress")
    expect(persisted).toEqual([
      { sessionID: "ses_1", todos: initialTodos },
      { sessionID: "ses_1", todos: progressedTodos },
    ])
  })

  test("skips duplicate session idle events", () => {
    const draft = state()
    const event = {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session error idle-state events", () => {
    const draft = state()
    const event = {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("keeps busy status when terminal assistant metadata arrives", () => {
    const draft = state({
      message: {
        ses_1: [{
          ...testMessage("msg_assistant", "ses_1", "assistant", 1),
          providerID: "anthropic",
        } as unknown as Message],
      },
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })

    const result = applyDirectoryEvent(draft, messageUpdatedEvent({
      ...testMessage("msg_assistant", "ses_1", "assistant", 1),
      providerID: "anthropic",
      finish: "stop",
      time: { created: 1, completed: 2 },
    } as unknown as Message))

    expect(result).toBe(true)
    expect(draft.session_status.ses_1).toEqual({ type: "busy" })
  })

  test("does not settle busy status from an older terminal assistant turn", () => {
    const draft = state({
      message: {
        ses_1: [
          testMessage("msg_1_user", "ses_1", "user", 1),
          testMessage("msg_2_assistant", "ses_1", "assistant", 2),
          testMessage("msg_3_user", "ses_1", "user", 3),
        ],
      },
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })

    const result = applyDirectoryEvent(draft, messageUpdatedEvent({
      ...testMessage("msg_2_assistant", "ses_1", "assistant", 2),
      finish: "stop",
      time: { created: 2, completed: 4 },
    } as unknown as Message))

    expect(result).toBe(true)
    expect(draft.session_status.ses_1).toEqual({ type: "busy" })
  })

  test("does not settle busy status while a blocker is pending", () => {
    const draft = state({
      message: {
        ses_1: [
          testMessage("msg_1_user", "ses_1", "user", 1),
          testMessage("msg_2_assistant", "ses_1", "assistant", 2),
        ],
      },
      permission: {
        ses_1: [{ id: "perm_1", sessionID: "ses_1" } as PermissionRequest],
      },
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })

    const result = applyDirectoryEvent(draft, messageUpdatedEvent({
      ...testMessage("msg_2_assistant", "ses_1", "assistant", 2),
      finish: "stop",
      time: { created: 2, completed: 3 },
    } as unknown as Message))

    expect(result).toBe(true)
    expect(draft.session_status.ses_1).toEqual({ type: "busy" })
  })

  test("keeps session summary totals independent from session diff events", () => {
    const firstSummary = { additions: 5, deletions: 1, title: "first" }
    const secondSummary = { additions: 20, deletions: 4, title: "second" }
    const draft = state({
      session: [
        { ...testSession("ses_1"), summary: firstSummary } as unknown as Session,
        { ...testSession("ses_2"), summary: secondSummary } as unknown as Session,
      ],
    })

    const result = applyDirectoryEvent(draft, {
      type: "session.diff",
      properties: {
        sessionID: "ses_1",
        diff: [
          { file: "added.ts", additions: 12, deletions: 1 },
          { file: "removed.ts", additions: 3, deletions: 7 },
        ],
      },
    } as unknown as Event)

    expect(result).toBe(true)
    expect(draft.session_diff.ses_1).toEqual([
      { file: "added.ts", additions: 12, deletions: 1 },
      { file: "removed.ts", additions: 3, deletions: 7 },
    ])
    expect((draft.session[0] as Session & { summary?: typeof firstSummary }).summary).toBe(firstSummary)
    expect((draft.session[1] as Session & { summary?: typeof secondSummary }).summary).toBe(secondSummary)
  })

  test("preserves session summary reference for duplicate session diff payloads", () => {
    const summary = { additions: 15, deletions: 8, title: "preserved" }
    const diff = [{ file: "added.ts", additions: 15, deletions: 8 }]
    const draft = state({
      session: [{ ...testSession("ses_1"), summary } as unknown as Session],
      session_diff: { ses_1: diff },
    })

    const result = applyDirectoryEvent(draft, {
      type: "session.diff",
      properties: { sessionID: "ses_1", diff: [{ file: "added.ts", additions: 15, deletions: 8 }] },
    } as unknown as Event)

    expect(result).toBe(false)
    expect((draft.session[0] as Session & { summary?: typeof summary }).summary).toBe(summary)
  })

  test("strips untrusted diff totals from raw session updated snapshots without cached messages", () => {
    const draft = state({
      session: [
        {
          ...testSession("ses_1"),
          summary: { title: "preserve me", additions: 95, deletions: 3, files: 2 },
        } as unknown as Session,
      ],
    })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...testSession("ses_1"),
          title: "new title",
          summary: { title: "preserve me", additions: 200, deletions: 40, files: 8 },
        },
      },
    } as unknown as Event)

    expect(result).toBe(true)
    expect(draft.session[0]?.title).toBe("new title")
    expect((draft.session[0] as Session & { summary?: { title?: string; additions?: number; deletions?: number; files?: number } }).summary).toEqual({
      title: "preserve me",
    })
  })

  test("replaces an untitled placeholder with the authoritative generated title", () => {
    const draft = state({
      session: [{ ...testSession("ses_1"), title: "Untitled Session" }],
    })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...testSession("ses_1"),
          title: "Fix OpenAI session titles",
          time: { created: 1, updated: 2 },
        },
      },
    } as Event)

    expect(result).toBe(true)
    expect(draft.session[0]?.title).toBe("Fix OpenAI session titles")
  })

  test("keeps a projected title when a newer canonical event still carries a placeholder", () => {
    const draft = state({
      session: [{
        ...testSession("ses_1"),
        title: "New session - 2026-08-23T21:14:18.802Z",
        time: { created: 1, updated: 3 },
      }],
    })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...testSession("ses_1"),
          title: "Fix OpenAI session titles",
          time: { created: 1, updated: 2 },
        },
      },
    } as Event)

    expect(result).toBe(true)
    expect(draft.session[0]?.title).toBe("Fix OpenAI session titles")
    expect(draft.session[0]?.time.updated).toBe(3)
  })

  test("ignores an older title echo without replacing the current session", () => {
    const current = {
      ...testSession("ses_1"),
      title: "Newest title",
      time: { created: 1, updated: 10 },
    } as Session
    const sessions = [current]
    const draft = state({ session: sessions })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...current,
          title: "Older title",
          time: { created: 1, updated: 9 },
        },
      },
    } as Event)

    expect(result).toBe(false)
    expect(draft.session).toBe(sessions)
    expect(draft.session[0]).toBe(current)
  })

  test("ignores an older archive echo and retains the active session", () => {
    const current = {
      ...testSession("ses_1"),
      time: { created: 1, updated: 10 },
    } as Session
    const draft = state({ session: [current], sessionTotal: 1 })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...current,
          time: { created: 1, updated: 9, archived: 9 },
        },
      },
    } as Event)

    expect(result).toBe(false)
    expect(draft.session).toEqual([current])
    expect(draft.sessionTotal).toBe(1)
  })

  test("takes newer lifecycle facts from an event that is older by updated", () => {
    const current = {
      ...testSession("ses_1"),
      title: "Newest title",
      time: { created: 1, updated: 10, busy: 100 },
    } as unknown as Session
    const draft = state({ session: [current] })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...current,
          title: "Older title",
          time: { created: 1, updated: 9, busy: 100, idle: 150 },
          outcome: "succeeded",
        },
      },
    } as unknown as Event)

    expect(result).toBe(true)
    expect(draft.session[0]).toMatchObject({
      title: "Newest title",
      time: { created: 1, updated: 10, busy: 100, idle: 150 },
      outcome: "succeeded",
    })

    const replay = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...current,
          time: { created: 1, updated: 9, busy: 100, idle: 150 },
          outcome: "failed",
        },
      },
    } as unknown as Event)
    expect(replay).toBe(false)
    expect(draft.session[0]).toMatchObject({ outcome: "succeeded" })
  })

  test("keeps lifecycle facts when a newer record omits them and drops invalid ones", () => {
    const current = {
      ...testSession("ses_1"),
      time: { created: 1, updated: 10, busy: 100, idle: 150, viewed: 120 },
      outcome: "interrupted",
      fork: { sessionID: "ses_0", boundary: { type: "before", messageID: "msg_0" } },
    } as unknown as Session
    const draft = state({ session: [current] })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...testSession("ses_1"),
          title: "Renamed",
          time: { created: 1, updated: 11, idle: "later", viewed: 90 },
          outcome: "unknown",
        },
      },
    } as unknown as Event)

    expect(result).toBe(true)
    expect(draft.session[0]).toMatchObject({
      title: "Renamed",
      time: { created: 1, updated: 11, busy: 100, idle: 150, viewed: 120 },
      outcome: "interrupted",
      fork: { sessionID: "ses_0", boundary: { type: "before", messageID: "msg_0" } },
    })
    expect(draft.session[0]?.parentID).toBeUndefined()
  })

  test("ignores session events without a session identity", () => {
    const draft = state({ session: [testSession("ses_1")] })
    expect(applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: { info: { title: "no id" } },
    } as unknown as Event)).toBe(false)
  })

  test("keeps equal and missing timestamps eligible while duplicate updates are no-ops", () => {
    const current = {
      ...testSession("ses_1"),
      title: "Before",
      time: { created: 1, updated: 10 },
    } as Session
    const draft = state({ session: [current] })

    const equalResult = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: { info: { ...current, title: "Equal", time: { created: 1, updated: 10 } } },
    } as Event)
    expect(equalResult).toBe(true)
    expect(draft.session[0]?.title).toBe("Equal")

    const missingResult = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: { info: { ...current, title: "Missing", time: {} } },
    } as Event)
    expect(missingResult).toBe(true)
    expect(draft.session[0]?.title).toBe("Missing")

    const duplicate = draft.session[0]
    const duplicateResult = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: { info: { ...duplicate, time: { ...duplicate.time } } },
    } as Event)
    expect(duplicateResult).toBe(false)
    expect(draft.session[0]).toBe(duplicate)
  })

  test("strips untrusted diff totals from raw session created snapshots without cached messages", () => {
    const draft = state()

    const result = applyDirectoryEvent(draft, {
      type: "session.created",
      properties: {
        info: {
          ...testSession("ses_1"),
          summary: { additions: 200, deletions: 40, files: 8 },
        },
      },
    } as unknown as Event)

    expect(result).toBe(true)
    expect((draft.session[0] as Session & { summary?: { additions?: number; deletions?: number; files?: number } }).summary).toBe(undefined)
  })

  test("strips raw session diff snapshots even when cached user messages contain diffs", () => {
    const draft = state({
      session: [testSession("ses_1")],
      message: {
        ses_1: [
          {
            ...testMessage("msg_1", "ses_1", "user", 1),
            summary: { diffs: [{ additions: 3, deletions: 1 }] },
          } as unknown as Message,
          {
            ...testMessage("msg_2", "ses_1", "user", 2),
            summary: { additions: 500, deletions: 400 },
          } as unknown as Message,
        ],
      },
      session_user_activity: { ses_1: 2 },
    })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: {
          ...testSession("ses_1"),
          summary: { additions: 200, deletions: 40, files: 8 },
        },
      },
    } as unknown as Event)

    expect(result).toBe(false)
    expect((draft.session[0] as Session & { summary?: unknown }).summary).toBe(undefined)
  })

  test("does not project scoped user message summaries into the owning session", () => {
    const firstSummary = { diffs: [{ additions: 1, deletions: 2 }] }
    const secondSummary = { diffs: [{ additions: 10, deletions: 20 }] }
    const draft = state({
      session: [
        { ...testSession("ses_1"), summary: firstSummary } as unknown as Session,
        { ...testSession("ses_2"), summary: secondSummary } as unknown as Session,
      ],
      message: {
        ses_1: [
          {
            ...testMessage("msg_1", "ses_1", "user", 1),
            summary: { diffs: [{ additions: 3, deletions: 4 }, { additions: "2", deletions: "1" }] },
          } as unknown as Message,
        ],
      },
    })

    const result = applyDirectoryEvent(draft, messageUpdatedEvent({
      ...testMessage("msg_2", "ses_1", "user", 2),
      summary: { diffs: [{ additions: 7, deletions: 8 }] },
    } as unknown as Message))

    expect(result).toBe(true)
    expect((draft.session[0] as Session & { summary?: unknown }).summary).toBe(undefined)
    expect((draft.session[1] as Session & { summary?: typeof secondSummary }).summary).toBe(secondSummary)
  })

  test("ignores bare user message summary totals when recomputing session totals", () => {
    const draft = state({
      session: [
        {
          ...testSession("ses_1"),
          summary: { diffs: [{ additions: 5, deletions: 1 }] },
        } as unknown as Session,
      ],
    })

    const result = applyDirectoryEvent(draft, messageUpdatedEvent({
      ...testMessage("msg_1", "ses_1", "user", 1),
      summary: { additions: 500, deletions: 400 },
    } as unknown as Message))

    expect(result).toBe(true)
    expect((draft.session[0] as Session & { summary?: { diffs?: unknown } }).summary).toBe(undefined)
  })

  test("clears stale session summary diff totals when loaded user messages have no scoped diffs", () => {
    const draft = state({
      session: [
        {
          ...testSession("ses_1"),
          summary: { additions: 95, deletions: 3, title: "stale worktree summary" },
        } as unknown as Session,
      ],
    })

    const result = applyDirectoryEvent(draft, messageUpdatedEvent(testMessage("msg_1", "ses_1", "user", 1)))

    expect(result).toBe(true)
    expect((draft.session[0] as Session & { summary?: { additions?: number; deletions?: number; title?: string } }).summary).toEqual({
      title: "stale worktree summary",
    })
  })

  test("keeps session summaries clear when a user message is removed", () => {
    const draft = state({
      session: [
        {
          ...testSession("ses_1"),
          summary: { additions: 12, deletions: 13 },
        } as unknown as Session,
      ],
      message: {
        ses_1: [
          {
            ...testMessage("msg_1", "ses_1", "user", 1),
            summary: { diffs: [{ additions: 5, deletions: 5 }] },
          } as unknown as Message,
          {
            ...testMessage("msg_2", "ses_1", "user", 2),
            summary: { diffs: [{ additions: 7, deletions: 8 }] },
          } as unknown as Message,
        ],
      },
    })

    const result = applyDirectoryEvent(draft, {
      type: "message.removed",
      properties: { sessionID: "ses_1", messageID: "msg_2" },
    } as Event)

    expect(result).toBe(true)
    expect((draft.session[0] as Session & { summary?: unknown }).summary).toBe(undefined)
  })

  test("detects retry status metadata changes", () => {
    const draft = state({
      session_status: {
        ses_1: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
      },
    })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 20 } as SessionStatus,
      },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect((draft.session_status.ses_1 as Extract<SessionStatus, { type: "retry" }>).attempt).toBe(2)
  })

  test("keeps busy status when an intermediate tool-call assistant completes", () => {
    const draft = state({
      message: {
        ses_1: [
          testMessage("msg_user_1", "ses_1", "user", 1),
          testMessage("msg_assistant_1", "ses_1", "assistant", 2),
        ],
      },
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })

    const result = applyDirectoryEvent(
      draft,
      messageUpdatedEvent(completedToolCallsAssistantMessage("msg_assistant_1", "ses_1", 2, 3)),
    )

    expect(result).toBe(true)
    expect(draft.session_status.ses_1).toEqual({ type: "busy" })
  })

  test("keeps busy status until an authoritative idle event arrives", () => {
    const draft = state({
      message: {
        ses_1: [
          testMessage("msg_user_1", "ses_1", "user", 1),
          testMessage("msg_assistant_1", "ses_1", "assistant", 2),
        ],
      },
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })

    const result = applyDirectoryEvent(
      draft,
      messageUpdatedEvent(completedAssistantMessage("msg_assistant_1", "ses_1", 2, 3)),
    )

    expect(result).toBe(true)
    expect(draft.session_status.ses_1).toEqual({ type: "busy" })
  })

  test("suppresses retry status resurrection after a manual abort", () => {
    try {
      registerManualAbortGuard("ses_1", "/dir")
      const draft = state({
        session_status: { ses_1: { type: "idle" } as SessionStatus },
      })

      const event = {
        type: "session.status",
        properties: {
          sessionID: "ses_1",
          status: { type: "retry", attempt: 2, message: "out of usage", next: 20 } as SessionStatus,
        },
      } as Event

      // Stale retry events for a user-stopped session are coerced to idle —
      // no state change, no "Retrying…" flap.
      expect(applyDirectoryEvent(draft, event)).toBe(false)
      expect(draft.session_status.ses_1).toEqual({ type: "idle" })
    } finally {
      resetAbortGuardState()
    }
  })

  test("session.idle clears the abort guard so later retry statuses apply", () => {
    try {
      registerManualAbortGuard("ses_1")
      const draft = state()

      expect(applyDirectoryEvent(draft, {
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      } as Event)).toBe(true)

      const retryEvent = {
        type: "session.status",
        properties: {
          sessionID: "ses_1",
          status: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
        },
      } as Event

      expect(applyDirectoryEvent(draft, retryEvent)).toBe(true)
      expect(draft.session_status.ses_1).toEqual({ type: "retry", attempt: 1, message: "rate limited", next: 10 })
    } finally {
      resetAbortGuardState()
    }
  })

  test("an authoritative user message clears a prior abort guard for the new turn", () => {
    try {
      registerManualAbortGuard("ses_1")
      const draft = state({
        session: [testSession("ses_1")],
        session_status: { ses_1: { type: "idle" } as SessionStatus },
        message: {
          ses_1: [
            testMessage("msg_user_old", "ses_1", "user", 1),
            testMessage("msg_assistant_old", "ses_1", "assistant", 1.5),
          ],
        },
      })

      expect(applyDirectoryEvent(
        draft,
        messageUpdatedEvent(testMessage("msg_user_new", "ses_1", "user", 2)),
      )).toBe(true)
      expect(isAbortGuardActive("ses_1")).toBe(false)

      const retryEvent = {
        type: "session.status",
        properties: {
          sessionID: "ses_1",
          status: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
        },
      } as Event
      expect(applyDirectoryEvent(draft, retryEvent)).toBe(true)
      expect(draft.session_status.ses_1).toEqual({
        type: "retry",
        attempt: 1,
        message: "rate limited",
        next: 10,
      })
    } finally {
      resetAbortGuardState()
    }
  })

  test("a historical user replay cannot clear an abort guard without a newer cached turn", () => {
    try {
      registerManualAbortGuard("ses_1")
      const draft = state({
        session: [testSession("ses_1")],
        session_status: { ses_1: { type: "idle" } as SessionStatus },
      })

      expect(applyDirectoryEvent(
        draft,
        messageUpdatedEvent(testMessage("msg_user_historical", "ses_1", "user", 1)),
      )).toBe(true)
      expect(isAbortGuardActive("ses_1")).toBe(true)
    } finally {
      resetAbortGuardState()
    }
  })

  test("indexes root user message timestamps without reacting to assistant activity", () => {
    const draft = state({ session: [testSession("ses_1")], session_user_activity: {} })

    expect(applyDirectoryEvent(
      draft,
      messageUpdatedEvent(testMessage("msg_user", "ses_1", "user", 123)),
    )).toBe(true)
    expect(draft.session_user_activity).toEqual({ ses_1: 123 })

    applyDirectoryEvent(
      draft,
      messageUpdatedEvent(testMessage("msg_assistant", "ses_1", "assistant", 456)),
    )
    expect(draft.session_user_activity).toEqual({ ses_1: 123 })
  })

  test("does not index child-session user messages", () => {
    const draft = state({
      session: [testSession("ses_child", "ses_parent")],
      session_user_activity: {},
    })

    applyDirectoryEvent(
      draft,
      messageUpdatedEvent(testMessage("msg_user", "ses_child", "user", 789)),
    )

    expect(draft.session_user_activity).toEqual({})
  })

  test("recomputes user activity when revert hides the latest user message", () => {
    const draft = state({
      session: [testSession("ses_1")],
      message: {
        ses_1: [
          testMessage("msg_1", "ses_1", "user", 100),
          testMessage("msg_2", "ses_1", "assistant", 200),
          testMessage("msg_3", "ses_1", "user", 300),
        ],
      },
      session_user_activity: { ses_1: 300 },
    })

    applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: { info: testSession("ses_1", undefined, "msg_3") },
    } as Event)

    expect(draft.session_user_activity).toEqual({ ses_1: 100 })
  })

  test("does not reinsert messages hidden by a pending revert transaction", () => {
    const draft = state({
      session: [testSession("ses_1", undefined, "msg_3")],
      message: {
        ses_1: [testMessage("msg_1", "ses_1", "user", 100)],
      },
      part: {},
      revert_transaction: {
        ses_1: {
          messageID: "msg_3",
          hiddenMessageIDs: new Set(["msg_3", "msg_4"]),
          version: 1,
          status: "pending",
          startedAt: 1,
        },
      },
    })

    expect(applyDirectoryEvent(draft, messageUpdatedEvent(testMessage("msg_3", "ses_1", "user", 300)))).toBe(false)
    expect(draft.message.ses_1.map((message) => message.id)).toEqual(["msg_1"])
  })

  test("performs one revert lookup for session-less streaming parts", () => {
    const transaction = {
      messageID: "msg_hidden",
      hiddenMessageIDs: new Set(["msg_hidden"]),
      version: 1,
      status: "pending" as const,
      startedAt: 1,
    }
    const draft = state({ session: [], message: {}, part: {} })
    let transactionReads = 0
    Object.defineProperty(draft, "revert_transaction", {
      configurable: true,
      get: () => {
        transactionReads += 1
        return { ses_1: transaction }
      },
      set: () => {},
    })

    expect(applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_hidden",
          messageID: "msg_hidden",
          type: "text",
          text: "hidden",
        },
      },
    } as Event)).toBe(false)
    expect(transactionReads).toBe(1)
  })

  test("archives active session metadata without dropping recent message cache", () => {
    const draft = state({
      session: [testSession("ses_1")],
      message: { ses_1: [testMessage("msg_1", "ses_1", "user", 100)] },
      part: { msg_1: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" } as Part] },
      session_status: { ses_1: { type: "idle" } as SessionStatus },
      sessionTotal: 1,
    })

    expect(applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: { info: { ...testSession("ses_1"), time: { created: 1, updated: 2, archived: 3 } } },
    } as Event)).toBe(true)

    expect(draft.session).toEqual([])
    expect(draft.message.ses_1.map((message) => message.id)).toEqual(["msg_1"])
    expect(draft.part.msg_1.map((part) => part.id)).toEqual(["prt_1"])
    expect(draft.session_status.ses_1).toEqual({ type: "idle" })
    expect(draft.sessionTotal).toBe(0)
  })

  test("updates permission request arrays immutably", () => {
    const initialPermissions = [
      { id: "perm_1", sessionID: "ses_1" } as PermissionRequest,
    ]
    const draft = state({ permission: { ses_1: initialPermissions } })

    applyDirectoryEvent(draft, {
      type: "permission.asked",
      properties: { id: "perm_2", sessionID: "ses_1" } as PermissionRequest,
    } as Event)

    expect(draft.permission.ses_1).not.toBe(initialPermissions)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_1", "perm_2"])

    const afterAsk = draft.permission.ses_1
    applyDirectoryEvent(draft, {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "perm_1" },
    } as Event)

    expect(draft.permission.ses_1).not.toBe(afterAsk)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_2"])
  })

  test("updates question request arrays immutably", () => {
    const initialQuestions = [
      { id: "ques_1", sessionID: "ses_1" } as QuestionRequest,
    ]
    const draft = state({ question: { ses_1: initialQuestions } })

    applyDirectoryEvent(draft, {
      type: "question.asked",
      properties: { id: "ques_2", sessionID: "ses_1" } as QuestionRequest,
    } as Event)

    expect(draft.question.ses_1).not.toBe(initialQuestions)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1", "ques_2"])

    const afterAsk = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "ques_1" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterAsk)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_2"])

    const afterReply = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "ques_2" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterReply)
    expect(draft.question.ses_1).toEqual([])
  })

  test("does not trim the oldest session while it has a pending question", () => {
    const draft = state({
      limit: 1,
      session: [testSession("ses_1")],
      question: {
        ses_1: [{ id: "ques_1", sessionID: "ses_1" } as QuestionRequest],
      },
    })

    applyDirectoryEvent(draft, {
      type: "session.created",
      properties: { info: testSession("ses_2") },
    } as Event)

    expect(draft.session.map((session) => session.id)).toEqual(["ses_1", "ses_2"])
  })

  test("defers assistant text normalization while the session is busy", () => {
    const diagnosticSuffix = '\nSkipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'
    const draft = state({
      session: [testSession("ses_1")],
      message: {
        ses_1: [testMessage("msg_1", "ses_1", "assistant", 1)],
      },
      part: {
        msg_1: [{
          id: "prt_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "before",
        } as Part],
      },
      session_status: { ses_1: { type: "busy" } as SessionStatus },
    })

    const result = applyDirectoryEvent(draft, partUpdatedEvent(`before${diagnosticSuffix}`))

    expect(result).toBe(true)
    expect((draft.part.msg_1[0] as { text?: string }).text).toBe(`before${diagnosticSuffix}`)
  })

  test("normalizes assistant text after the assistant message completes", () => {
    const diagnosticSuffix = '\nSkipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'
    const draft = state({
      session: [testSession("ses_1")],
      message: {
        ses_1: [testMessage("msg_1", "ses_1", "assistant", 1)],
      },
      part: {
        msg_1: [{
          id: "prt_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: `before${diagnosticSuffix}`,
        } as Part],
      },
      session_status: { ses_1: { type: "idle" } as SessionStatus },
    })

    applyDirectoryEvent(draft, messageUpdatedEvent({
      ...testMessage("msg_1", "ses_1", "assistant", 1),
      finish: "stop",
      time: { created: 1, completed: 2 },
    } as Message))

    expect((draft.part.msg_1[0] as { text?: string }).text).toBe("before")
  })
})

describe("provisional delta-materialized parts", () => {
  test("authoritative part update replaces the provisional part and later deltas append without duplication", () => {
    const draft = state({
      message: { ses_1: [testMessage("msg_1", "ses_1", "assistant", 1)] },
      part: {
        msg_1: [{
          id: "prt_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "Hello",
          __provisionalFromDelta: true,
        } as unknown as Part],
      },
    })

    expect(applyDirectoryEvent(draft, partUpdatedEvent("Hello"))).not.toBe(false)
    const replaced = draft.part.msg_1[0] as unknown as Record<string, unknown>
    expect(replaced.__provisionalFromDelta).toBe(undefined)
    expect(replaced.text).toBe("Hello")

    expect(applyDirectoryEvent(draft, deltaEvent("Hello world"))).toBe(true)
    expect((draft.part.msg_1[0] as { text?: string }).text).toBe("Hello world")
  })

  test("an authoritative update of a different type replaces a wrongly guessed provisional text part", () => {
    const draft = state({
      message: { ses_1: [testMessage("msg_1", "ses_1", "assistant", 1)] },
      part: {
        msg_1: [{
          id: "prt_reasoning_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "thinking aloud",
          __provisionalFromDelta: true,
        } as unknown as Part],
      },
    })

    const authoritative: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_reasoning_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "reasoning",
          text: "thinking aloud",
          time: { start: 1 },
        },
      },
    } as Event

    expect(applyDirectoryEvent(draft, authoritative)).not.toBe(false)
    const replaced = draft.part.msg_1[0] as unknown as Record<string, unknown>
    expect(replaced.type).toBe("reasoning")
    expect(replaced.__provisionalFromDelta).toBe(undefined)
  })
})

// ---------------------------------------------------------------------------
// Characterization of events and exports no other test delivers directly.
// ---------------------------------------------------------------------------

function sliceReferences(draft: State): Record<string, unknown> {
  return { ...draft }
}

function expectSlicesKept(draft: State, before: Record<string, unknown>, except: ReadonlyArray<keyof State> = []) {
  for (const key of Object.keys(before) as Array<keyof State>) {
    if (except.includes(key)) continue
    expect(draft[key]).toBe(before[key])
  }
}

// The UI's bun:test typings (src/types/bun-test.d.ts) have no toStrictEqual,
// and toEqual ignores keys whose value is undefined, so own-key paths are
// compared too.
function keyPaths(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => [`${path}/${key}`, ...keyPaths(child, `${path}/${key}`)])
}

// For events that must change nothing: the same slice references and the same
// deep content and keys, so an in-place change to a kept slice fails too.
function expectUnchanged(draft: State, before: Record<string, unknown>, copy: State) {
  expectSlicesKept(draft, before)
  expect(draft).toEqual(copy)
  expect(keyPaths(draft)).toEqual(keyPaths(copy))
}

function textPart(id: string, messageID: string, sessionID = "ses_1"): Part {
  return { id, messageID, sessionID, type: "text", text: id } as Part
}

describe("applyDirectoryEvent: server.instance.disposed", () => {
  test("asks for a refresh of the empty directory and changes nothing", () => {
    const draft = state({ session: [testSession("ses_1")], vcs: { branch: "main" } })
    const before = sliceReferences(draft)
    const copy = structuredClone(draft)
    const refreshed: string[] = []
    let lspLoads = 0

    const result = applyDirectoryEvent(draft, {
      type: "server.instance.disposed",
      properties: { directory: "/work/project" },
    } as Event, {
      onRefresh: (directory) => refreshed.push(directory),
      onLoadLsp: () => { lspLoads += 1 },
    })

    expect(result).toBe(false)
    expect(refreshed).toEqual([""])
    expect(lspLoads).toBe(0)
    expectUnchanged(draft, before, copy)
  })

  test("is a no-op without callbacks", () => {
    const draft = state()
    const before = sliceReferences(draft)
    const copy = structuredClone(draft)
    expect(applyDirectoryEvent(draft, { type: "server.instance.disposed", properties: { directory: "" } } as Event)).toBe(false)
    expect(applyDirectoryEvent(draft, { type: "server.instance.disposed", properties: { directory: "" } } as Event, {})).toBe(false)
    expectUnchanged(draft, before, copy)
  })
})

describe("applyDirectoryEvent: lsp.updated", () => {
  test("asks for an LSP reload once per event and changes nothing", () => {
    const draft = state({ lsp: [] })
    const before = sliceReferences(draft)
    const copy = structuredClone(draft)
    const refreshed: string[] = []
    let lspLoads = 0
    const callbacks = {
      onRefresh: (directory: string) => refreshed.push(directory),
      onLoadLsp: () => { lspLoads += 1 },
    }

    expect(applyDirectoryEvent(draft, { type: "lsp.updated", properties: {} } as Event, callbacks)).toBe(false)
    expect(applyDirectoryEvent(draft, { type: "lsp.updated", properties: {} } as Event, callbacks)).toBe(false)

    expect(lspLoads).toBe(2)
    expect(refreshed).toEqual([])
    expectUnchanged(draft, before, copy)
  })

  test("is a no-op without callbacks", () => {
    const draft = state()
    const before = sliceReferences(draft)
    const copy = structuredClone(draft)
    expect(applyDirectoryEvent(draft, { type: "lsp.updated", properties: {} } as Event)).toBe(false)
    expectUnchanged(draft, before, copy)
  })
})

describe("applyDirectoryEvent: vcs.branch.updated", () => {
  test("sets the branch when there is no VCS record yet", () => {
    const draft = state({ vcs: undefined })
    const before = sliceReferences(draft)
    expect(applyDirectoryEvent(draft, { type: "vcs.branch.updated", properties: { branch: "main" } } as Event)).toBe(true)
    expect(draft.vcs).toEqual({ branch: "main" })
    expectSlicesKept(draft, before, ["vcs"])
  })

  test("returns false and keeps the record when the branch is unchanged", () => {
    const vcs = { branch: "main", default_branch: "main" }
    const draft = state({ vcs })
    const before = sliceReferences(draft)
    const copy = structuredClone(draft)
    expect(applyDirectoryEvent(draft, { type: "vcs.branch.updated", properties: { branch: "main" } } as Event)).toBe(false)
    expect(draft.vcs).toBe(vcs)
    expectUnchanged(draft, before, copy)
  })

  test("replaces the record with a new one holding only the branch, dropping the default branch", () => {
    const vcs = { branch: "main", default_branch: "main" }
    const draft = state({ vcs })
    expect(applyDirectoryEvent(draft, { type: "vcs.branch.updated", properties: { branch: "feature/\u00e9\ud83d\ude00" } } as Event)).toBe(true)
    expect(draft.vcs).not.toBe(vcs)
    expect(draft.vcs).toEqual({ branch: "feature/\u00e9\ud83d\ude00" })
    expect(vcs).toEqual({ branch: "main", default_branch: "main" })
  })

  test("compares branch names exactly", () => {
    const draft = state({ vcs: { branch: "main" } })
    expect(applyDirectoryEvent(draft, { type: "vcs.branch.updated", properties: { branch: "Main" } } as Event)).toBe(true)
    expect(draft.vcs).toEqual({ branch: "Main" })
    expect(applyDirectoryEvent(draft, { type: "vcs.branch.updated", properties: { branch: "Main " } } as Event)).toBe(true)
    expect(draft.vcs).toEqual({ branch: "Main " })
  })

  test("an empty branch name is a change from no record", () => {
    const draft = state({ vcs: undefined })
    expect(applyDirectoryEvent(draft, { type: "vcs.branch.updated", properties: { branch: "" } } as Event)).toBe(true)
    expect(draft.vcs).toEqual({ branch: "" })
  })

  test("a missing branch is no change when there is no record or the record has no branch", () => {
    const empty = state({ vcs: undefined })
    expect(applyDirectoryEvent(empty, { type: "vcs.branch.updated", properties: {} } as Event)).toBe(false)
    expect(empty.vcs).toBeUndefined()

    const defaultOnly = { default_branch: "main" }
    const withDefault = state({ vcs: defaultOnly })
    expect(applyDirectoryEvent(withDefault, { type: "vcs.branch.updated", properties: {} } as Event)).toBe(false)
    expect(withDefault.vcs).toBe(defaultOnly)
  })

  test("a missing branch replaces a record that has one with a record whose branch is undefined", () => {
    const draft = state({ vcs: { branch: "main" } })
    expect(applyDirectoryEvent(draft, { type: "vcs.branch.updated", properties: {} } as Event)).toBe(true)
    expect(draft.vcs).toEqual({ branch: undefined })
    expect(Object.keys(draft.vcs ?? {})).toEqual(["branch"])
  })
})

describe("applyDirectoryEvent: message.part.removed", () => {
  function removed(messageID: string, partID: string, sessionID = "ses_1"): Event {
    return { type: "message.part.removed", properties: { sessionID, messageID, partID } } as Event
  }

  test("returns false and changes nothing when the message has no parts", () => {
    const parts = { msg_2: [textPart("prt_1", "msg_2")] }
    const draft = state({ part: parts })
    const before = sliceReferences(draft)
    const copy = structuredClone(draft)
    expect(applyDirectoryEvent(draft, removed("msg_1", "prt_1"))).toBe(false)
    expect(draft.part).toBe(parts)
    expectUnchanged(draft, before, copy)
  })

  test("returns false and keeps the part list when the part is not in it", () => {
    const list = [textPart("prt_1", "msg_1")]
    const draft = state({ part: { msg_1: list } })
    const before = sliceReferences(draft)
    const copy = structuredClone(draft)
    expect(applyDirectoryEvent(draft, removed("msg_1", "prt_missing"))).toBe(false)
    expect(draft.part.msg_1).toBe(list)
    expectUnchanged(draft, before, copy)
  })

  test("replaces the list with a new one without the part, in place on the part record", () => {
    const first = textPart("prt_1", "msg_1")
    const second = textPart("prt_2", "msg_1")
    const third = textPart("prt_3", "msg_1")
    const list = [first, second, third]
    const other = [textPart("prt_9", "msg_2")]
    const partRecord = { msg_1: list, msg_2: other }
    const draft = state({ part: partRecord })
    const before = sliceReferences(draft)

    expect(applyDirectoryEvent(draft, removed("msg_1", "prt_2"))).toBe(true)

    expect(draft.part).toBe(partRecord)
    expect(draft.part.msg_1).not.toBe(list)
    expect(draft.part.msg_1).toEqual([first, third])
    expect(draft.part.msg_1[0]).toBe(first)
    expect(draft.part.msg_1[1]).toBe(third)
    expect(list).toEqual([first, second, third])
    expect(draft.part.msg_2).toBe(other)
    expectSlicesKept(draft, before)
  })

  test("deletes the message's entry when its last part is removed", () => {
    const draft = state({ part: { msg_1: [textPart("prt_1", "msg_1")], msg_2: [textPart("prt_2", "msg_2")] } })
    expect(applyDirectoryEvent(draft, removed("msg_1", "prt_1"))).toBe(true)
    expect(Object.hasOwn(draft.part, "msg_1")).toBe(false)
    expect(Object.keys(draft.part)).toEqual(["msg_2"])
  })

  test("removes only the first part with a duplicated id", () => {
    const a = textPart("prt_dup", "msg_1")
    const b = { ...textPart("prt_dup", "msg_1"), text: "second" } as Part
    const draft = state({ part: { msg_1: [a, b] } })
    expect(applyDirectoryEvent(draft, removed("msg_1", "prt_dup"))).toBe(true)
    expect(draft.part.msg_1).toHaveLength(1)
    expect(draft.part.msg_1[0]).toBe(b)
  })

  test("ignores the event's session id", () => {
    const draft = state({ part: { msg_1: [textPart("prt_1", "msg_1", "ses_1"), textPart("prt_2", "msg_1", "ses_1")] } })
    expect(applyDirectoryEvent(draft, removed("msg_1", "prt_1", "ses_other"))).toBe(true)
    expect(draft.part.msg_1.map((part) => part.id)).toEqual(["prt_2"])
  })

  test("removing an empty list's part returns false and keeps the empty list", () => {
    const empty: Part[] = []
    const draft = state({ part: { msg_1: empty } })
    expect(applyDirectoryEvent(draft, removed("msg_1", "prt_1"))).toBe(false)
    expect(draft.part.msg_1).toBe(empty)
  })
})

describe("applyDirectoryEvent: session.deleted", () => {
  function deleted(info: Session, sessionID = info.id): Event {
    return { type: "session.deleted", properties: { sessionID, info } } as Event
  }

  function populated(): State {
    const busy = { type: "busy" } as SessionStatus
    return state({
      session: [testSession("ses_a"), testSession("ses_b"), testSession("ses_c")],
      sessionTotal: 3,
      message: {
        ses_a: [testMessage("msg_a1", "ses_a", "user", 1)],
        ses_b: [testMessage("msg_b1", "ses_b", "user", 1), testMessage("msg_b2", "ses_b", "assistant", 2)],
      },
      part: {
        msg_a1: [textPart("prt_a1", "msg_a1", "ses_a")],
        msg_b1: [textPart("prt_b1", "msg_b1", "ses_b")],
        msg_orphan: [textPart("prt_orphan", "msg_orphan", "ses_b")],
      },
      todo: { ses_a: [todo("t_a", "pending")], ses_b: [todo("t_b", "pending")] },
      session_diff: { ses_a: [], ses_b: [] },
      session_status: { ses_a: busy, ses_b: busy },
      permission: {
        ses_a: [{ id: "perm_a", sessionID: "ses_a" } as PermissionRequest],
        ses_b: [{ id: "perm_b", sessionID: "ses_b" } as PermissionRequest],
      },
      question: {
        ses_a: [{ id: "q_a", sessionID: "ses_a" } as QuestionRequest],
        ses_b: [{ id: "q_b", sessionID: "ses_b" } as QuestionRequest],
      },
      session_user_activity: { ses_a: 10, ses_b: 20 },
      revert_transaction: {
        ses_a: { messageID: "msg_a1", version: 1, status: "pending", startedAt: 1 },
        ses_b: { messageID: "msg_b1", version: 1, status: "pending", startedAt: 1 },
      },
      vcs: { branch: "main" },
    })
  }

  test("removes the session and every cache it owns, mutating the records in place", () => {
    const draft = populated()
    const before = sliceReferences(draft)
    const sessionA = draft.session[0]
    const messagesA = draft.message.ses_a
    const partsA = draft.part.msg_a1
    const todoA = draft.todo.ses_a
    const activity = draft.session_user_activity
    const revertA = draft.revert_transaction.ses_a
    const todoCalls: Array<[string, Todo[] | undefined]> = []

    const result = applyDirectoryEvent(draft, deleted(testSession("ses_b")), {
      onSetSessionTodo: (sessionID, todos) => todoCalls.push([sessionID, todos]),
    })

    expect(result).toBe(true)
    expect(draft.session.map((entry) => entry.id)).toEqual(["ses_a", "ses_c"])
    expect(draft.session[0]).toBe(sessionA)
    expect(Object.keys(draft.message)).toEqual(["ses_a"])
    expect(draft.message.ses_a).toBe(messagesA)
    expect(Object.keys(draft.part)).toEqual(["msg_a1"])
    expect(draft.part.msg_a1).toBe(partsA)
    expect(Object.keys(draft.todo)).toEqual(["ses_a"])
    expect(draft.todo.ses_a).toBe(todoA)
    expect(Object.keys(draft.session_diff)).toEqual(["ses_a"])
    expect(Object.keys(draft.session_status)).toEqual(["ses_a"])
    expect(Object.keys(draft.permission)).toEqual(["ses_a"])
    expect(Object.keys(draft.question)).toEqual(["ses_a"])
    expect(draft.session_user_activity).toEqual({ ses_a: 10 })
    expect(activity).toEqual({ ses_a: 10, ses_b: 20 })
    expect(Object.keys(draft.revert_transaction)).toEqual(["ses_a"])
    expect(draft.revert_transaction.ses_a).toBe(revertA)
    expect(draft.sessionTotal).toBe(2)
    expect(todoCalls).toEqual([["ses_b", undefined]])

    // The session list and the cache records are mutated in place; only the
    // user-activity record is replaced.
    expectSlicesKept(draft, before, ["session_user_activity", "sessionTotal"])
    expect(draft.session_user_activity).not.toBe(activity)
  })

  test("keeps the user-activity record when the session has no entry in it", () => {
    const draft = populated()
    const activity = { ses_a: 10 }
    draft.session_user_activity = activity
    expect(applyDirectoryEvent(draft, deleted(testSession("ses_b")))).toBe(true)
    expect(draft.session_user_activity).toBe(activity)
  })

  test("uses the id of the session record, not the event's session id", () => {
    const draft = populated()
    expect(applyDirectoryEvent(draft, deleted(testSession("ses_b"), "ses_a"))).toBe(true)
    expect(draft.session.map((entry) => entry.id)).toEqual(["ses_a", "ses_c"])
    expect(Object.keys(draft.message)).toEqual(["ses_a"])
  })

  test("a deleted child session does not change the total", () => {
    const draft = populated()
    draft.session = [testSession("ses_a"), testSession("ses_b", "ses_a")]
    expect(applyDirectoryEvent(draft, deleted(testSession("ses_b", "ses_a")))).toBe(true)
    expect(draft.session.map((entry) => entry.id)).toEqual(["ses_a"])
    expect(draft.sessionTotal).toBe(3)
  })

  test("an unknown root session still decrements the total, clears its caches and reports a change", () => {
    const draft = populated()
    const sessions = draft.session
    const todoCalls: string[] = []
    draft.todo.ses_unknown = [todo("t_u", "pending")]
    expect(applyDirectoryEvent(draft, deleted(testSession("ses_unknown")), {
      onSetSessionTodo: (sessionID) => todoCalls.push(sessionID),
    })).toBe(true)
    expect(draft.session).toBe(sessions)
    expect(draft.session.map((entry) => entry.id)).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(draft.sessionTotal).toBe(2)
    expect(todoCalls).toEqual(["ses_unknown"])
    expect(Object.keys(draft.todo)).toEqual(["ses_a", "ses_b"])
  })

  test("an unknown child session leaves the total alone and still reports a change", () => {
    const draft = populated()
    expect(applyDirectoryEvent(draft, deleted(testSession("ses_unknown", "ses_a")))).toBe(true)
    expect(draft.sessionTotal).toBe(3)
  })

  test("never takes the total below zero", () => {
    const draft = populated()
    draft.sessionTotal = 0
    expect(applyDirectoryEvent(draft, deleted(testSession("ses_b")))).toBe(true)
    expect(draft.sessionTotal).toBe(0)
  })

  test("deleting the only session leaves an empty list", () => {
    const draft = state({ session: [testSession("ses_1")], sessionTotal: 1 })
    expect(applyDirectoryEvent(draft, deleted(testSession("ses_1")))).toBe(true)
    expect(draft.session).toEqual([])
    expect(draft.sessionTotal).toBe(0)
  })
})

describe("reduceGlobalEvent", () => {
  test("global.disposed and server.connected ask for a refresh", () => {
    const disposed = reduceGlobalEvent({ type: "global.disposed", properties: {} } as Event)
    const connected = reduceGlobalEvent({ type: "server.connected", properties: {} } as Event)
    expect(disposed).toEqual({ type: "refresh" })
    expect(connected).toEqual({ type: "refresh" })
    expect(disposed).not.toBe(connected)
    expect(reduceGlobalEvent({ type: "global.disposed", properties: {} } as Event)).not.toBe(disposed)
  })

  test("project.updated hands the event's project through by reference", () => {
    const project = { id: "prj_1", worktree: "/work", time: { created: 1, updated: 1 }, sandboxes: [] } as Project
    const result = reduceGlobalEvent({ type: "project.updated", properties: project } as Event)
    expect(result).toEqual({ type: "project", project })
    expect(result?.type === "project" ? result.project : undefined).toBe(project)
  })

  test("every other event, directory events included, gives null", () => {
    for (const type of ["server.instance.disposed", "session.created", "lsp.updated", "vcs.branch.updated", "message.part.removed"]) {
      expect(reduceGlobalEvent({ type, properties: {} } as Event)).toBeNull()
    }
  })
})

describe("applyGlobalProject", () => {
  function project(id: string, fields: Partial<Project> = {}): Project {
    return { id, worktree: `/work/${id}`, time: { created: 1, updated: 1 }, sandboxes: [], ...fields } as Project
  }

  function globalState(projects: Project[]): GlobalState {
    return { ...INITIAL_GLOBAL_STATE, projects, sessionTodo: {} }
  }

  test("inserts a new project at its sorted position in a new list and state", () => {
    const a = project("prj_a")
    const c = project("prj_c")
    const projects = [a, c]
    const initial = globalState(projects)

    const next = applyGlobalProject(initial, project("prj_b"))

    expect(next).not.toBe(initial)
    expect(next.projects).not.toBe(projects)
    expect(next.projects.map((entry) => entry.id)).toEqual(["prj_a", "prj_b", "prj_c"])
    expect(next.projects[0]).toBe(a)
    expect(next.projects[2]).toBe(c)
    expect(projects.map((entry) => entry.id)).toEqual(["prj_a", "prj_c"])
    expect(next.path).toBe(initial.path)
    expect(next.providers).toBe(initial.providers)
    expect(next.config).toBe(initial.config)
    expect(next.sessionTodo).toBe(initial.sessionTodo)
  })

  test("inserts at the start, at the end and into an empty list", () => {
    expect(applyGlobalProject(globalState([project("b")]), project("a")).projects.map((entry) => entry.id)).toEqual(["a", "b"])
    expect(applyGlobalProject(globalState([project("a")]), project("b")).projects.map((entry) => entry.id)).toEqual(["a", "b"])
    const inserted = project("only")
    const next = applyGlobalProject(globalState([]), inserted)
    expect(next.projects).toEqual([inserted])
    expect(next.projects[0]).toBe(inserted)
  })

  test("merges an update into the existing project as a new object", () => {
    const existing = project("prj_b", { name: "Old", icon: { color: "red" } } as Partial<Project>)
    const a = project("prj_a")
    const initial = globalState([a, existing])

    const next = applyGlobalProject(initial, { id: "prj_b", worktree: "/moved", name: "New" } as Project)

    expect(next.projects).toHaveLength(2)
    expect(next.projects[0]).toBe(a)
    expect(next.projects[1]).not.toBe(existing)
    expect(next.projects[1]).toEqual({
      id: "prj_b",
      worktree: "/moved",
      time: { created: 1, updated: 1 },
      sandboxes: [],
      name: "New",
      icon: { color: "red" },
    } as unknown as Project)
    expect(existing.name).toBe("Old")
  })

  test("an update with an explicitly undefined field clears that field", () => {
    const next = applyGlobalProject(
      globalState([project("prj_a", { name: "Named" })]),
      { ...project("prj_a"), name: undefined },
    )
    expect(Object.hasOwn(next.projects[0], "name")).toBe(true)
    expect(next.projects[0].name).toBeUndefined()
  })

  test("orders ids by UTF-16 code units, not by code points or locale", () => {
    const next = applyGlobalProject(globalState([project("B"), project("a")]), project("_"))
    expect(next.projects.map((entry) => entry.id)).toEqual(["B", "_", "a"])
    const unicode = applyGlobalProject(globalState([project("z"), project("\ud83d\ude00")]), project("\u00e9"))
    expect(unicode.projects.map((entry) => entry.id)).toEqual(["z", "\u00e9", "\ud83d\ude00"])
    // U+1F600 is above U+FF01 as a code point, but its first code unit
    // (0xD83D) is below 0xFF01, so it sorts first.
    const emoji = "\ud83d\ude00"
    const fullwidth = "\uff01"
    expect(applyGlobalProject(globalState([project(emoji)]), project(fullwidth)).projects.map((entry) => entry.id)).toEqual([emoji, fullwidth])
    expect(applyGlobalProject(globalState([project(fullwidth)]), project(emoji)).projects.map((entry) => entry.id)).toEqual([emoji, fullwidth])
    const three = applyGlobalProject(globalState([project("\ue000"), project(fullwidth)]), project(emoji))
    expect(three.projects.map((entry) => entry.id)).toEqual([emoji, "\ue000", fullwidth])
  })

  test("returns a new state even when an update changes nothing", () => {
    const existing = project("prj_a")
    const initial = globalState([existing])
    const next = applyGlobalProject(initial, existing)
    expect(next).not.toBe(initial)
    expect(next.projects).not.toBe(initial.projects)
    expect(next.projects[0]).not.toBe(existing)
    expect(next.projects[0]).toEqual(existing)
  })

  test("on an unsorted list a binary-search miss inserts a duplicate id", () => {
    // The list is assumed sorted; an unsorted one is not repaired.
    const next = applyGlobalProject(globalState([project("c"), project("a"), project("b")]), project("c", { name: "dup" }))
    expect(next.projects.map((entry) => entry.id)).toEqual(["c", "a", "b", "c"])
  })
})
