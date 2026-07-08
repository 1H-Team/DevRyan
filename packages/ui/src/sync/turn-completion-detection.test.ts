import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { detectTurnCompletedCandidate } from "./turn-completion-detection"
import type { State } from "./types"

const userMessage = (id: string, created: number): Message => ({
  id,
  role: "user",
  sessionID: "ses_1",
  time: { created },
} as Message)

const assistantMessage = (id: string, created: number, completed?: number): Message => ({
  id,
  role: "assistant",
  sessionID: "ses_1",
  time: completed ? { created, completed } : { created },
} as Message)

const textPart = (messageID: string, text: string): Part => ({
  id: `${messageID}_part`,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text,
} as Part)

const stateWithMessages = (
  messages: Message[],
  part: Pick<State, "part">["part"] = {},
): Pick<State, "message" | "part" | "question" | "session" | "revert_transaction"> => ({
  message: { ses_1: messages },
  part,
  question: {},
  session: [],
  revert_transaction: {},
})

describe("detectTurnCompletedCandidate", () => {
  test("returns the completed assistant response for ordinary non-plan work", () => {
    const state = stateWithMessages([
      userMessage("msg_user", 1),
      assistantMessage("msg_assistant", 2, 3),
    ], {
      msg_assistant: [textPart("msg_assistant", "Done.")],
    })

    expect(detectTurnCompletedCandidate({
      sessionID: "ses_1",
      state,
      isRecordedPlanModeUserMessage: () => false,
      planEntry: null,
    })).toEqual({
      sessionID: "ses_1",
      originatingUserMessageId: "msg_user",
      completedMessageId: "msg_assistant",
    })
  })

  test("does not classify incomplete assistant work as completed", () => {
    const state = stateWithMessages([
      userMessage("msg_user", 1),
      assistantMessage("msg_assistant", 2),
    ])

    expect(detectTurnCompletedCandidate({
      sessionID: "ses_1",
      state,
      isRecordedPlanModeUserMessage: () => false,
      planEntry: null,
    })).toBeNull()
  })

  test("excludes plan proposal turns from generic completion", () => {
    const state = stateWithMessages([
      userMessage("msg_plan_user", 1),
      assistantMessage("msg_plan_assistant", 2, 3),
    ])

    expect(detectTurnCompletedCandidate({
      sessionID: "ses_1",
      state,
      isRecordedPlanModeUserMessage: (messageId) => messageId === "msg_plan_user",
      planEntry: { state: "proposed", sourceMessageId: "msg_plan_assistant" },
    })).toBeNull()
  })

  test("excludes plan implementation turns from generic completion", () => {
    const state = stateWithMessages([
      userMessage("msg_impl_user", 1),
      assistantMessage("msg_impl_assistant", 2, 3),
    ])

    expect(detectTurnCompletedCandidate({
      sessionID: "ses_1",
      state,
      isRecordedPlanModeUserMessage: () => false,
      planEntry: {
        state: "implementing",
        sourceMessageId: "msg_plan_assistant",
        implementationMessageId: "msg_impl_user",
      },
    })).toBeNull()
  })

  test("ignores completed work when the session is waiting on a question", () => {
    const state = {
      ...stateWithMessages([
        userMessage("msg_user", 1),
        assistantMessage("msg_assistant", 2, 3),
      ]),
      question: { ses_1: [{ id: "q_1", sessionID: "ses_1", questions: [] }] },
    } as Pick<State, "message" | "part" | "question" | "session" | "revert_transaction">

    expect(detectTurnCompletedCandidate({
      sessionID: "ses_1",
      state,
      isRecordedPlanModeUserMessage: () => false,
      planEntry: null,
    })).toBeNull()
  })
})
