import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "../materialization"

function message(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 } } as Message
}

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function part(id: string, messageID: string, type = "text", text = id): Part {
  return { id, messageID, sessionID: "ses_1", type, text } as Part
}

describe("materializeSessionSnapshots", () => {
  test("materializes messages and parts together", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_1", "msg_1")] }],
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.messagesChanged).toBe(true)
    expect(result.partsChanged).toBe(true)
  })

  test("preserves unchanged references", () => {
    const existingMessage = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state = { message: { ses_1: [existingMessage] }, part: { msg_1: [existingPart] } }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: existingMessage, parts: [existingPart] }],
    )

    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
    expect(result.messagesChanged).toBe(false)
    expect(result.partsChanged).toBe(false)
  })

  test("replaces stale same-id assistant snapshots when the server has completion state", () => {
    const staleAssistant = message("msg_1")
    const completedAssistant = {
      ...staleAssistant,
      time: { created: 1, completed: 2 },
    } as Message
    const state = { message: { ses_1: [staleAssistant] }, part: {} }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: completedAssistant, parts: [] }],
    )

    expect(result.message.ses_1[0]).toBe(completedAssistant)
    expect((result.message.ses_1[0]?.time as { completed?: number } | undefined)?.completed).toBe(2)
    expect(result.messagesChanged).toBe(true)
  })

  test("does not reopen terminal assistant and tool state from a stale snapshot", () => {
    const completedMessage = {
      ...message("msg_1"),
      finish: "stop",
      time: { created: 1, completed: 3 },
    } as Message
    const completedTool = {
      id: "prt_tool",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        time: { start: 1, end: 2 },
        output: "fresh output",
      },
    } as unknown as Part
    const staleMessage = message("msg_1")
    const staleTool = {
      id: "prt_tool",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "read",
      state: {
        status: "running",
        time: { start: 1 },
      },
    } as unknown as Part
    const state = {
      message: { ses_1: [completedMessage] },
      part: { msg_1: [completedTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: staleMessage, parts: [staleTool] }],
    )

    expect(result.message.ses_1[0]).toBe(completedMessage)
    expect(result.part.msg_1[0]).toBe(completedTool)
    expect(result.messagesChanged).toBe(false)
    expect(result.partsChanged).toBe(false)
  })

  test("accepts forward progress from in-flight assistant and tool state", () => {
    const liveMessage = message("msg_1")
    const liveTool = {
      id: "prt_tool",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "read",
      state: { status: "running", time: { start: 1 } },
    } as unknown as Part
    const completedMessage = {
      ...liveMessage,
      finish: "stop",
      time: { created: 1, completed: 3 },
    } as Message
    const completedTool = {
      ...liveTool,
      state: {
        status: "completed",
        time: { start: 1, end: 2 },
        output: "fresh output",
      },
    } as unknown as Part

    const result = materializeSessionSnapshots(
      { message: { ses_1: [liveMessage] }, part: { msg_1: [liveTool] } },
      "ses_1",
      [{ info: completedMessage, parts: [completedTool] }],
    )

    expect(result.message.ses_1[0]).toBe(completedMessage)
    expect(result.part.msg_1[0]).toBe(completedTool)
    expect(result.messagesChanged).toBe(true)
    expect(result.partsChanged).toBe(true)
  })

  test("derives session diff totals from materialized user message summaries", () => {
    const existingSession = {
      id: "ses_1",
      title: "Fix services",
      time: { created: 1, updated: 1 },
    } as Session
    const summarizedUserMessage = {
      ...userMessage("msg_user"),
      summary: {
        diffs: [
          { file: "src/a.ts", additions: 5, deletions: 1 },
          { file: "src/b.ts", additions: 2, deletions: 3 },
        ],
      },
    } as Message

    const result = materializeSessionSnapshots(
      { session: [existingSession], message: {}, part: {} },
      "ses_1",
      [{ info: summarizedUserMessage, parts: [part("prt_user", "msg_user")] }],
    )

    expect(result.sessionsChanged).toBe(true)
    expect(result.session?.[0]?.summary).toEqual({ diffs: [{ additions: 7, deletions: 4 }] })
  })

  test("clears stale session diff totals when materialized messages have no scoped diffs", () => {
    const existingSession = {
      id: "ses_1",
      title: "Fix services",
      time: { created: 1, updated: 1 },
      summary: { additions: 95, deletions: 3, title: "stale workspace total" },
    } as unknown as Session

    const result = materializeSessionSnapshots(
      { session: [existingSession], message: {}, part: {} },
      "ses_1",
      [{ info: userMessage("msg_user"), parts: [part("prt_user", "msg_user")] }],
    )

    expect(result.sessionsChanged).toBe(true)
    expect(result.session?.[0]?.summary).toEqual({ title: "stale workspace total" })
  })

  test("skips non-rendered part types", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_patch", "msg_1", "patch"), part("prt_text", "msg_1")] }],
      { skipPartTypes: new Set(["patch"]) },
    )

    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_text"])
  })

  test("preserves server part order instead of sorting by part id", () => {
    const serverParts = [
      part("msg_1_assistant_text", "msg_1", "text", "summary"),
      part("msg_1_assistant_tool_b", "msg_1", "tool"),
      part("msg_1_assistant_reasoning", "msg_1", "reasoning", "thinking"),
      part("msg_1_assistant_tool_a", "msg_1", "tool"),
    ]

    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: serverParts }],
    )

    expect(result.part.msg_1.map((item) => item.id)).toEqual(serverParts.map((item) => item.id))
  })

  test("preserves newer live streaming text when a stale snapshot materializes", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const stalePart = part("prt_1", "msg_1", "text", "")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [stalePart] }],
    )

    expect(result.part.msg_1[0]).toBe(livePart)
    expect((result.part.msg_1[0] as { text?: string })?.text).toBe("First chunk ")
  })

  test("preserves live streaming parts omitted by a stale snapshot", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [] }],
    )

    expect(result.part.msg_1[0]).toBe(livePart)
  })

  test("appends omitted live streaming parts without reordering materialized parts", () => {
    const serverPart = part("msg_1_assistant_tool_b", "msg_1", "tool")
    const liveReasoning = part("msg_1_assistant_reasoning", "msg_1", "reasoning", "still thinking")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [serverPart, liveReasoning] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [serverPart] }],
    )

    expect(result.part.msg_1.map((item) => item.id)).toEqual([
      "msg_1_assistant_tool_b",
      "msg_1_assistant_reasoning",
    ])
  })

  test("does not preserve omitted optimistic user text parts beside server snapshot parts", () => {
    const optimisticPart = { id: "prt_optimistic", messageID: "msg_1", type: "text", text: "Hello" } as Part
    const serverPart = part("prt_server", "msg_1", "text", "Hello")
    const state = {
      message: { ses_1: [userMessage("msg_1")] },
      part: { msg_1: [optimisticPart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: userMessage("msg_1"), parts: [serverPart] }],
    )

    expect(result.part.msg_1).toEqual([serverPart])
  })

  test("filters server snapshots and cached messages hidden by revert state", () => {
    const state = {
      session: [{ id: "ses_1", title: "ses_1", time: { created: 1, updated: 1 }, revert: { messageID: "msg_2" } } as never],
      message: { ses_1: [userMessage("msg_1"), userMessage("msg_2"), message("msg_3")] },
      part: {
        msg_1: [part("prt_1", "msg_1")],
        msg_2: [part("prt_2", "msg_2")],
        msg_3: [part("prt_3", "msg_3")],
      },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [
        { info: userMessage("msg_2"), parts: [part("prt_2_server", "msg_2")] },
        { info: message("msg_3"), parts: [part("prt_3_server", "msg_3")] },
      ],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.part.msg_2).toBe(undefined)
    expect(result.part.msg_3).toBe(undefined)
  })
})

describe("getSessionMaterializationStatus", () => {
  test("requires assistant parts for renderable cached state", () => {
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: false,
      missingPartMessageIDs: ["msg_1"],
    })
  })

  test("treats user-only cached state as renderable", () => {
    const state = {
      message: { ses_1: [{ ...message("msg_1"), role: "user" } as Message] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })
})
