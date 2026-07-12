import { describe, expect, test } from "bun:test"
import { isAbortableSessionPhase, shouldInterruptBeforeSubmit } from "./submitInterrupt"

describe("submit interrupt decision", () => {
  test("interrupts an explicit submit for a busy session", () => {
    expect(shouldInterruptBeforeSubmit({
      currentSessionId: "session-a",
      sessionPhase: "busy",
      queuedMessageCount: 0,
      queuedOnly: false,
    })).toBe(true)
  })

  test("interrupts a queued submit with queued messages for a busy session", () => {
    expect(shouldInterruptBeforeSubmit({
      currentSessionId: "session-a",
      sessionPhase: "busy",
      queuedMessageCount: 1,
      queuedOnly: true,
    })).toBe(true)
  })

  test("does not interrupt an explicit submit for a busy subtask session", () => {
    expect(shouldInterruptBeforeSubmit({
      currentSessionId: "session-child",
      sessionPhase: "busy",
      queuedMessageCount: 0,
      queuedOnly: false,
      isSubtaskSession: true,
    })).toBe(false)
  })

  test("does not interrupt a queued submit for a busy subtask session", () => {
    expect(shouldInterruptBeforeSubmit({
      currentSessionId: "session-child",
      sessionPhase: "busy",
      queuedMessageCount: 1,
      queuedOnly: true,
      isSubtaskSession: true,
    })).toBe(false)
  })

  test("does not interrupt an explicit submit for an idle session", () => {
    expect(shouldInterruptBeforeSubmit({
      currentSessionId: "session-a",
      sessionPhase: "idle",
      queuedMessageCount: 0,
      queuedOnly: false,
    })).toBe(false)
  })

  test("does not interrupt an explicit submit while a question is pending", () => {
    expect(shouldInterruptBeforeSubmit({
      currentSessionId: "session-a",
      sessionPhase: "question",
      queuedMessageCount: 0,
      queuedOnly: false,
    })).toBe(false)
  })

  test("does not interrupt without a current session", () => {
    expect(shouldInterruptBeforeSubmit({
      currentSessionId: null,
      sessionPhase: "busy",
      queuedMessageCount: 0,
      queuedOnly: false,
    })).toBe(false)
  })

  test("does not interrupt a queued-only call with no queued messages", () => {
    expect(shouldInterruptBeforeSubmit({
      currentSessionId: "session-a",
      sessionPhase: "busy",
      queuedMessageCount: 0,
      queuedOnly: true,
    })).toBe(false)
  })
})

describe("abortable session phase", () => {
  test("does not treat question prompts as abortable work", () => {
    expect(isAbortableSessionPhase("question")).toBe(false)
  })

  test("treats busy sessions as abortable work", () => {
    expect(isAbortableSessionPhase("busy")).toBe(true)
  })
})
