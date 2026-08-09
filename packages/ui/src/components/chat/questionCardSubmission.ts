import type { QuestionRequest } from "@/types/question"
import {
  getQuestionRequestKey,
  type QuestionRequestAnswerGroup,
  type QuestionRequestSubmitResult,
} from "./questionCardRouting"

const QUESTION_KEY_SEPARATOR = "\u0000"

export { getQuestionRequestKey } from "./questionCardRouting"

export type QuestionSubmissionLock = {
  tryAcquire: () => boolean
  release: () => void
}

export type QuestionSubmissionAction = "answer" | "skip"

export type QuestionSubmissionClaim = {
  action: QuestionSubmissionAction
  request: QuestionRequest
  answers: string[][] | null
}

export type QuestionSubmissionShadow = Map<string, QuestionSubmissionClaim>

export function createQuestionSubmissionShadow(): QuestionSubmissionShadow {
  return new Map()
}

export function claimQuestionSubmissions(
  shadow: QuestionSubmissionShadow,
  claims: readonly QuestionSubmissionClaim[],
): boolean {
  if (claims.length === 0) return false

  const requestKeys = claims.map((claim) => getQuestionRequestKey(claim.request))
  if (new Set(requestKeys).size !== requestKeys.length) return false
  if (requestKeys.some((requestKey) => shadow.has(requestKey))) return false

  claims.forEach((claim, index) => {
    shadow.set(requestKeys[index], claim)
  })
  return true
}

export function releaseQuestionSubmissions(
  shadow: QuestionSubmissionShadow,
  requests: readonly QuestionRequest[],
): void {
  for (const request of requests) {
    shadow.delete(getQuestionRequestKey(request))
  }
}

export function getQuestionSubmissionStatus(
  shadow: QuestionSubmissionShadow,
): { action: QuestionSubmissionAction; count: number } | null {
  const first = shadow.values().next().value as QuestionSubmissionClaim | undefined
  if (!first) return null
  return { action: first.action, count: shadow.size }
}

export function createQuestionSubmissionLock(): QuestionSubmissionLock {
  let acquired = false

  return {
    tryAcquire: () => {
      if (acquired) return false
      acquired = true
      return true
    },
    release: () => {
      acquired = false
    },
  }
}

export function getQuestionEntryKey(request: QuestionRequest, withinRequestIndex: number): string {
  return `${getQuestionRequestKey(request)}${QUESTION_KEY_SEPARATOR}${withinRequestIndex}`
}

export function filterPendingQuestionRequestAnswerGroups(
  groups: readonly QuestionRequestAnswerGroup[],
  acknowledgedRequestKeys: ReadonlySet<string>,
): QuestionRequestAnswerGroup[] {
  return groups.filter((group) => !acknowledgedRequestKeys.has(getQuestionRequestKey(group.request)))
}

export function filterPendingQuestionRequests(
  requests: readonly QuestionRequest[],
  acknowledgedRequestKeys: ReadonlySet<string>,
): QuestionRequest[] {
  return requests.filter((request) => !acknowledgedRequestKeys.has(getQuestionRequestKey(request)))
}

export type RejectQuestion = (sessionID: string, requestID: string) => Promise<void>

export async function submitQuestionRequestRejections(
  requests: readonly QuestionRequest[],
  rejectQuestion: RejectQuestion,
): Promise<QuestionRequestSubmitResult[]> {
  const settled = await Promise.allSettled(
    requests.map((request) => rejectQuestion(request.sessionID, request.id)),
  )

  return settled.map((result, index) => {
    const request = requests[index]
    if (result.status === "fulfilled") return { status: "fulfilled", request }
    return { status: "rejected", request, reason: result.reason }
  })
}

export function acknowledgeQuestionRequests(
  previous: ReadonlySet<string>,
  requests: readonly QuestionRequest[],
): Set<string> {
  const next = new Set(previous)
  for (const request of requests) {
    next.add(getQuestionRequestKey(request))
  }
  return next
}

export function settleOptimisticQuestionSubmissionResults(
  previousAcknowledgedRequestKeys: ReadonlySet<string>,
  results: readonly QuestionRequestSubmitResult[],
  fallbackError: string,
): {
  acknowledgedRequestKeys: Set<string>
  errorsByRequestKey: Record<string, string>
  anyFailed: boolean
  failedResults: QuestionRequestSubmitResult[]
} {
  const acknowledgedRequestKeys = new Set(previousAcknowledgedRequestKeys)
  const errorsByRequestKey: Record<string, string> = {}
  const failedResults: QuestionRequestSubmitResult[] = []

  for (const result of results) {
    if (result.status === "fulfilled") continue

    const requestKey = getQuestionRequestKey(result.request)
    acknowledgedRequestKeys.delete(requestKey)
    failedResults.push(result)
    errorsByRequestKey[requestKey] = result.reason instanceof Error
      ? result.reason.message
      : fallbackError
  }

  return {
    acknowledgedRequestKeys,
    errorsByRequestKey,
    anyFailed: failedResults.length > 0,
    failedResults,
  }
}

export function reconcileAcknowledgedQuestionRequestKeys(
  previous: ReadonlySet<string>,
  requests: readonly QuestionRequest[],
): Set<string> {
  const currentKeys = new Set(requests.map(getQuestionRequestKey))
  return new Set(Array.from(previous).filter((key) => currentKeys.has(key)))
}
