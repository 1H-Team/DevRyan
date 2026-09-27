import type { QuestionRequest } from "@/types/question"
import type { SendConfig } from "@/sync/send-config"
import { formatOrphanedQuestionAnswers } from "@/sync/question-orphan"
import type { QuestionRequestAnswerGroup, QuestionRequestSubmitResult } from "./questionCardRouting"

/**
 * Delivery for question answers whose turn already stopped. OpenCode would
 * accept a reply to the dead request and drop it, so those answers are sent as
 * one new user message to the conversation root instead.
 *
 * Ordering matters because a card can mix live and orphaned requests:
 * - live replies go first, so the resume message can never race them (a send
 *   while a live question is pending would skip-reject it);
 * - a live reply that the server reports orphaned joins the orphan set;
 * - orphans are grouped per root and sent as a single message, queued behind
 *   the turn a live reply resumed in the same root;
 * - dead requests are discarded before the send (a pending one would park the
 *   send behind a turn that never resumes), and a send that still fails keeps
 *   the answer as a queued message the user can retry.
 */

export type OrphanResumeDelivery = {
  sessionId: string
  content: string
  config: SendConfig & { providerID: string; modelID: string }
}

export type QuestionAnswerSubmissionDependencies = {
  respondToQuestion: (sessionID: string, requestID: string, answers: string[][]) => Promise<void>
  isOrphanedError: (error: unknown) => boolean
  resolveRootSessionId: (sessionId: string) => string
  resolveSendConfig: (sessionId: string) => SendConfig
  authorizeSend: (request: { sessionId: string; agentName: string | null | undefined }) => Promise<boolean>
  discardQuestion: (sessionID: string, requestID: string) => Promise<void>
  sendMessage: (delivery: OrphanResumeDelivery) => Promise<void>
  /** Delivers after the root's running turn settles (the message queue). */
  queueMessage: (delivery: OrphanResumeDelivery) => void
  /** Keeps an answer whose send failed, e.g. as a retryable queued message. */
  preserveUnsentAnswer: (delivery: OrphanResumeDelivery, error: unknown) => void
}

type OrphanGroup = { rootSessionId: string; groups: QuestionRequestAnswerGroup[] }

const requestKey = (request: QuestionRequest) => `${request.sessionID}\u0000${request.id}`

async function deliverOrphanGroup(
  orphanGroup: OrphanGroup,
  queueBehindRunningTurn: boolean,
  deps: QuestionAnswerSubmissionDependencies,
): Promise<void> {
  const sessionId = orphanGroup.rootSessionId
  const config = deps.resolveSendConfig(sessionId)
  const { providerID, modelID } = config
  if (!providerID || !modelID) {
    throw new Error("Select an available model before sending.")
  }
  if (!await deps.authorizeSend({ sessionId, agentName: config.agent })) {
    throw new Error("Sending this answer needs confirmation first.")
  }

  const delivery: OrphanResumeDelivery = {
    sessionId,
    content: formatOrphanedQuestionAnswers(orphanGroup.groups),
    config: { ...config, providerID, modelID },
  }
  for (const group of orphanGroup.groups) {
    await deps.discardQuestion(group.request.sessionID, group.request.id)
  }
  if (queueBehindRunningTurn) {
    deps.queueMessage(delivery)
    return
  }
  try {
    await deps.sendMessage(delivery)
  } catch (error) {
    deps.preserveUnsentAnswer(delivery, error)
    throw error
  }
}

export async function submitQuestionAnswersWithOrphanResume(
  groups: readonly QuestionRequestAnswerGroup[],
  isKnownOrphan: (request: QuestionRequest) => boolean,
  deps: QuestionAnswerSubmissionDependencies,
): Promise<QuestionRequestSubmitResult[]> {
  const outcomes = new Map<string, QuestionRequestSubmitResult>()
  const orphans: QuestionRequestAnswerGroup[] = []
  const live: QuestionRequestAnswerGroup[] = []
  for (const group of groups) {
    if (isKnownOrphan(group.request)) orphans.push(group)
    else live.push(group)
  }

  const replies = await Promise.allSettled(live.map((group) => deps.respondToQuestion(
    group.request.sessionID,
    group.request.id,
    group.answers,
  )))
  const resumedRoots = new Set<string>()
  replies.forEach((reply, index) => {
    const group = live[index]
    if (reply.status === "fulfilled") {
      outcomes.set(requestKey(group.request), { status: "fulfilled", request: group.request })
      resumedRoots.add(deps.resolveRootSessionId(group.request.sessionID))
      return
    }
    if (deps.isOrphanedError(reply.reason)) {
      orphans.push(group)
      return
    }
    outcomes.set(requestKey(group.request), { status: "rejected", request: group.request, reason: reply.reason })
  })

  const orphanGroups = new Map<string, OrphanGroup>()
  for (const group of orphans) {
    const rootSessionId = deps.resolveRootSessionId(group.request.sessionID)
    const existing = orphanGroups.get(rootSessionId)
    if (existing) existing.groups.push(group)
    else orphanGroups.set(rootSessionId, { rootSessionId, groups: [group] })
  }
  // One root at a time: each delivery is a new turn in its own conversation.
  for (const orphanGroup of orphanGroups.values()) {
    let outcome: { status: "fulfilled" } | { status: "rejected"; reason: unknown }
    try {
      await deliverOrphanGroup(orphanGroup, resumedRoots.has(orphanGroup.rootSessionId), deps)
      outcome = { status: "fulfilled" }
    } catch (reason) {
      outcome = { status: "rejected", reason }
    }
    for (const group of orphanGroup.groups) {
      outcomes.set(requestKey(group.request), { ...outcome, request: group.request })
    }
  }

  return groups.map((group) => outcomes.get(requestKey(group.request))
    ?? { status: "rejected", request: group.request, reason: new Error("Question answer was not submitted") })
}
