import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2/client"
import {
  addPendingPartDelta,
  applyPendingPartDeltasToParts,
  clearPendingPartDeltasForDirectory,
  hasPendingPartDeltasForMessages,
  type PendingPartDeltaStore,
} from "./pending-part-deltas"

const DIR = "/repo/project"

const seed = (): PendingPartDeltaStore => {
  const store: PendingPartDeltaStore = new Map()
  addPendingPartDelta(store, DIR, { messageID: "msgA", partID: "partX", field: "text", delta: "hello" }, 1_000)
  return store
}

describe("hasPendingPartDeltasForMessages", () => {
  test("true when a buffered delta targets one of the given messages", () => {
    expect(hasPendingPartDeltasForMessages(seed(), DIR, ["msgA"])).toBe(true)
    expect(hasPendingPartDeltasForMessages(seed(), DIR, new Set(["other", "msgA"]))).toBe(true)
  })

  test("false when no buffered delta targets the given messages", () => {
    expect(hasPendingPartDeltasForMessages(seed(), DIR, ["msgB"])).toBe(false)
  })

  test("false for a different directory (buffer is directory-scoped)", () => {
    expect(hasPendingPartDeltasForMessages(seed(), "/repo/other", ["msgA"])).toBe(false)
  })

  test("false for empty inputs / global directory / empty store", () => {
    expect(hasPendingPartDeltasForMessages(seed(), DIR, [])).toBe(false)
    expect(hasPendingPartDeltasForMessages(seed(), "global", ["msgA"])).toBe(false)
    expect(hasPendingPartDeltasForMessages(new Map(), DIR, ["msgA"])).toBe(false)
  })

  test("does not match a messageID that is only a substring of a buffered key segment", () => {
    // 'msg' must not match 'msgA' — split-based exact segment comparison.
    expect(hasPendingPartDeltasForMessages(seed(), DIR, ["msg"])).toBe(false)
  })

  test("clears one directory without touching another", () => {
    const store = seed()
    addPendingPartDelta(store, "/repo/other", {
      messageID: "msgB",
      partID: "partY",
      field: "text",
      delta: "world",
    }, 1_001)

    expect(clearPendingPartDeltasForDirectory(store, DIR)).toBe(1)
    expect(hasPendingPartDeltasForMessages(store, DIR, ["msgA"])).toBe(false)
    expect(hasPendingPartDeltasForMessages(store, "/repo/other", ["msgB"])).toBe(true)
    expect(store.size).toBe(1)
  })
})

describe("applyPendingPartDeltasToParts", () => {
  test("preserves semantic reasoning text while sanitizing assistant deltas", () => {
    const existing = [{
      id: "reasoning_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "reasoning",
      text: "",
    } as Part]
    const text = "The user requests to continue implementing the complete explanation."

    const result = applyPendingPartDeltasToParts(existing, "reasoning_1", [{
      messageID: "msg_1",
      partID: "reasoning_1",
      field: "text",
      delta: text,
      updatedAt: 1,
    }], { sanitizeAssistantText: true })

    expect((result.parts[0] as { text?: string }).text).toBe(text)
  })
})
