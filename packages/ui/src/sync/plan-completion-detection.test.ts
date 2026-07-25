import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE, type State } from "./types"
import { detectPlanCompletedCandidate } from "./plan-completion-detection"

const SESSION_ID = "ses_1"

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
  time: completed ? { created, completed } : { created },
} as Message)

const textPart = (messageID: string, text: string): Part => ({
  id: `${messageID}_part`,
  sessionID: SESSION_ID,
  messageID,
  type: "text",
  text,
} as Part)

const buildState = (overrides: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...overrides,
})

describe("detectPlanCompletedCandidate", () => {
  test("returns the plan source once the implementation assistant turn completes", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_impl_user", 4),
          assistantMessage("msg_impl_assistant", 5, 6),
        ],
      },
      part: {
        msg_impl_assistant: [textPart("msg_impl_assistant", "Implemented.")],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: {
        state: "implementing",
        sourceMessageId: "msg_plan_assistant",
        implementationMessageId: "msg_impl_user",
      },
    })).toEqual({
      sessionID: SESSION_ID,
      sourceMessageId: "msg_plan_assistant",
      implementationMessageId: "msg_impl_user",
      completedMessageId: "msg_impl_assistant",
    })
  })

  test("returns null until the implementation assistant turn completes", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_impl_user", 4),
          assistantMessage("msg_impl_assistant", 5),
        ],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: {
        state: "implementing",
        sourceMessageId: "msg_plan_assistant",
        implementationMessageId: "msg_impl_user",
      },
    })).toBeNull()
  })

  test("keeps a plan implementing while any plan todo is pending or in progress", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_impl_user", 4),
          assistantMessage("msg_impl_assistant", 5, 6),
        ],
      },
      part: {
        msg_impl_assistant: [textPart("msg_impl_assistant", "Implemented early.")],
      },
      todo: {
        [SESSION_ID]: [
          { content: "Phase 1: First task", priority: "medium", status: "completed" },
          { content: "Phase 2: Second task", priority: "medium", status: "in_progress" },
          { content: "Phase 2: Third task", priority: "medium", status: "pending" },
        ],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: {
        state: "implementing",
        sourceMessageId: "msg_plan_assistant",
        implementationMessageId: "msg_impl_user",
      },
    })).toBeNull()
  })

  test("uses the latest completed continuation after an earlier premature response", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_impl_user", 4),
          assistantMessage("msg_impl_premature", 5, 6),
          userMessage("msg_auto_continue", 7),
          assistantMessage("msg_impl_complete", 8, 9),
        ],
      },
      part: {
        msg_impl_premature: [textPart("msg_impl_premature", "Implemented early.")],
        msg_impl_complete: [textPart("msg_impl_complete", "All tasks completed.")],
      },
      todo: {
        [SESSION_ID]: [
          { content: "Phase 1: First task", priority: "medium", status: "completed" },
          { content: "Phase 2: Second task", priority: "medium", status: "completed" },
        ],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: {
        state: "implementing",
        sourceMessageId: "msg_plan_assistant",
        implementationMessageId: "msg_impl_user",
      },
    })).toEqual({
      sessionID: SESSION_ID,
      sourceMessageId: "msg_plan_assistant",
      implementationMessageId: "msg_impl_user",
      completedMessageId: "msg_impl_complete",
    })
  })

  test("ignores implementation messages hidden behind the session revert boundary", () => {
    const session = {
      id: SESSION_ID,
      title: "Session",
      time: { created: 1, updated: 1 },
      revert: { messageID: "msg_after_revert" },
    } as Session
    const state = buildState({
      session: [session],
      message: {
        [SESSION_ID]: [
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_impl_user", 4),
          assistantMessage("msg_impl_assistant", 5, 6),
          userMessage("msg_after_revert", 7),
        ],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: {
        state: "implementing",
        sourceMessageId: "msg_plan_assistant",
        implementationMessageId: "msg_impl_user",
      },
    })).toBeNull()
  })

  test("reconstructs completed plan state from persisted implementation requests", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_impl_user", 4),
          assistantMessage("msg_impl_assistant", 5, 6),
        ],
      },
      part: {
        msg_plan_user: [textPart("msg_plan_user", "User has requested to enter plan mode.")],
        msg_plan_assistant: [textPart("msg_plan_assistant", "<!--plan-->\n# Plan\n\nDo the work.")],
        msg_impl_assistant: [textPart("msg_impl_assistant", "Implemented.")],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: null,
      isRecordedPlanModeUserMessage: (messageId) => messageId === "msg_plan_user",
      implementedPlanRequests: new Set([`${SESSION_ID}:msg_plan_assistant:plan:0`]),
    })).toEqual({
      sessionID: SESSION_ID,
      sourceMessageId: "msg_plan_assistant",
      implementationMessageId: "msg_impl_user",
      completedMessageId: "msg_impl_assistant",
    })
  })

  test("does not recreate source-session completion after an external mobile handoff", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_unrelated_user", 4),
          assistantMessage("msg_unrelated_assistant", 5, 6),
        ],
      },
      part: {
        msg_plan_user: [textPart("msg_plan_user", "User has requested to enter plan mode.")],
        msg_plan_assistant: [textPart("msg_plan_assistant", "<!--plan-->\n# Plan\n\nDo the work.")],
        msg_unrelated_assistant: [textPart("msg_unrelated_assistant", "An unrelated follow-up completed.")],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: null,
      isRecordedPlanModeUserMessage: (messageId) => messageId === "msg_plan_user",
      implementedPlanRequests: new Set(),
    })).toBeNull()
  })

  test("reconstructs completed plan state from structured plan cards without explicit sentinel", () => {
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
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_impl_user", 4),
          assistantMessage("msg_impl_assistant", 5, 6),
        ],
      },
      part: {
        msg_plan_user: [textPart("msg_plan_user", "User has requested to enter plan mode.")],
        msg_plan_assistant: [textPart("msg_plan_assistant", structuredPlanBody)],
        msg_impl_assistant: [textPart("msg_impl_assistant", "Implemented.")],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: null,
      isRecordedPlanModeUserMessage: (messageId) => messageId === "msg_plan_user",
      implementedPlanRequests: new Set([`${SESSION_ID}:msg_plan_assistant:plan:0`]),
    })).toEqual({
      sessionID: SESSION_ID,
      sourceMessageId: "msg_plan_assistant",
      implementationMessageId: "msg_impl_user",
      completedMessageId: "msg_impl_assistant",
    })
  })

  test("does not reconstruct completed plan state until implementation output completes", () => {
    const state = buildState({
      message: {
        [SESSION_ID]: [
          userMessage("msg_plan_user", 1),
          assistantMessage("msg_plan_assistant", 2, 3),
          userMessage("msg_impl_user", 4),
          assistantMessage("msg_impl_assistant", 5),
        ],
      },
      part: {
        msg_plan_user: [textPart("msg_plan_user", "User has requested to enter plan mode.")],
        msg_plan_assistant: [textPart("msg_plan_assistant", "<!--plan-->\n# Plan\n\nDo the work.")],
      },
    })

    expect(detectPlanCompletedCandidate({
      sessionID: SESSION_ID,
      state,
      planEntry: null,
      isRecordedPlanModeUserMessage: (messageId) => messageId === "msg_plan_user",
      implementedPlanRequests: new Set([`${SESSION_ID}:msg_plan_assistant:plan:0`]),
    })).toBeNull()
  })
})
