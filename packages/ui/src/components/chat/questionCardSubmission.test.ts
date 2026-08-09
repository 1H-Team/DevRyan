import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@/types/question"
import type { QuestionRequestAnswerGroup, QuestionRequestSubmitResult } from "./questionCardRouting"
import {
  acknowledgeQuestionRequests,
  claimQuestionSubmissions,
  createQuestionSubmissionLock,
  createQuestionSubmissionShadow,
  filterPendingQuestionRequestAnswerGroups,
  filterPendingQuestionRequests,
  getQuestionEntryKey,
  getQuestionRequestKey,
  getQuestionSubmissionStatus,
  reconcileAcknowledgedQuestionRequestKeys,
  releaseQuestionSubmissions,
  settleOptimisticQuestionSubmissionResults,
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

  test("claims requests synchronously with immutable answer snapshots for compact pending UI", () => {
    const first = request("ses_1", "que_1")
    const answers = [["Yes"]]
    const shadow = createQuestionSubmissionShadow()

    expect(claimQuestionSubmissions(shadow, [{
      action: "answer",
      request: first,
      answers: answers.map((answer) => [...answer]),
    }])).toBe(true)
    answers[0].push("Changed after submit")

    expect(getQuestionSubmissionStatus(shadow)).toEqual({ action: "answer", count: 1 })
    expect(shadow.get(getQuestionRequestKey(first))?.answers).toEqual([["Yes"]])
  })

  test("rejects duplicate claims and releases only the completed transaction requests", () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const shadow = createQuestionSubmissionShadow()

    expect(claimQuestionSubmissions(shadow, [
      { action: "skip", request: first, answers: null },
      { action: "skip", request: second, answers: null },
    ])).toBe(true)
    expect(claimQuestionSubmissions(shadow, [
      { action: "answer", request: first, answers: [["Yes"]] },
    ])).toBe(false)

    releaseQuestionSubmissions(shadow, [first])
    expect(getQuestionSubmissionStatus(shadow)).toEqual({ action: "skip", count: 1 })
    expect([...shadow.keys()]).toEqual([getQuestionRequestKey(second)])

    releaseQuestionSubmissions(shadow, [second])
    expect(getQuestionSubmissionStatus(shadow)).toBeNull()
  })

  test("keeps session scopes isolated when a late transaction settles", () => {
    const oldRequest = request("ses_old", "que_1")
    const nextRequest = request("ses_next", "que_1")
    const oldShadow = createQuestionSubmissionShadow()
    const nextShadow = createQuestionSubmissionShadow()

    claimQuestionSubmissions(oldShadow, [{ action: "answer", request: oldRequest, answers: [["Yes"]] }])
    claimQuestionSubmissions(nextShadow, [{ action: "skip", request: nextRequest, answers: null }])
    releaseQuestionSubmissions(oldShadow, [oldRequest])

    expect(getQuestionSubmissionStatus(oldShadow)).toBeNull()
    expect(getQuestionSubmissionStatus(nextShadow)).toEqual({ action: "skip", count: 1 })
  })

  test("tolerates an authoritative acknowledgement before the transport promise settles", () => {
    const first = request("ses_1", "que_1")
    const shadow = createQuestionSubmissionShadow()
    claimQuestionSubmissions(shadow, [{ action: "answer", request: first, answers: [["Yes"]] }])

    const acknowledged = reconcileAcknowledgedQuestionRequestKeys(
      new Set([getQuestionRequestKey(first)]),
      [],
    )
    releaseQuestionSubmissions(shadow, [first])

    expect(acknowledged.size).toBe(0)
    expect(getQuestionSubmissionStatus(shadow)).toBeNull()
  })

  test("keeps a newly arriving request visible after the claimed request is optimistically acknowledged", () => {
    const claimedRequest = request("ses_1", "que_1")
    const newRequest = request("ses_1", "que_2")
    const acknowledged = acknowledgeQuestionRequests(new Set(), [claimedRequest])
    const settled = settleOptimisticQuestionSubmissionResults(acknowledged, [
      { status: "fulfilled", request: claimedRequest },
    ], "Failed to submit answer")

    expect(filterPendingQuestionRequests(
      [claimedRequest, newRequest],
      settled.acknowledgedRequestKeys,
    )).toEqual([newRequest])
  })

  test("optimistic acknowledgement unions with prior keys without mutating the previous set", () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const previous = new Set([getQuestionRequestKey(first)])

    const next = acknowledgeQuestionRequests(previous, [second])

    expect([...next].sort()).toEqual([
      getQuestionRequestKey(first),
      getQuestionRequestKey(second),
    ].sort())
    expect([...previous]).toEqual([getQuestionRequestKey(first)])
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
    const optimistic = acknowledgeQuestionRequests(new Set(), [first, second])
    const firstAttempt = await submitQuestionRequestRejections([first, second], async (_sessionID, requestID) => {
      if (requestID === second.id) throw new Error("network failed")
    })
    const outcome = settleOptimisticQuestionSubmissionResults(optimistic, firstAttempt, "Failed to skip question")
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

  test("partial failure un-acknowledges only the rejected request and maps its error", () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const optimistic = acknowledgeQuestionRequests(new Set(), [first, second])
    const results: QuestionRequestSubmitResult[] = [
      { status: "fulfilled", request: first },
      { status: "rejected", request: second, reason: new Error("network failed") },
    ]

    const next = settleOptimisticQuestionSubmissionResults(optimistic, results, "Failed to submit answer")

    expect([...next.acknowledgedRequestKeys]).toEqual([getQuestionRequestKey(first)])
    expect(next.errorsByRequestKey).toEqual({
      [getQuestionRequestKey(second)]: "network failed",
    })
    expect(next.anyFailed).toBe(true)
    expect(next.failedResults).toEqual([results[1]])
  })

  test("non-Error rejection reasons fall back to the provided message", () => {
    const first = request("ses_1", "que_1")
    const optimistic = acknowledgeQuestionRequests(new Set(), [first])

    const next = settleOptimisticQuestionSubmissionResults(optimistic, [
      { status: "rejected", request: first, reason: "boom" },
    ], "Failed to submit answer")

    expect(next.acknowledgedRequestKeys.size).toBe(0)
    expect(next.errorsByRequestKey).toEqual({
      [getQuestionRequestKey(first)]: "Failed to submit answer",
    })
  })

  test("settling fulfilled results preserves unrelated prior acknowledgements", () => {
    const first = request("ses_1", "que_1")
    const second = request("ses_1", "que_2")
    const previous = acknowledgeQuestionRequests(
      new Set([getQuestionRequestKey(first)]),
      [second],
    )

    const next = settleOptimisticQuestionSubmissionResults(previous, [
      { status: "fulfilled", request: second },
    ], "Failed to submit answer")

    expect([...next.acknowledgedRequestKeys].sort()).toEqual([
      getQuestionRequestKey(first),
      getQuestionRequestKey(second),
    ].sort())
    expect(next.errorsByRequestKey).toEqual({})
    expect(next.anyFailed).toBe(false)
    expect(next.failedResults).toEqual([])
  })

  test("settling after authoritative reconciliation already dropped the key is a no-op", () => {
    const first = request("ses_1", "que_1")
    // question.replied removed the request, so reconcile pruned its acked key.
    const reconciled = reconcileAcknowledgedQuestionRequestKeys(
      acknowledgeQuestionRequests(new Set(), [first]),
      [],
    )

    const next = settleOptimisticQuestionSubmissionResults(reconciled, [
      { status: "fulfilled", request: first },
    ], "Failed to submit answer")

    expect(next.acknowledgedRequestKeys.size).toBe(0)
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
