import { describe, expect, test } from "bun:test"
import { classifyAssistantError, classifySteeredAbortFallback } from "./assistantError"

describe("classifyAssistantError", () => {
  test("classifies local manual aborts without renderable stopped copy", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      manualAbortMessageId: "msg-assistant",
      messageId: "msg-assistant",
    })).toEqual({
      text: "",
      variant: "plain",
      abortKind: "manual",
    })
  })

  test("classifies direct steering aborts with visible steered copy", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      steeredAbortMessageId: "msg-assistant",
      messageId: "msg-assistant",
    })).toEqual({
      text: "Steered conversation",
      variant: "info",
      abortKind: "steered",
    })
  })

  test("classifies steered aborts even when the assistant message has no error payload", () => {
    expect(classifySteeredAbortFallback({
      steeredAbortMessageId: "msg-assistant",
      messageId: "msg-assistant",
    })).toEqual({
      text: "Steered conversation",
      variant: "info",
      abortKind: "steered",
    })
  })

  test("treats aborted errors for a different trailing message as unexpected aborts", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      manualAbortMessageId: "msg-previous-assistant",
      messageId: "msg-next-assistant",
      isLatestMessage: true,
    })).toEqual({
      text: "The turn stopped before completion. Reconnecting session state…",
      variant: "info",
      abortKind: "unexpected",
    })
  })

  test("does not surface historical uncorrelated aborted messages", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      manualAbortMessageId: "msg-previous-assistant",
      messageId: "msg-next-assistant",
      isLatestMessage: false,
    })).toBe(undefined)
  })
})
