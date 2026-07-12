import type { QuestionRequest } from "@/types/question"

const QUESTION_REQUEST_KEY_SEPARATOR = "\u0000"

export function getQuestionRequestKey(request: QuestionRequest): string {
  return `${request.sessionID}${QUESTION_REQUEST_KEY_SEPARATOR}${request.id}`
}

export type QuestionAnswerEntry = {
  request: QuestionRequest
  withinRequestIndex: number
  answers: string[]
}

export type QuestionRequestAnswerGroup = {
  request: QuestionRequest
  answers: string[][]
}

export type QuestionRequestSubmitResult =
  | { status: "fulfilled"; request: QuestionRequest }
  | { status: "rejected"; request: QuestionRequest; reason: unknown }

export type RespondToQuestion = (
  sessionID: string,
  requestID: string,
  answers: string[][],
) => Promise<void>

export function buildQuestionRequestAnswerGroups(entries: readonly QuestionAnswerEntry[]): QuestionRequestAnswerGroup[] {
  const grouped = new Map<string, QuestionRequestAnswerGroup>()

  for (const entry of entries) {
    const requestKey = getQuestionRequestKey(entry.request)
    let group = grouped.get(requestKey)
    if (!group) {
      group = {
        request: entry.request,
        answers: new Array(entry.request.questions.length).fill(null).map(() => []),
      }
      grouped.set(requestKey, group)
    }
    group.answers[entry.withinRequestIndex] = entry.answers
  }

  return Array.from(grouped.values())
}

export async function submitQuestionRequestAnswerGroups(
  groups: readonly QuestionRequestAnswerGroup[],
  respondToQuestion: RespondToQuestion,
): Promise<QuestionRequestSubmitResult[]> {
  const results = await Promise.allSettled(
    groups.map((group) => respondToQuestion(
      group.request.sessionID,
      group.request.id,
      group.answers,
    )),
  )

  return results.map((result, index) => {
    const request = groups[index].request
    if (result.status === "fulfilled") {
      return { status: "fulfilled", request }
    }
    return { status: "rejected", request, reason: result.reason }
  })
}
