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

describe("mergeOptimisticPage: an optimistic message whose page parts already hold every optimistic part", () => {
  test("keeps the page's parts in order and appends nothing", () => {
    const pageParts = [part("prt_a", "msg_2"), part("prt_b", "msg_2")]
    const optimisticMessage = message("msg_2", "user")
    // The page holds parts for msg_2 but not the message itself, so the optimistic message is inserted.
    const result = mergeOptimisticPage(
      { session: [message("msg_1")], part: [{ id: "msg_2", part: pageParts }], complete: true },
      [{ message: optimisticMessage, parts: [part("prt_b", "msg_2"), part("prt_a", "msg_2")] }],
    )

    expect(result.confirmed).toEqual([])
    expect(result.session[1]).toBe(optimisticMessage)
    const merged = result.part.find((item) => item.id === "msg_2")?.part
    expect(merged).toHaveLength(2)
    expect(merged?.[0]).toBe(pageParts[0])
    expect(merged?.[1]).toBe(pageParts[1])
    // The page's array is filtered into a new one before the merge.
    expect(merged).not.toBe(pageParts)
  })

  test("appends only the optimistic parts whose ids are new, after the page's parts", () => {
    const pageParts = [part("prt_a", "msg_2")]
    const fresh = part("prt_c", "msg_2")
    const result = mergeOptimisticPage(
      { session: [], part: [{ id: "msg_2", part: pageParts }], complete: false, cursor: "cur" },
      [{ message: message("msg_2", "user"), parts: [part("prt_a", "msg_2"), fresh, part("prt_c", "msg_2")] }],
    )

    const merged = result.part.find((item) => item.id === "msg_2")?.part
    expect(merged?.map((item) => item.id)).toEqual(["prt_a", "prt_c"])
    expect(merged?.[1]).toBe(fresh)
    expect(result.cursor).toBe("cur")
    expect(result.complete).toBe(false)
  })

  test("returns the page with its cursor, completeness and arrays, and an empty confirmed list, when there are no optimistic items", () => {
    const page = { session: [message("msg_1")], part: [{ id: "msg_1", part: [part("prt_a", "msg_1")] }], cursor: "cur_1", complete: false }
    const result = mergeOptimisticPage(page, [])

    expect(result.cursor).toBe("cur_1")
    expect(result.complete).toBe(false)
    expect(result.confirmed).toEqual([])
    expect(result.session).toBe(page.session)
    expect(result.part).toBe(page.part)
  })
})

describe("mergeOptimisticPage: a page holding two part lists for one message", () => {
  test("keeps the later list", () => {
    const earlier = part("prt_old", "msg_1")
    const later = part("prt_new", "msg_1")
    const result = mergeOptimisticPage(
      {
        session: [message("msg_1")],
        part: [{ id: "msg_1", part: [earlier] }, { id: "msg_1", part: [later] }],
        complete: true,
      },
      [{ message: message("msg_2", "user"), parts: [part("prt_user", "msg_2")] }],
    )

    const kept = result.part.find((item) => item.id === "msg_1")?.part
    expect(kept).toHaveLength(1)
    expect(kept?.[0]).toBe(later)
  })
})
