import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@/types/question"
import type { QuestionRequestAnswerGroup, QuestionRequestSubmitResult } from "./questionCardRouting"
import {
  applyQuestionSubmissionResults,
  createQuestionSubmissionLock,
  filterPendingQuestionRequestAnswerGroups,
  getQuestionEntryKey,
  getQuestionRequestKey,
  reconcileAcknowledgedQuestionRequestKeys,
} from "./questionCardSubmission"

const request = (sessionID: string, id: string): QuestionRequest => ({
  id,
  sessionID,
  questions: [{
    header: "Choice",
    question: "Choose?",
    options: [{ label: "Yes", description: "" }],
  }],
})

const group = (value: QuestionRequest): QuestionRequestAnswerGroup => ({
  request: value,
  answers: [["Yes"]],
})

describe("question card submission state", () => {
  test("prevents overlapping submissions until the current request settles", () => {
    const lock = createQuestionSubmissionLock()

    expect(lock.tryAcquire()).toBe(true)
    expect(lock.tryAcquire()).toBe(false)

    lock.release()
    expect(lock.tryAcquire()).toBe(true)
  })

  test("request and entry keys remain stable and session-scoped", () => {
    const first = request("ses_1", "que_1")
    const sameIdOtherSession = request("ses_2", "que_1")

    expect(getQuestionRequestKey(first)).toBe("ses_1\u0000que_1")
    expect(getQuestionRequestKey(sameIdOtherSession)).toBe("ses_2\u0000que_1")
    expect(getQuestionEntryKey(first, 0)).toBe("ses_1\u0000que_1\u00000")
  })

  test("retries only groups without an authoritative acknowledgement", () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const acknowledged = new Set([getQuestionRequestKey(first)])

    expect(filterPendingQuestionRequestAnswerGroups(
      [group(first), group(second)],
      acknowledged,
    ).map((entry) => entry.request.id)).toEqual(["que_2"])
  })

  test("partial success preserves fulfilled request acknowledgements and rejected errors", () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const results: QuestionRequestSubmitResult[] = [
      { status: "fulfilled", request: first },
      { status: "rejected", request: second, reason: new Error("network failed") },
    ]

    const next = applyQuestionSubmissionResults(new Set(), results, "Failed to submit answer")

    expect([...next.acknowledgedRequestKeys]).toEqual([getQuestionRequestKey(first)])
    expect(next.errorsByRequestKey).toEqual({
      [getQuestionRequestKey(second)]: "network failed",
    })
    expect(next.anyFailed).toBe(true)
  })

  test("a successful retry adds to prior acknowledgements without resending them", () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const previous = new Set([getQuestionRequestKey(first)])

    const next = applyQuestionSubmissionResults(previous, [
      { status: "fulfilled", request: second },
    ], "Failed to submit answer")

    expect([...next.acknowledgedRequestKeys].sort()).toEqual([
      getQuestionRequestKey(first),
      getQuestionRequestKey(second),
    ].sort())
    expect(next.errorsByRequestKey).toEqual({})
    expect(next.anyFailed).toBe(false)
  })

  test("authoritative request removal prunes local acknowledgement keys", () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const previous = new Set([
      getQuestionRequestKey(first),
      getQuestionRequestKey(second),
      "ses_old\u0000que_old",
    ])

    expect([...reconcileAcknowledgedQuestionRequestKeys(previous, [second])])
      .toEqual([getQuestionRequestKey(second)])
  })
})
