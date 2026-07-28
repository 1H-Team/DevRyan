import { describe, expect, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { resolveSessionActivityState } from "./useSessionActivity"

const incompleteAssistant = {
  id: "msg_assistant",
  role: "assistant",
  time: { created: 1 },
} as Message

const cancelledAssistant = {
  id: "msg_assistant_cancelled",
  role: "assistant",
  finish: "cancelled",
  time: { created: 1 },
} as unknown as Message

const toolCallsAssistant = {
  id: "msg_assistant_tool_calls",
  role: "assistant",
  finish: "tool-calls",
  time: { created: 1 },
} as unknown as Message

describe("resolveSessionActivityState", () => {
  test("treats an actionable provider recovery as stopped despite stale live state", () => {
    expect(resolveSessionActivityState({
      sessionId: "session-1",
      status: { type: "busy" },
      messages: [incompleteAssistant],
      permissions: [],
      liveStreamingMessageId: "msg_assistant",
      hasProviderRecovery: true,
    })).toEqual({
      phase: "idle",
      isWorking: false,
      isBusy: false,
      isCooldown: false,
    })
  })

  test("returns busy for a directory-specific busy status", () => {
    const result = resolveSessionActivityState({
      sessionId: "session-child",
      status: { type: "busy" } as SessionStatus,
      messages: [],
      permissions: [],
    })

    expect(result.phase).toBe("busy")
    expect(result.isWorking).toBe(true)
    expect(result.isBusy).toBe(true)
  })

  test("falls back to a trailing incomplete assistant message when status is missing", () => {
    const result = resolveSessionActivityState({
      sessionId: "session-child",
      status: undefined,
      messages: [incompleteAssistant],
      permissions: [],
    })

    expect(result.phase).toBe("busy")
    expect(result.isWorking).toBe(true)
  })

  test("authoritative idle wins over stale incomplete assistant history", () => {
    const result = resolveSessionActivityState({
      sessionId: "session-child",
      status: { type: "idle" } as SessionStatus,
      messages: [incompleteAssistant],
      permissions: [],
    })

    expect(result.phase).toBe("idle")
    expect(result.isWorking).toBe(false)
  })

  test("keeps delayed busy status active until sync settlement", () => {
    const result = resolveSessionActivityState({
      sessionId: "session-child",
      status: { type: "busy" } as SessionStatus,
      messages: [cancelledAssistant],
      permissions: [],
      liveStreamingMessageId: "msg_assistant_cancelled",
    })

    expect(result.phase).toBe("busy")
    expect(result.isWorking).toBe(true)
  })

  test("intermediate tool-call finish remains busy while status is busy", () => {
    const result = resolveSessionActivityState({
      sessionId: "session-child",
      status: { type: "busy" } as SessionStatus,
      messages: [toolCallsAssistant],
      permissions: [],
      liveStreamingMessageId: "msg_assistant_tool_calls",
    })

    expect(result.phase).toBe("busy")
    expect(result.isWorking).toBe(true)
  })

  test("ignores stale incomplete assistant history when a later assistant message completed", () => {
    const completedAssistant = {
      id: "msg_assistant_done",
      role: "assistant",
      time: { created: 1, completed: 2 },
    } as Message

    const result = resolveSessionActivityState({
      sessionId: "session-child",
      status: undefined,
      messages: [incompleteAssistant, completedAssistant],
      permissions: [],
    })

    expect(result.phase).toBe("idle")
    expect(result.isWorking).toBe(false)
  })
})
