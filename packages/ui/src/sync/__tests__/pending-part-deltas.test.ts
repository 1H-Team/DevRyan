import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2/client"
import {
  addPendingPartDelta,
  applyPendingPartDeltasToParts,
  buildProvisionalPartFromPendingDeltas,
  clearPartTypeHintsForDirectory,
  consumePendingPartDeltas,
  getPartTypeHint,
  recordPartTypeHintFromEvent,
  type PartTypeHintStore,
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

describe("buildProvisionalPartFromPendingDeltas", () => {
  test("folds ordered text deltas into a provisional text part", () => {
    const store: PendingPartDeltaStore = new Map()
    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "Hello ",
    }, 1)
    addPendingPartDelta(store, "/repo", {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "world",
    }, 2)

    const pending = consumePendingPartDeltas(store, "/repo", "msg_1", "prt_1", 3)
    const part = buildProvisionalPartFromPendingDeltas("msg_1", "prt_1", "ses_1", pending)

    expect(part).not.toBeNull()
    const shaped = part as unknown as {
      id: string
      messageID: string
      sessionID: string
      type: string
      text: string
      __provisionalFromDelta: boolean
    }
    expect(shaped.id).toBe("prt_1")
    expect(shaped.messageID).toBe("msg_1")
    expect(shaped.sessionID).toBe("ses_1")
    expect(shaped.type).toBe("text")
    expect(shaped.text).toBe("Hello world")
    expect(shaped.__provisionalFromDelta).toBe(true)
  })

  test("returns null for non-text fields so those deltas keep buffering", () => {
    const pending = [{
      messageID: "msg_1",
      partID: "prt_1",
      field: "output",
      delta: "tool chunk",
      updatedAt: 1,
    }]
    expect(buildProvisionalPartFromPendingDeltas("msg_1", "prt_1", "ses_1", pending)).toBeNull()
  })

  test("returns null when the folded text is empty", () => {
    expect(buildProvisionalPartFromPendingDeltas("msg_1", "prt_1", "ses_1", [])).toBeNull()
  })

  test("builds a reasoning part when the type hint says the deltas are reasoning", () => {
    const pending = [{
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "Considering LiveKit vs raw WebRTC for bookings",
      updatedAt: 1,
    }]
    const part = buildProvisionalPartFromPendingDeltas("msg_1", "prt_1", "ses_1", pending, "reasoning")

    const shaped = part as unknown as { type: string; text: string; __provisionalFromDelta: boolean }
    expect(shaped.type).toBe("reasoning")
    expect(shaped.text).toBe("Considering LiveKit vs raw WebRTC for bookings")
    expect(shaped.__provisionalFromDelta).toBe(true)
  })

  test("returns null when the type hint is neither text nor reasoning", () => {
    const pending = [{
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "partial tool payload",
      updatedAt: 1,
    }]
    expect(buildProvisionalPartFromPendingDeltas("msg_1", "prt_1", "ses_1", pending, "tool")).toBeNull()
  })
})

describe("part type hints", () => {
  const partUpdatedEvent = (partID: string, type: string) => ({
    type: "message.part.updated",
    properties: { part: { id: partID, messageID: "msg_1", sessionID: "ses_1", type } },
  }) as never

  test("records the announced type from a part.updated event and serves it back", () => {
    const store: PartTypeHintStore = new Map()
    recordPartTypeHintFromEvent(store, "/repo", partUpdatedEvent("prt_1", "reasoning"), 1)

    expect(getPartTypeHint(store, "/repo", "prt_1", 2)).toBe("reasoning")
    expect(getPartTypeHint(store, "/other", "prt_1", 2)).toBe(undefined)
    expect(getPartTypeHint(store, "/repo", "prt_2", 2)).toBe(undefined)
  })

  test("ignores non-part events, global directories, and shapeless payloads", () => {
    const store: PartTypeHintStore = new Map()
    recordPartTypeHintFromEvent(store, "global", partUpdatedEvent("prt_1", "reasoning"), 1)
    recordPartTypeHintFromEvent(store, "/repo", { type: "message.updated", properties: {} } as never, 1)
    recordPartTypeHintFromEvent(store, "/repo", { type: "message.part.updated", properties: { part: { id: "prt_1" } } } as never, 1)

    expect(store.size).toBe(0)
  })

  test("expires hints past their TTL and clears them per directory", () => {
    const store: PartTypeHintStore = new Map()
    recordPartTypeHintFromEvent(store, "/repo", partUpdatedEvent("prt_1", "reasoning"), 1)
    expect(getPartTypeHint(store, "/repo", "prt_1", 400_000)).toBe(undefined)

    recordPartTypeHintFromEvent(store, "/repo", partUpdatedEvent("prt_2", "text"), 400_001)
    clearPartTypeHintsForDirectory(store, "/repo")
    expect(getPartTypeHint(store, "/repo", "prt_2", 400_002)).toBe(undefined)
  })
})
