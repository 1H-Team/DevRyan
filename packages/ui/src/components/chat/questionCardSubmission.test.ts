import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@/types/question"
import type { QuestionRequestAnswerGroup, QuestionRequestSubmitResult } from "./questionCardRouting"
import {
  applyQuestionSubmissionResults,
  createQuestionSubmissionLock,
  filterPendingQuestionRequestAnswerGroups,
  filterPendingQuestionRequests,
  getQuestionEntryKey,
  getQuestionRequestKey,
  reconcileAcknowledgedQuestionRequestKeys,
  submitQuestionRequestRejections,
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

  test("Skip rejects each unresolved request once without requiring answers", async () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const calls: Array<[string, string]> = []

    const results = await submitQuestionRequestRejections([first, second], async (sessionID, requestID) => {
      calls.push([sessionID, requestID])
    })

    expect(calls).toEqual([["ses_1", "que_1"], ["ses_1", "que_2"]])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
  })

  test("Skip retry never resends requests acknowledged before a partial failure", async () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const firstAttempt = await submitQuestionRequestRejections([first, second], async (_sessionID, requestID) => {
      if (requestID === second.id) throw new Error("network failed")
    })
    const outcome = applyQuestionSubmissionResults(new Set(), firstAttempt, "Failed to skip question")
    const retryTargets = filterPendingQuestionRequests([first, second], outcome.acknowledgedRequestKeys)
    const retryCalls: string[] = []

    const retry = await submitQuestionRequestRejections(retryTargets, async (_sessionID, requestID) => {
      retryCalls.push(requestID)
    })

    expect(retryCalls).toEqual([second.id])
    expect(outcome.errorsByRequestKey).toEqual({
      [getQuestionRequestKey(second)]: "network failed",
    })
    expect(retry).toEqual([{ status: "fulfilled", request: second }])
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
