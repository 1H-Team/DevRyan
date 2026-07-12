import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2/client"
import {
  addPendingPartDelta,
  applyPendingPartDeltasToParts,
  consumePendingPartDeltas,
  type PendingPartDeltaStore,
} from "../pending-part-deltas"

const textPart = (text = ""): Part => ({
  id: "prt_1",
  messageID: "msg_1",
  sessionID: "ses_1",
  type: "text",
  text,
} as Part)

const reasoningPart = (text = ""): Part => ({
  id: "prt_1",
  messageID: "msg_1",
  sessionID: "ses_1",
  type: "reasoning",
  text,
} as Part)

describe("pending part deltas", () => {
  test("replays buffered text onto a later part update", () => {
    const store: PendingPartDeltaStore = new Map()

    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    }, 1)

    const pending = consumePendingPartDeltas(store, "/repo", "msg_1", "prt_1", 2)
    const result = applyPendingPartDeltasToParts([textPart()], "prt_1", pending)

    expect(result.applied).toBe(true)
    expect((result.parts[0] as { text?: string }).text).toBe("hello")
    expect(store.size).toBe(0)
  })

  test("dedupes overlap when the later part already contains buffered text", () => {
    const store: PendingPartDeltaStore = new Map()

    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    }, 1)

    const pending = consumePendingPartDeltas(store, "/repo", "msg_1", "prt_1", 2)
    const result = applyPendingPartDeltasToParts([textPart("hello")], "prt_1", pending)

    expect(result.applied).toBe(false)
    expect((result.parts[0] as { text?: string }).text).toBe("hello")
  })

  test("coalesces multiple buffered deltas for the same field", () => {
    const store: PendingPartDeltaStore = new Map()

    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hel",
    }, 1)
    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "lo",
    }, 2)

    const pending = consumePendingPartDeltas(store, "/repo", "msg_1", "prt_1", 3)
    const result = applyPendingPartDeltasToParts([textPart()], "prt_1", pending)

    expect(pending).toHaveLength(1)
    expect(result.applied).toBe(true)
    expect((result.parts[0] as { text?: string }).text).toBe("hello")
  })

  test("normalizes duplicate pending text deltas before materialization", () => {
    const store: PendingPartDeltaStore = new Map()
    const frame = "Continuing implementation: creating the hook and history section, then wiring them into the shell."

    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: frame,
    }, 1)
    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: `\n${frame}\n`,
    }, 2)

    expect(Array.from(store.values())[0]?.delta).toBe(`${frame}\n`)
  })

  test("strips internal diagnostics when replaying pending assistant text", () => {
    const diagnostic = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string. missing required: old_string | edit requires path, old_string, and new_string'
    const result = applyPendingPartDeltasToParts([textPart()], "prt_1", [{
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: `Continuing implementation.${diagnostic}`,
      updatedAt: 1,
    }], { sanitizeAssistantText: true })

    expect(result.applied).toBe(true)
    expect((result.parts[0] as { text?: string }).text).toBe("Continuing implementation.")
  })

  test("does not strip Cursor meta-looking prose when replaying pending assistant text", () => {
    const result = applyPendingPartDeltasToParts([textPart()], "prt_1", [{
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "The user wants to continue implementing the solution.\n\nFixing the broken section.",
      updatedAt: 1,
    }], { sanitizeAssistantText: true })

    expect(result.applied).toBe(true)
    expect((result.parts[0] as { text?: string }).text).toBe("The user wants to continue implementing the solution.\n\nFixing the broken section.")
  })

  test("preserves intent restatements when replaying pending assistant reasoning", () => {
    const result = applyPendingPartDeltasToParts([reasoningPart()], "prt_1", [{
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "The user requests to continue implementing the solution.\n\nThe hook has already been created.",
      updatedAt: 1,
    }], { sanitizeAssistantText: true })

    expect(result.applied).toBe(true)
    expect((result.parts[0] as { text?: string }).text).toBe("The user requests to continue implementing the solution.\n\nThe hook has already been created.")
  })

  test("preserves skill/action lines when replaying pending assistant reasoning", () => {
    const result = applyPendingPartDeltasToParts([reasoningPart()], "prt_1", [{
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "Exploring skills index I need to inspect the skills index.\n\nThe available skills are loaded from the runtime metadata.",
      updatedAt: 1,
    }], { sanitizeAssistantText: true })

    expect(result.applied).toBe(true)
    expect((result.parts[0] as { text?: string }).text).toBe("Exploring skills index I need to inspect the skills index.\n\nThe available skills are loaded from the runtime metadata.")
  })

  test("replays buffered reasoning text onto an initially empty live reasoning part", () => {
    const store: PendingPartDeltaStore = new Map()

    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "Inspecting the relevant files.",
    }, 1)

    const pending = consumePendingPartDeltas(store, "/repo", "msg_1", "prt_1", 2)
    const result = applyPendingPartDeltasToParts([
      { ...reasoningPart(), time: { start: 1 } } as Part,
    ], "prt_1", pending, { sanitizeAssistantText: true })

    expect(result.applied).toBe(true)
    expect((result.parts[0] as { text?: string }).text).toBe("Inspecting the relevant files.")
  })
})
