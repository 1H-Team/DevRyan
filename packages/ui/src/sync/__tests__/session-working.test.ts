import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { isSessionWorkingFromState } from "../session-working"

function assistantMessage(id: string, completed?: number): Message {
  return {
    id,
    role: "assistant",
    time: completed === undefined ? { created: 1 } : { created: 1, completed },
  } as Message
}

function terminalAssistantMessage(id: string, finish: string): Message {
  return {
    id,
    role: "assistant",
    finish,
    time: { created: 1 },
  } as unknown as Message
}

function completedToolCallsAssistantMessage(id: string): Message {
  return {
    id,
    role: "assistant",
    finish: "tool-calls",
    time: { created: 1, completed: 2 },
  } as unknown as Message
}

function toolPart(messageID: string, status: string): Part {
  return {
    id: `${messageID}_tool`,
    messageID,
    type: "tool",
    tool: "write",
    state: {
      status,
    },
  } as unknown as Part
}

describe("isSessionWorkingFromState", () => {
  test("trusts authoritative idle status over incomplete assistant messages", () => {
    expect(isSessionWorkingFromState({
      status: { type: "idle" } as SessionStatus,
      permissions: [],
      messages: [assistantMessage("msg_assistant_1")],
    })).toBe(false)
  })

  test("keeps a live streaming message working through a premature idle status", () => {
    expect(isSessionWorkingFromState({
      status: { type: "idle" } as SessionStatus,
      permissions: [],
      messages: [assistantMessage("msg_assistant_1")],
      liveStreamingMessageId: "msg_assistant_1",
    })).toBe(true)
  })

  test("keeps authoritative busy status working until sync settlement", () => {
    expect(isSessionWorkingFromState({
      status: { type: "busy" } as SessionStatus,
      permissions: [],
      messages: [terminalAssistantMessage("msg_assistant_1", "cancelled")],
      liveStreamingMessageId: "msg_assistant_1",
    })).toBe(true)

    expect(isSessionWorkingFromState({
      status: { type: "idle" } as SessionStatus,
      permissions: [],
      messages: [terminalAssistantMessage("msg_assistant_1", "stop")],
      liveStreamingMessageId: "msg_assistant_1",
    })).toBe(false)
  })

  test("keeps intermediate tool-call assistant finishes working while status is busy", () => {
    expect(isSessionWorkingFromState({
      status: { type: "busy" } as SessionStatus,
      permissions: [],
      messages: [terminalAssistantMessage("msg_assistant_1", "tool-calls")],
      liveStreamingMessageId: "msg_assistant_1",
    })).toBe(true)
  })

  test("keeps a completed tool-call assistant working through idle while its tool is in flight", () => {
    expect(isSessionWorkingFromState({
      status: { type: "idle" } as SessionStatus,
      permissions: [],
      messages: [completedToolCallsAssistantMessage("msg_assistant_1")],
      liveStreamingMessageId: "msg_assistant_1",
      liveParts: [toolPart("msg_assistant_1", "running")],
    })).toBe(true)
  })

  test("stops treating a completed tool-call assistant as working after its tool finalizes", () => {
    expect(isSessionWorkingFromState({
      status: { type: "idle" } as SessionStatus,
      permissions: [],
      messages: [completedToolCallsAssistantMessage("msg_assistant_1")],
      liveStreamingMessageId: "msg_assistant_1",
      liveParts: [toolPart("msg_assistant_1", "completed")],
    })).toBe(false)
  })

  test("does not treat a stale streaming id for another message as working", () => {
    expect(isSessionWorkingFromState({
      status: { type: "idle" } as SessionStatus,
      permissions: [],
      messages: [assistantMessage("msg_assistant_1")],
      liveStreamingMessageId: "msg_assistant_old",
    })).toBe(false)
  })

  test("uses incomplete assistant messages as a fallback when status is missing", () => {
    expect(isSessionWorkingFromState({
      status: undefined,
      permissions: [],
      messages: [assistantMessage("msg_assistant_1")],
    })).toBe(true)
  })

  test("ignores stale incomplete assistant history when a later assistant message completed", () => {
    expect(isSessionWorkingFromState({
      status: undefined,
      permissions: [],
      messages: [
        assistantMessage("msg_assistant_old"),
        assistantMessage("msg_assistant_new", 2),
      ],
    })).toBe(false)
  })

  test("returns true for authoritative working statuses", () => {
    expect(isSessionWorkingFromState({
      status: { type: "busy" } as SessionStatus,
      permissions: [],
      messages: [assistantMessage("msg_assistant_1", 2)],
    })).toBe(true)
  })

  test("lets pending permissions take priority over working indicators", () => {
    expect(isSessionWorkingFromState({
      status: { type: "busy" } as SessionStatus,
      permissions: [{}],
      messages: [assistantMessage("msg_assistant_1")],
      liveStreamingMessageId: "msg_assistant_1",
      liveParts: [toolPart("msg_assistant_1", "running")],
    })).toBe(false)
  })
})
