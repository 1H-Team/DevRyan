import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  hasInFlightToolParts,
  hasTerminalAssistantFinish,
  hasToolCallAssistantFinish,
  hasVisibleAssistantSummary,
  isAssistantTurnComplete,
  isFinalAssistantSummaryMessage,
  isIncompleteAssistantMessage,
  isLiveAssistantMessage,
} from "./session-working"

// Fixtures carry fields the SDK message type does not declare (finish, status,
// streaming) and malformed values the predicates are meant to tolerate.
function assistant(fields: Record<string, unknown> = {}): Message {
  return {
    id: "msg_a",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1 },
    ...fields,
  } as unknown as Message
}

function user(fields: Record<string, unknown> = {}): Message {
  return {
    id: "msg_u",
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    ...fields,
  } as unknown as Message
}

function toolPart(id: string, state?: Record<string, unknown> | null): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_a",
    type: "tool",
    tool: "bash",
    ...(state === undefined ? {} : { state }),
  } as unknown as Part
}

function textLikePart(id: string, type: string, fields: Record<string, unknown>): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_a",
    type,
    ...fields,
  } as unknown as Part
}

describe("hasTerminalAssistantFinish", () => {
  test("is false without an assistant message", () => {
    expect(hasTerminalAssistantFinish(undefined)).toBe(false)
    expect(hasTerminalAssistantFinish(user({ finish: "stop" }))).toBe(false)
  })

  test("is false when finish is missing, not a string or blank", () => {
    expect(hasTerminalAssistantFinish(assistant())).toBe(false)
    expect(hasTerminalAssistantFinish(assistant({ finish: 1 }))).toBe(false)
    expect(hasTerminalAssistantFinish(assistant({ finish: null }))).toBe(false)
    expect(hasTerminalAssistantFinish(assistant({ finish: true }))).toBe(false)
    expect(hasTerminalAssistantFinish(assistant({ finish: "" }))).toBe(false)
    expect(hasTerminalAssistantFinish(assistant({ finish: " \t\n" }))).toBe(false)
    expect(hasTerminalAssistantFinish(assistant({ finish: "\u00a0" }))).toBe(false)
  })

  test("is false for tool-calls in any case and with surrounding whitespace", () => {
    expect(hasTerminalAssistantFinish(assistant({ finish: "tool-calls" }))).toBe(false)
    expect(hasTerminalAssistantFinish(assistant({ finish: "  TOOL-CALLS  " }))).toBe(false)
  })

  test("is true for every other non-blank finish, including tool-call spellings that are not normalized", () => {
    for (const finish of ["stop", "length", "error", "unknown", "STOP", " stop ", "tool_calls", "toolcalls", "tool-calls.", "\u200b", "\ud800"]) {
      expect(hasTerminalAssistantFinish(assistant({ finish }))).toBe(true)
    }
  })

  test("does not look at the completed timestamp", () => {
    expect(hasTerminalAssistantFinish(assistant({ time: { created: 1, completed: 2 } }))).toBe(false)
  })
})

describe("hasToolCallAssistantFinish", () => {
  test("is true only for an assistant whose trimmed, lowercased finish is tool-calls", () => {
    expect(hasToolCallAssistantFinish(assistant({ finish: "tool-calls" }))).toBe(true)
    expect(hasToolCallAssistantFinish(assistant({ finish: " Tool-Calls\n" }))).toBe(true)
    expect(hasToolCallAssistantFinish(assistant({ finish: "tool_calls" }))).toBe(false)
    expect(hasToolCallAssistantFinish(assistant({ finish: "tool-call" }))).toBe(false)
    expect(hasToolCallAssistantFinish(assistant({ finish: "stop" }))).toBe(false)
    expect(hasToolCallAssistantFinish(assistant({ finish: "" }))).toBe(false)
    expect(hasToolCallAssistantFinish(assistant({ finish: 0 }))).toBe(false)
    expect(hasToolCallAssistantFinish(assistant())).toBe(false)
  })

  test("is false for a user message or no message", () => {
    expect(hasToolCallAssistantFinish(user({ finish: "tool-calls" }))).toBe(false)
    expect(hasToolCallAssistantFinish(undefined)).toBe(false)
  })
})

describe("isAssistantTurnComplete", () => {
  test("is false for a user message or no message", () => {
    expect(isAssistantTurnComplete(undefined)).toBe(false)
    expect(isAssistantTurnComplete(user({ time: { created: 1, completed: 2 }, status: "done" }))).toBe(false)
  })

  test("streaming true wins over every completion signal", () => {
    expect(isAssistantTurnComplete(assistant({
      streaming: true,
      status: "completed",
      finish: "stop",
      time: { created: 1, completed: 2 },
    }))).toBe(false)
  })

  test("a streaming value other than true is ignored", () => {
    expect(isAssistantTurnComplete(assistant({ streaming: "true", finish: "stop" }))).toBe(true)
    expect(isAssistantTurnComplete(assistant({ streaming: 1, finish: "stop" }))).toBe(true)
    expect(isAssistantTurnComplete(assistant({ streaming: false }))).toBe(false)
  })

  test("a running, pending or streaming status is incomplete even with a completed timestamp", () => {
    for (const status of ["running", "pending", "streaming", " RUNNING ", "Pending"]) {
      expect(isAssistantTurnComplete(assistant({
        status,
        finish: "stop",
        time: { created: 1, completed: 2 },
      }))).toBe(false)
    }
  })

  test("a complete, completed or done status is complete without other signals", () => {
    for (const status of ["complete", "completed", "done", " DONE "]) {
      expect(isAssistantTurnComplete(assistant({ status }))).toBe(true)
    }
    expect(isAssistantTurnComplete(assistant({ status: "done", finish: "tool-calls" }))).toBe(true)
  })

  test("any other status falls back to the terminal checks", () => {
    expect(isAssistantTurnComplete(assistant({ status: "in_progress" }))).toBe(false)
    expect(isAssistantTurnComplete(assistant({ status: "in_progress", finish: "stop" }))).toBe(true)
    expect(isAssistantTurnComplete(assistant({ status: "error" }))).toBe(false)
    expect(isAssistantTurnComplete(assistant({ status: "", time: { created: 1, completed: 3 } }))).toBe(true)
    expect(isAssistantTurnComplete(assistant({ status: 5, finish: "stop" }))).toBe(true)
    expect(isAssistantTurnComplete(assistant({ status: 5 }))).toBe(false)
  })

  test("a completed timestamp counts only when it is a positive finite number", () => {
    expect(isAssistantTurnComplete(assistant({ time: { created: 1, completed: 1 } }))).toBe(true)
    expect(isAssistantTurnComplete(assistant({ time: { created: 1, completed: 0.5 } }))).toBe(true)
    expect(isAssistantTurnComplete(assistant({ time: { created: 1, completed: Number.MAX_VALUE } }))).toBe(true)
    for (const completed of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, "2", null]) {
      expect(isAssistantTurnComplete(assistant({ time: { created: 1, completed } }))).toBe(false)
    }
    expect(isAssistantTurnComplete(assistant({ time: undefined }))).toBe(false)
  })

  test("a terminal finish completes the turn without a timestamp, a tool-calls finish does not", () => {
    expect(isAssistantTurnComplete(assistant({ finish: "stop" }))).toBe(true)
    expect(isAssistantTurnComplete(assistant({ finish: "tool-calls" }))).toBe(false)
    expect(isAssistantTurnComplete(assistant({ finish: "tool-calls", time: { created: 1, completed: 2 } }))).toBe(true)
  })
})

describe("isIncompleteAssistantMessage", () => {
  test("is the negation of turn completion for assistant messages only", () => {
    expect(isIncompleteAssistantMessage(undefined)).toBe(false)
    expect(isIncompleteAssistantMessage(user())).toBe(false)
    expect(isIncompleteAssistantMessage(assistant())).toBe(true)
    expect(isIncompleteAssistantMessage(assistant({ finish: "tool-calls" }))).toBe(true)
    expect(isIncompleteAssistantMessage(assistant({ streaming: true, finish: "stop" }))).toBe(true)
    expect(isIncompleteAssistantMessage(assistant({ finish: "stop" }))).toBe(false)
    expect(isIncompleteAssistantMessage(assistant({ status: "done" }))).toBe(false)
  })
})

describe("hasInFlightToolParts", () => {
  test("is false for no parts and for parts that are not tools", () => {
    expect(hasInFlightToolParts(undefined)).toBe(false)
    expect(hasInFlightToolParts([])).toBe(false)
    expect(hasInFlightToolParts([
      textLikePart("p1", "text", { text: "hi" }),
      textLikePart("p2", "reasoning", { text: "think", state: { status: "running" } }),
      textLikePart("p3", "step-start", { state: { status: "running" } }),
    ])).toBe(false)
  })

  test("a running tool or a tool without an end and with an unknown status is in flight", () => {
    expect(hasInFlightToolParts([toolPart("t1", { status: "running", time: { start: 1 } })])).toBe(true)
    expect(hasInFlightToolParts([toolPart("t1", { status: "pending" })])).toBe(true)
    expect(hasInFlightToolParts([toolPart("t1", { status: "queued" })])).toBe(true)
  })

  test("a tool part with no state or a null state is in flight", () => {
    expect(hasInFlightToolParts([toolPart("t1")])).toBe(true)
    expect(hasInFlightToolParts([toolPart("t1", null)])).toBe(true)
  })

  test("a finished tool is not in flight, by final status or by end time", () => {
    expect(hasInFlightToolParts([toolPart("t1", { status: "completed" })])).toBe(false)
    expect(hasInFlightToolParts([toolPart("t1", { status: "error", time: { start: 1, end: 2 } })])).toBe(false)
    expect(hasInFlightToolParts([toolPart("t1", { status: "running", time: { start: 1, end: 2 } })])).toBe(false)
  })

  test("a final status with an end before its start is not in flight", () => {
    expect(hasInFlightToolParts([toolPart("t1", { status: "completed", time: { start: 5, end: 1 } })])).toBe(false)
  })

  test("a running status with an end before its start is still in flight", () => {
    expect(hasInFlightToolParts([toolPart("t1", { status: "running", time: { start: 5, end: 1 } })])).toBe(true)
  })

  test("any in-flight tool among finished ones makes the list in flight, wherever it sits", () => {
    const done = toolPart("t1", { status: "completed" })
    const live = toolPart("t2", { status: "running" })
    expect(hasInFlightToolParts([done, live])).toBe(true)
    expect(hasInFlightToolParts([live, done])).toBe(true)
    expect(hasInFlightToolParts([done, done])).toBe(false)
  })
})

describe("hasVisibleAssistantSummary", () => {
  test("is false for no parts", () => {
    expect(hasVisibleAssistantSummary(undefined)).toBe(false)
    expect(hasVisibleAssistantSummary([])).toBe(false)
  })

  test("a text or reasoning part with non-blank text is visible", () => {
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: "Done." })])).toBe(true)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "reasoning", { text: "  thinking  " })])).toBe(true)
  })

  test("blank text is not visible, Unicode whitespace included", () => {
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: "" })])).toBe(false)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: " \n\t" })])).toBe(false)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: "\u00a0\u2003\ufeff" })])).toBe(false)
  })

  test("characters trim does not remove count as visible", () => {
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: "\u200b" })])).toBe(true)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: "\ud800" })])).toBe(true)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: "\ud83d\ude00" })])).toBe(true)
  })

  test("a string output on a text or reasoning part is used when its text is blank or not a string", () => {
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: "  ", output: "result" })])).toBe(true)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "reasoning", { output: "result" })])).toBe(true)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: 3, output: " x " })])).toBe(true)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { text: "", output: "  " })])).toBe(false)
    expect(hasVisibleAssistantSummary([textLikePart("p1", "text", { output: 42 })])).toBe(false)
  })

  test("text on any other part type is ignored", () => {
    expect(hasVisibleAssistantSummary([
      textLikePart("p1", "tool", { text: "hello", output: "hello" }),
      textLikePart("p2", "step-finish", { text: "hello" }),
      textLikePart("p3", "file", { text: "hello" }),
    ])).toBe(false)
  })

  test("one visible part anywhere in the list is enough", () => {
    expect(hasVisibleAssistantSummary([
      textLikePart("p1", "text", { text: "" }),
      textLikePart("p2", "tool", { text: "x" }),
      textLikePart("p3", "reasoning", { text: "seen" }),
    ])).toBe(true)
  })
})

describe("isFinalAssistantSummaryMessage", () => {
  const visible = [textLikePart("p1", "text", { text: "All done." })]

  test("a complete assistant turn with visible text and no live tools is a final summary", () => {
    expect(isFinalAssistantSummaryMessage(assistant({ finish: "stop" }), visible)).toBe(true)
    expect(isFinalAssistantSummaryMessage(assistant({ time: { created: 1, completed: 2 } }), visible)).toBe(true)
    expect(isFinalAssistantSummaryMessage(assistant({ status: "done" }), [
      toolPart("t1", { status: "completed" }),
      ...visible,
    ])).toBe(true)
  })

  test("an incomplete turn, a missing message or a user message is not", () => {
    expect(isFinalAssistantSummaryMessage(assistant(), visible)).toBe(false)
    expect(isFinalAssistantSummaryMessage(assistant({ streaming: true, finish: "stop" }), visible)).toBe(false)
    expect(isFinalAssistantSummaryMessage(undefined, visible)).toBe(false)
    expect(isFinalAssistantSummaryMessage(user({ finish: "stop" }), visible)).toBe(false)
  })

  test("a completed tool-calls turn is not a final summary", () => {
    expect(isFinalAssistantSummaryMessage(
      assistant({ finish: "tool-calls", time: { created: 1, completed: 2 } }),
      visible,
    )).toBe(false)
    expect(isFinalAssistantSummaryMessage(assistant({ status: "completed", finish: "TOOL-CALLS" }), visible)).toBe(false)
  })

  test("a live tool part blocks the summary", () => {
    expect(isFinalAssistantSummaryMessage(assistant({ finish: "stop" }), [
      ...visible,
      toolPart("t1", { status: "running" }),
    ])).toBe(false)
  })

  test("a summary held only by a reasoning part counts", () => {
    expect(isFinalAssistantSummaryMessage(assistant({ finish: "stop" }), [
      textLikePart("p1", "text", { text: " " }),
      textLikePart("p2", "reasoning", { text: "Summary in reasoning." }),
    ])).toBe(true)
  })

  test("without visible text there is no summary", () => {
    expect(isFinalAssistantSummaryMessage(assistant({ finish: "stop" }))).toBe(false)
    expect(isFinalAssistantSummaryMessage(assistant({ finish: "stop" }), [])).toBe(false)
    expect(isFinalAssistantSummaryMessage(assistant({ finish: "stop" }), [textLikePart("p1", "text", { text: " " })])).toBe(false)
  })
})

describe("isLiveAssistantMessage", () => {
  test("is false for a missing or user message", () => {
    expect(isLiveAssistantMessage(undefined, [toolPart("t1", { status: "running" })])).toBe(false)
    expect(isLiveAssistantMessage(user(), [toolPart("t1", { status: "running" })])).toBe(false)
  })

  test("an incomplete assistant message is live whatever its parts", () => {
    expect(isLiveAssistantMessage(assistant())).toBe(true)
    expect(isLiveAssistantMessage(assistant(), [])).toBe(true)
    expect(isLiveAssistantMessage(assistant({ finish: "tool-calls" }))).toBe(true)
  })

  test("a completed tool-calls turn is live only while a tool part is in flight", () => {
    const toolCalls = assistant({ finish: "tool-calls", time: { created: 1, completed: 2 } })
    expect(isLiveAssistantMessage(toolCalls, [toolPart("t1", { status: "running" })])).toBe(true)
    expect(isLiveAssistantMessage(toolCalls, [toolPart("t1")])).toBe(true)
    expect(isLiveAssistantMessage(toolCalls, [toolPart("t1", { status: "completed" })])).toBe(false)
    expect(isLiveAssistantMessage(toolCalls, [])).toBe(false)
    expect(isLiveAssistantMessage(toolCalls)).toBe(false)
  })

  test("a completed turn with another finish is not live even with an in-flight tool part", () => {
    const stopped = assistant({ finish: "stop", time: { created: 1, completed: 2 } })
    expect(isLiveAssistantMessage(stopped, [toolPart("t1", { status: "running" })])).toBe(false)
    expect(isLiveAssistantMessage(assistant({ status: "done" }), [toolPart("t1", { status: "running" })])).toBe(false)
  })
})
