import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { decideTransientAutoRetry, didLiveSessionBecomeIdle } from "./transientAutoRetryDecision"

function makeUser(id: string): Message {
  return { id, sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
}

function makeAssistant(id: string, detail: string): Message {
  return {
    id,
    sessionID: "session-a",
    role: "assistant",
    time: { created: 2 },
    error: { name: "UnknownError", data: { message: detail } },
  } as unknown as Message
}

const defaultInput = {
  messages: [makeUser("user-1"), makeAssistant("assistant-error-1", '"Streaming response failed"')],
  queuedMessageCount: 0,
  blockingRequestCount: 0,
  observedActiveUserMessageId: "user-1",
}

describe("decideTransientAutoRetry", () => {
  test("allows one automatic attempt for a transient error in a user turn", () => {
    expect(decideTransientAutoRetry(defaultInput)).toEqual({
      anchorUserMessageId: "user-1",
      erroredMessageId: "assistant-error-1",
    })

    expect(decideTransientAutoRetry({
      ...defaultInput,
      attemptRecord: {
        anchorUserMessageId: "user-1",
        attempts: 1,
        attemptedErroredMessageIds: new Set(["assistant-error-1"]),
      },
    })).toBeNull()
  })

  test("resets eligibility when a new user turn becomes the anchor", () => {
    const messages = [
      ...defaultInput.messages,
      makeUser("user-2"),
      makeAssistant("assistant-error-2", "Upstream request failed"),
    ]

    expect(decideTransientAutoRetry({
      ...defaultInput,
      messages,
      observedActiveUserMessageId: "user-2",
      attemptRecord: {
        anchorUserMessageId: "user-1",
        attempts: 1,
        attemptedErroredMessageIds: new Set(["assistant-error-1"]),
      },
    })).toEqual({
      anchorUserMessageId: "user-2",
      erroredMessageId: "assistant-error-2",
    })
  })

  test("does not treat the automatic recovery message as a new user-authored turn", () => {
    const messages = [
      makeUser("user-1"),
      makeAssistant("assistant-error-1", "Streaming response failed"),
      makeUser("user-auto-retry"),
      makeAssistant("assistant-error-2", "Streaming response failed"),
    ]

    expect(decideTransientAutoRetry({
      ...defaultInput,
      messages,
      observedActiveUserMessageId: "user-auto-retry",
      attemptRecord: {
        anchorUserMessageId: "user-1",
        attempts: 1,
        attemptedErroredMessageIds: new Set(["assistant-error-1"]),
        recoveryUserMessageIds: new Set(["user-auto-retry"]),
      },
    })).toBeNull()
  })

  test("skips when queued messages or blocking requests own the idle transition", () => {
    expect(decideTransientAutoRetry({ ...defaultInput, queuedMessageCount: 1 })).toBeNull()
    expect(decideTransientAutoRetry({ ...defaultInput, blockingRequestCount: 1 })).toBeNull()
  })

  test("skips a historical error when the user turn that entered busy was rolled back", () => {
    expect(decideTransientAutoRetry({
      ...defaultInput,
      observedActiveUserMessageId: "rolled-back-user",
    })).toBeNull()
  })

  test("skips non-transient and non-assistant trailing messages", () => {
    expect(decideTransientAutoRetry({
      ...defaultInput,
      messages: [makeUser("user-1"), makeAssistant("assistant-error", "The model refused this request")],
    })).toBeNull()

    expect(decideTransientAutoRetry({
      ...defaultInput,
      messages: [makeUser("user-1")],
    })).toBeNull()
  })
})

describe("didLiveSessionBecomeIdle", () => {
  test("only accepts an observed busy or retry to idle transition", () => {
    expect(didLiveSessionBecomeIdle("busy", "idle")).toBe(true)
    expect(didLiveSessionBecomeIdle("retry", "idle")).toBe(true)
    expect(didLiveSessionBecomeIdle(undefined, "idle")).toBe(false)
    expect(didLiveSessionBecomeIdle("idle", "idle")).toBe(false)
    expect(didLiveSessionBecomeIdle("busy", "busy")).toBe(false)
  })
})
