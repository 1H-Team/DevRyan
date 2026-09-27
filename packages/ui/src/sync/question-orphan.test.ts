import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  countLivePendingQuestions,
  formatOrphanedQuestionAnswers,
  isQuestionOrphaned,
  isQuestionOrphanedError,
} from "./question-orphan"

const request = {
  questions: [
    { header: "Images", question: "Which images should the product page use?" },
    { header: "Names", question: "Capitalize treatment names?" },
  ],
  tool: { messageID: "msg_asst", callID: "call_q" },
}

const toolPart = (status: string): Part => ({
  id: "prt_q",
  sessionID: "ses_a",
  messageID: "msg_asst",
  type: "tool",
  tool: "question",
  callID: "call_q",
  state: { status, input: {}, time: { start: 1 } },
} as unknown as Part)

const assistant = (overrides: Record<string, unknown>): Message => ({
  id: "msg_asst",
  sessionID: "ses_a",
  role: "assistant",
  time: { created: 1 },
  ...overrides,
} as unknown as Message)

describe("isQuestionOrphaned", () => {
  test("follows the question's own tool part when it is loaded", () => {
    expect(isQuestionOrphaned(request, { parts: [toolPart("running")], messages: undefined })).toBe(false)
    expect(isQuestionOrphaned(request, { parts: [toolPart("pending")], messages: undefined })).toBe(false)
    expect(isQuestionOrphaned(request, { parts: [toolPart("error")], messages: undefined })).toBe(true)
    expect(isQuestionOrphaned(request, { parts: [toolPart("completed")], messages: undefined })).toBe(true)
  })

  test("a live tool part wins over an aborted-looking message", () => {
    const aborted = assistant({ error: { name: "MessageAbortedError", data: {} }, time: { created: 1, completed: 2 } })
    expect(isQuestionOrphaned(request, { parts: [toolPart("running")], messages: [aborted] })).toBe(false)
  })

  test("falls back to an aborted, completed assistant message when parts are missing", () => {
    const aborted = assistant({ error: { name: "MessageAbortedError", data: {} }, time: { created: 1, completed: 2 } })
    expect(isQuestionOrphaned(request, { parts: undefined, messages: [aborted] })).toBe(true)

    const stillOpen = assistant({ error: { name: "MessageAbortedError", data: {} } })
    expect(isQuestionOrphaned(request, { parts: undefined, messages: [stillOpen] })).toBe(false)

    const otherError = assistant({ error: { name: "APIError", data: {} }, time: { created: 1, completed: 2 } })
    expect(isQuestionOrphaned(request, { parts: undefined, messages: [otherError] })).toBe(false)
  })

  test("missing evidence is never treated as orphaned", () => {
    expect(isQuestionOrphaned(request, { parts: undefined, messages: undefined })).toBe(false)
    expect(isQuestionOrphaned({ questions: request.questions }, { parts: [toolPart("error")], messages: undefined })).toBe(false)
  })
})

describe("orphaned question helpers", () => {
  test("recognizes only the server's question_orphaned refusal", () => {
    expect(isQuestionOrphanedError({ code: "question_orphaned", error: "stopped" })).toBe(true)
    expect(isQuestionOrphanedError({ code: "other" })).toBe(false)
    expect(isQuestionOrphanedError("question_orphaned")).toBe(false)
    expect(isQuestionOrphanedError(null)).toBe(false)
  })

  test("formats every question with its answer and marks unanswered ones", () => {
    const text = formatOrphanedQuestionAnswers([{ request, answers: [["Official pack photos", " Stock "], []] }])
    expect(text).toContain("- Which images should the product page use?\n  Answer: Official pack photos, Stock")
    expect(text).toContain("- Capitalize treatment names?\n  Answer: (no answer)")
    expect(text.startsWith("My answers to the question you asked before the previous turn stopped:")).toBe(true)
    expect(text.endsWith("Continue the task using these answers.")).toBe(true)
  })

  test("combines several stopped requests into one message", () => {
    const second = { questions: [{ header: "Tone", question: "Formal or casual?" }], tool: { messageID: "m2", callID: "c2" } }
    const text = formatOrphanedQuestionAnswers([
      { request, answers: [["A"], ["Yes"]] },
      { request: second, answers: [["Casual"]] },
    ])
    expect(text.match(/Answer:/g)).toHaveLength(3)
    expect(text).toContain("- Formal or casual?\n  Answer: Casual")
  })
})

describe("countLivePendingQuestions", () => {
  test("counts only questions whose turn is still running", () => {
    const live = { ...request, sessionID: "ses_a", tool: { messageID: "msg_live", callID: "call_live" } }
    const dead = { ...request, sessionID: "ses_a", tool: { messageID: "msg_asst", callID: "call_q" } }
    const state = {
      question: { ses_a: [live, dead] },
      part: { msg_asst: [toolPart("error")], msg_live: [{ ...(toolPart("running") as object), callID: "call_live" } as unknown as Part] },
      message: {},
    }
    expect(countLivePendingQuestions(state, "ses_a")).toBe(1)
    expect(countLivePendingQuestions(state, "ses_none")).toBe(0)
  })
})
