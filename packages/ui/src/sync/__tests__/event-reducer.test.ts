import { describe, expect, test } from "bun:test"
import type { Event, Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import { isAbortGuardActive, registerManualAbortGuard, resetAbortGuardState } from "../abort-retry-guard"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

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
    expect((draft.message.ses_1[0]?.time as { completed?: unknown }).completed).toBe(undefined)
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
