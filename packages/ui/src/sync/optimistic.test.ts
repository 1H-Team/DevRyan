import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { mergeOptimisticPage } from "./optimistic"

function message(id: string, role: Message["role"] = "assistant"): Message {
  return { id, sessionID: "ses_1", role, time: { created: 1 } } as Message
}

function part(id: string, messageID: string, type = "text"): Part {
  return { id, messageID, sessionID: "ses_1", type, text: id } as Part
}

describe("mergeOptimisticPage", () => {
  test("confirms an echoed message without re-merging client-only part IDs", () => {
    const serverMessage = message("msg_1", "user")
    const serverPart = part("prt_server", "msg_1")
    const optimisticPart = part("prt_client", "msg_1")

    const result = mergeOptimisticPage(
      {
        session: [serverMessage],
        part: [{ id: "msg_1", part: [serverPart] }],
        complete: true,
      },
      [{
        message: message("msg_1", "user"),
        parts: [optimisticPart],
      }],
    )

    expect(result.confirmed).toEqual(["msg_1"])
    expect(result.session).toEqual([serverMessage])
    expect(result.part).toEqual([{ id: "msg_1", part: [serverPart] }])
  })

  test("preserves fetched server part order while merging optimistic messages", () => {
    const serverParts = [
      part("msg_1_assistant_text", "msg_1", "text"),
      part("msg_1_assistant_tool_b", "msg_1", "tool"),
      part("msg_1_assistant_reasoning", "msg_1", "reasoning"),
      part("msg_1_assistant_tool_a", "msg_1", "tool"),
    ]

    const result = mergeOptimisticPage(
      {
        session: [message("msg_1")],
        part: [{ id: "msg_1", part: serverParts }],
        complete: true,
      },
      [{
        message: message("msg_2", "user"),
        parts: [part("msg_2_user_text", "msg_2", "text")],
      }],
    )

    expect(result.part.find((item) => item.id === "msg_1")?.part.map((item) => item.id)).toEqual(
      serverParts.map((item) => item.id),
    )
    expect(result.session.map((item) => item.id)).toEqual(["msg_1", "msg_2"])
    expect(result.part.find((item) => item.id === "msg_2")?.part.map((item) => item.id)).toEqual([
      "msg_2_user_text",
    ])
    expect(result.confirmed).toEqual([])
  })
})
