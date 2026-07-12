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

export function applyQuestionSubmissionResults(
  previousAcknowledgedRequestKeys: ReadonlySet<string>,
  results: readonly QuestionRequestSubmitResult[],
  fallbackError: string,
): {
  acknowledgedRequestKeys: Set<string>
  errorsByRequestKey: Record<string, string>
  anyFailed: boolean
} {
  const acknowledgedRequestKeys = new Set(previousAcknowledgedRequestKeys)
  const errorsByRequestKey: Record<string, string> = {}
  let anyFailed = false

  for (const result of results) {
    const requestKey = getQuestionRequestKey(result.request)
    if (result.status === "fulfilled") {
      acknowledgedRequestKeys.add(requestKey)
      continue
    }

    anyFailed = true
    errorsByRequestKey[requestKey] = result.reason instanceof Error
      ? result.reason.message
      : fallbackError
  }

  return {
    acknowledgedRequestKeys,
    errorsByRequestKey,
    anyFailed,
  }
}

export function reconcileAcknowledgedQuestionRequestKeys(
  previous: ReadonlySet<string>,
  requests: readonly QuestionRequest[],
): Set<string> {
  const currentKeys = new Set(requests.map(getQuestionRequestKey))
  return new Set(Array.from(previous).filter((key) => currentKeys.has(key)))
}
