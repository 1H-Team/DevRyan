import type { Message, Part } from "@opencode-ai/sdk/v2/client"

/**
 * OpenCode keeps a question request answerable after its turn is aborted, but
 * a reply then reaches a tool call that no longer exists and the agent never
 * sees it. Such a request is "orphaned": its answer must be delivered as a new
 * user message instead of a question reply.
 */

export const QUESTION_ORPHANED_CODE = "question_orphaned"

type QuestionLike = {
  questions: ReadonlyArray<{ question: string; header?: string }>
  tool?: { messageID: string; callID: string }
}

type OrphanEvidence = {
  /** Parts of the assistant message that issued the question (`tool.messageID`). */
  parts: readonly Part[] | undefined
  /** Message infos of the question's session, used to spot an aborted assistant message. */
  messages: readonly Message[] | undefined
}

const isSettledToolStatus = (status: unknown): boolean => typeof status === "string"
  && status.length > 0
  && status !== "pending"
  && status !== "running"

/**
 * True only on positive evidence: the question's own tool part settled, or the
 * assistant message that asked it ended aborted. Missing history is not
 * evidence — the server's `question_orphaned` refusal covers that case.
 */
export function isQuestionOrphaned(request: QuestionLike, evidence: OrphanEvidence): boolean {
  const tool = request.tool
  if (!tool?.messageID || !tool.callID) return false

  const toolPart = evidence.parts?.find((part) => part.type === "tool" && part.callID === tool.callID)
  if (toolPart && toolPart.type === "tool") {
    return isSettledToolStatus(toolPart.state?.status)
  }

  const message = evidence.messages?.find((entry) => entry.id === tool.messageID)
  if (!message || message.role !== "assistant") return false
  return message.error?.name === "MessageAbortedError" && typeof message.time?.completed === "number"
}

type OrphanStateLike = {
  part: Record<string, readonly Part[] | undefined>
  message: Record<string, readonly Message[] | undefined>
}

/**
 * The one orphan test every consumer uses against a directory store, so the
 * card, send gating, abort guards and blocking counts agree on which pending
 * questions still block their session.
 */
export function isPendingQuestionOrphaned(
  state: OrphanStateLike,
  request: QuestionLike & { sessionID: string },
): boolean {
  return isQuestionOrphaned(request, {
    parts: request.tool ? state.part[request.tool.messageID] : undefined,
    messages: state.message[request.sessionID],
  })
}

/** Pending questions of a session that still block it (orphans excluded). */
export function countLivePendingQuestions(
  state: OrphanStateLike & { question: Record<string, ReadonlyArray<QuestionLike & { sessionID: string }> | undefined> },
  sessionId: string,
): number {
  const questions = state.question[sessionId]
  if (!questions || questions.length === 0) return 0
  let count = 0
  for (const question of questions) {
    if (!isPendingQuestionOrphaned(state, question)) count += 1
  }
  return count
}

export function isQuestionOrphanedError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === QUESTION_ORPHANED_CODE
}

/**
 * Renders the user's answers as a plain prompt so the agent can continue from
 * a stopped turn. Several stopped requests share one message; unanswered
 * questions are listed explicitly rather than dropped, so the agent knows they
 * are still open.
 */
export function formatOrphanedQuestionAnswers(
  entries: ReadonlyArray<{ request: QuestionLike; answers: ReadonlyArray<ReadonlyArray<string>> }>,
): string {
  const lines: string[] = []
  for (const { request, answers } of entries) {
    request.questions.forEach((entry, index) => {
      const question = entry.question.trim() || entry.header?.trim() || `Question ${lines.length + 1}`
      const answer = (answers[index] ?? []).map((value) => value.trim()).filter(Boolean)
      lines.push(`- ${question}\n  Answer: ${answer.length > 0 ? answer.join(", ") : "(no answer)"}`)
    })
  }
  return [
    "My answers to the question you asked before the previous turn stopped:",
    ...lines,
    "Continue the task using these answers.",
  ].join("\n")
}
