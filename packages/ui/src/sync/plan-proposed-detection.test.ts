import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE, type State } from "./types"
import { detectPlanProposedCandidate } from "./plan-proposed-detection"

const SESSION_ID = "ses_1"

const userMessage = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  sessionID: SESSION_ID,
  role: "user",
  time: { created: 1 },
  ...extra,
} as Message)

const assistantMessage = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  sessionID: SESSION_ID,
  role: "assistant",
  time: { created: 2, completed: 3 },
  ...extra,
} as Message)

const textPart = (messageID: string, text: string, synthetic = false): Part => ({
  id: `${messageID}_part`,
  sessionID: SESSION_ID,
  messageID,
  type: "text",
  text,
  synthetic,
} as Part)

const toolPart = (messageID: string, status: "pending" | "running" | "completed"): Part => ({
  id: `${messageID}_tool`,
  sessionID: SESSION_ID,
  messageID,
  type: "tool",
  tool: "read",
  state: { status },
} as Part)

const buildState = (overrides: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...overrides,
})

const detect = (
  state: State,
  options: {
    recorded?: Set<string>
    implemented?: Set<string>
    handedOff?: Set<string>
  } = {},
) => detectPlanProposedCandidate({
  sessionID: SESSION_ID,
  state,
  isRecordedPlanModeUserMessage: (messageId) => options.recorded?.has(messageId) ?? false,
  implementedPlanRequests: options.implemented ?? new Set(),
  externallyHandedOffPlanRequests: options.handedOff,
})

describe("detectPlanProposedCandidate", () => {
  test("returns the latest assistant plan turn when the completed assistant message contains a plan card", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "intro\n<!--plan-->\n# Plan\n\nDo the work.")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toEqual({
      sessionID: SESSION_ID,
      sourceMessageId: "msg_2_assistant",
      originatingUserMessageId: "msg_1_user",
      implementationKey: `${SESSION_ID}:msg_2_assistant:plan:0`,
      markdown: "# Plan\n\nDo the work.",
    })
  })

  test("uses persisted message metadata as a fallback when the local recorded flag is missing", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user", { mode: "plan" } as Partial<Message>),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state)?.sourceMessageId).toBe("msg_2_assistant")
  })

  test("uses the synthetic plan-mode instruction part as a fallback for optimistic messages", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_1_user: [textPart("msg_1_user", "User has requested to enter plan mode.", true)],
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state)?.sourceMessageId).toBe("msg_2_assistant")
  })

  test("returns null for a stopped plan-mode turn before a plan card is presented", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "I'll inspect the code first.")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("detects structured plan-mode output without an explicit sentinel", () => {
    const structuredPlanBody = [
      "# Cursor Plan Card Fix",
      "",
      "## Context",
      "",
      "Cursor models omit the sentinel.",
      "",
      "## Implementation",
      "",
      "1. Add fallback detection.",
      "",
      "## Verification",
      "",
      "1. Run tests.",
    ].join("\n")

    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", structuredPlanBody)],
      },
    })

    const candidate = detect(state, { recorded: new Set(["msg_1_user"]) })
    expect(candidate?.sourceMessageId).toBe("msg_2_assistant")
    expect(candidate?.markdown).toBe(structuredPlanBody)
  })

  test("returns null for completed plan-mode replies without a plan card sentinel", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "# Plan\n\nDo the work.")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("returns null for a completed plan-mode reply with an empty plan card body", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "intro\n<!--plan-->\n   ")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("detects a presented plan card split across consecutive assistant text parts", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [
          textPart("msg_2_assistant", "intro\n<!--plan-->"),
          textPart("msg_2_assistant", "# Plan\n\nDo the work."),
        ],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })?.sourceMessageId).toBe("msg_2_assistant")
  })

  test("returns null for non-plan turns", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
    })

    expect(detect(state)).toBeNull()
  })

  test("returns null when the candidate plan implementation was already requested", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state, {
      recorded: new Set(["msg_1_user"]),
      implemented: new Set([`${SESSION_ID}:msg_2_assistant:plan:0`]),
    })).toBeNull()
  })

  test("keeps an externally handed-off plan from becoming actionable again", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state, {
      recorded: new Set(["msg_1_user"]),
      handedOff: new Set([`${SESSION_ID}:msg_2_assistant:plan:0`]),
    })).toBeNull()
  })

  test("does not mark a plan while questions are pending", () => {
    const question = {
      id: "que_1",
      sessionID: SESSION_ID,
      questions: [],
    } as QuestionRequest
    const state = buildState({
      question: { [SESSION_ID]: [question] },
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("does not mark a plan while permissions are pending", () => {
    const state = buildState({
      permission: { [SESSION_ID]: [{} as PermissionRequest] },
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("does not mark a plan while assistant tools are still running", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [
          textPart("msg_2_assistant", "<!--plan-->\n# Plan"),
          toolPart("msg_2_assistant", "running"),
        ],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("does not mark a plan from an assistant turn that has not completed", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant", { time: { created: 2 } } as Partial<Message>),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("does not resurrect an older plan after a newer non-plan turn completes", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
          userMessage("msg_3_user"),
          assistantMessage("msg_4_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("does not resurrect an older plan after a newer user message is sent", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
          userMessage("msg_3_user"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Plan")],
      },
    })

    expect(detect(state, { recorded: new Set(["msg_1_user"]) })).toBeNull()
  })

  test("ignores messages hidden behind the session revert boundary", () => {
    const session = {
      id: SESSION_ID,
      title: "Session",
      time: { created: 1, updated: 1 },
      revert: { messageID: "msg_5_user" },
    } as Session
    const state = buildState({
      session: [session],
      message: {
        [SESSION_ID]: [
          userMessage("msg_1_user"),
          assistantMessage("msg_2_assistant"),
          userMessage("msg_5_user"),
          assistantMessage("msg_6_assistant"),
        ],
      },
      part: {
        msg_2_assistant: [textPart("msg_2_assistant", "<!--plan-->\n# Original plan")],
        msg_6_assistant: [textPart("msg_6_assistant", "<!--plan-->\n# Reverted plan")],
      },
    })

    expect(detect(state, {
      recorded: new Set(["msg_1_user", "msg_5_user"]),
    })?.sourceMessageId).toBe("msg_2_assistant")
  })
})
