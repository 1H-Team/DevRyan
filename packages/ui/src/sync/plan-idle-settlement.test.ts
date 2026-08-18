import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE, type State } from "./types"
import { isSessionTurnSettledForCompletion } from "./plan-idle-settlement"

const SESSION_ID = "ses_1"
const USER_ID = "msg_1_user"
const PLAN_ASSISTANT_ID = "msg_2_assistant"

const userMessage = (id: string, created: number): Message => ({
  id,
  sessionID: SESSION_ID,
  role: "user",
  time: { created },
} as Message)

const assistantMessage = (id: string, created: number, completed?: number): Message => ({
  id,
  sessionID: SESSION_ID,
  role: "assistant",
  time: completed === undefined ? { created } : { created, completed },
} as Message)

const toolCallsAssistantMessage = (id: string, created: number, completed: number): Message => ({
  id,
  sessionID: SESSION_ID,
  role: "assistant",
  finish: "tool-calls",
  time: { created, completed },
} as unknown as Message)

const textPart = (messageID: string, text = "Completed work."): Part => ({
  id: `${messageID}_text`,
  sessionID: SESSION_ID,
  messageID,
  type: "text",
  text,
} as Part)

const toolPart = (messageID: string, status: "pending" | "running" | "completed"): Part => ({
  id: `${messageID}_tool`,
  sessionID: SESSION_ID,
  messageID,
  type: "tool",
  tool: "read",
  state: { status },
} as Part)

const buildState = (overrides: Partial<State> = {}): State => ({
  ...INITIAL_STATE,
  session_status: { [SESSION_ID]: { type: "busy" } as SessionStatus },
  message: {
    [SESSION_ID]: [
      userMessage(USER_ID, 1),
      assistantMessage(PLAN_ASSISTANT_ID, 2, 3),
    ],
  },
  part: { [PLAN_ASSISTANT_ID]: [textPart(PLAN_ASSISTANT_ID)] },
  ...overrides,
})

describe("isSessionTurnSettledForCompletion", () => {
  test("rejects completion while authoritative status is busy", () => {
    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState(),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)
  })

  test("rejects completion with pending or running tool parts", () => {
    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({
        session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
        part: { [PLAN_ASSISTANT_ID]: [textPart(PLAN_ASSISTANT_ID), toolPart(PLAN_ASSISTANT_ID, "pending")] },
      }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)

    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({
        session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
        part: { [PLAN_ASSISTANT_ID]: [textPart(PLAN_ASSISTANT_ID), toolPart(PLAN_ASSISTANT_ID, "running")] },
      }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)
  })

  test("rejects completion with pending permission or question blockers", () => {
    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({
        session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
        permission: { [SESSION_ID]: [{} as PermissionRequest] },
      }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)

    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({
        session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
        question: { [SESSION_ID]: [{} as QuestionRequest] },
      }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)
  })

  test("accepts idle status with a terminal trailing assistant", () => {
    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({
        session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
      }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(true)
  })

  test("rejects missing status even for a terminal trailing assistant without blockers", () => {
    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({ session_status: {} }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)

    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({
        session_status: {},
        message: {
          [SESSION_ID]: [
            userMessage(USER_ID, 1),
            assistantMessage(PLAN_ASSISTANT_ID, 2),
          ],
        },
      }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)
  })

  test("rejects completion until the terminal assistant has visible summary text", () => {
    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({
        session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
        part: { [PLAN_ASSISTANT_ID]: [] },
      }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)
  })

  test("rejects completion for an intermediate tool-calls assistant message", () => {
    expect(isSessionTurnSettledForCompletion({
      sessionID: SESSION_ID,
      state: buildState({
        session_status: { [SESSION_ID]: { type: "idle" } as SessionStatus },
        message: {
          [SESSION_ID]: [
            userMessage(USER_ID, 1),
            toolCallsAssistantMessage(PLAN_ASSISTANT_ID, 2, 3),
          ],
        },
        part: { [PLAN_ASSISTANT_ID]: [textPart(PLAN_ASSISTANT_ID), toolPart(PLAN_ASSISTANT_ID, "completed")] },
      }),
      completedMessageId: PLAN_ASSISTANT_ID,
    })).toBe(false)
  })
})
