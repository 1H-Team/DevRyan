import { beforeEach, describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { registerManualAbortGuard, resetAbortGuardState } from "./abort-retry-guard"
import { INITIAL_STATE, type State } from "./types"
import { settleStreamingSessions, updateStreamingState, useStreamingStore } from "./streaming"

const message = (id: string, role: "user" | "assistant", completed?: number): Message => ({
  id,
  role,
  time: completed === undefined ? { created: 1 } : { created: 1, completed },
} as unknown as Message)

const terminalAssistantMessage = (id: string, finish: string): Message => ({
  id,
  role: "assistant",
  finish,
  time: { created: 1 },
} as unknown as Message)

const completedToolCallsAssistantMessage = (id: string): Message => ({
  id,
  role: "assistant",
  finish: "tool-calls",
  time: { created: 1, completed: 2 },
} as unknown as Message)

const toolPart = (messageID: string, status = "completed"): Part => ({
  id: `${messageID}_tool`,
  sessionID: "ses_1",
  messageID,
  type: "tool",
  tool: "write",
  state: {
    status,
    time: status === "completed" ? { start: 1, end: 2 } : { start: 1 },
  },
} as unknown as Part)

const stateWithMessages = (
  messages: Message[],
  status: SessionStatus = { type: "busy" } as SessionStatus,
  part: State["part"] = {},
): State => ({
  ...INITIAL_STATE,
  session_status: {
    ses_1: status,
  },
  message: {
    ses_1: messages,
  },
  part,
})

describe("updateStreamingState", () => {
  beforeEach(() => {
    resetAbortGuardState()
    useStreamingStore.setState({
      streamingMessageIds: new Map(),
      messageStreamStates: new Map(),
    })
  })

  test("does not mark a previous assistant message as streaming during a new user turn", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
    ]))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("tracks the trailing assistant message once it appears", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
      message("msg_assistant_2", "assistant"),
    ]))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_2")
  })

  test("keeps an active streaming message through a premature idle status", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ], { type: "idle" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("streaming")
  })

  test("keeps a tracked active assistant stream through repeated transient idle statuses", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ], { type: "idle" } as SessionStatus))
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ], { type: "idle" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("streaming")
  })

  test("completes a tracked assistant stream when guarded idle follows a manual retry abort", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    registerManualAbortGuard("ses_1")
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ], { type: "idle" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("completes a tracked assistant stream when a new user turn becomes trailing after idle", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
    ], { type: "idle" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("completes the streaming message when idle arrives after message completion", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant", 2),
    ], { type: "idle" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("completes the streaming message when delayed busy status points at a terminal assistant message", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      terminalAssistantMessage("msg_assistant_1", "cancelled"),
    ], { type: "busy" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("keeps intermediate tool-call assistant finishes streaming while the session remains busy", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      terminalAssistantMessage("msg_assistant_1", "tool-calls"),
    ], { type: "busy" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("streaming")
  })

  test("keeps a completed tool-call assistant streaming through idle while its tool is running", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      completedToolCallsAssistantMessage("msg_assistant_1"),
    ], { type: "idle" } as SessionStatus, {
      msg_assistant_1: [toolPart("msg_assistant_1", "running")],
    }))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("streaming")
  })

  test("completes a tool-call assistant stream after its tool finalizes and status is idle", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      completedToolCallsAssistantMessage("msg_assistant_1"),
    ], { type: "idle" } as SessionStatus, {
      msg_assistant_1: [toolPart("msg_assistant_1", "completed")],
    }))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("keeps a completed tool-call assistant streaming between tools while status is busy", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      completedToolCallsAssistantMessage("msg_assistant_1"),
    ], { type: "busy" } as SessionStatus, {
      msg_assistant_1: [toolPart("msg_assistant_1", "completed")],
    }))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("streaming")
  })

  test("does not replace a tool-call assistant with a trailing empty assistant shell", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      terminalAssistantMessage("msg_assistant_1", "tool-calls"),
      message("msg_assistant_empty", "assistant"),
    ], { type: "busy" } as SessionStatus, {
      msg_assistant_1: [toolPart("msg_assistant_1")],
      msg_assistant_empty: [],
    }))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("streaming")
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_empty")).toBe(undefined)
  })

  test("completes the streaming message when idle arrives after a terminal finish", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      terminalAssistantMessage("msg_assistant_1", "stop"),
    ], { type: "idle" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("uses trailing incomplete assistant as a narrow fallback when status is missing", () => {
    updateStreamingState({
      ...INITIAL_STATE,
      session_status: {},
      message: {
        ses_1: [
          message("msg_user_1", "user"),
          message("msg_assistant_1", "assistant"),
        ],
      },
    })

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")
  })

  test("does not override explicit idle status with the incomplete-assistant fallback", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ], { type: "idle" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe(undefined)
  })

  test("settles a tracked stream when bootstrap authoritatively materializes idle", () => {
    updateStreamingState({
      ...INITIAL_STATE,
      session_status: {},
      message: {
        ses_1: [
          message("msg_user_1", "user"),
          message("msg_assistant_1", "assistant"),
        ],
      },
    })
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    settleStreamingSessions(["ses_1"], 123)

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.completedAt).toBe(123)
  })
})
