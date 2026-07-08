import type { Message } from "@opencode-ai/sdk/v2/client"
import type { PlanIndicatorEntry } from "./plan-indicator"
import { filterMessagesForRevert, getEffectiveSessionRevertMessageID } from "./revert-transactions"
import { isFinalAssistantSummaryMessage } from "./session-working"
import type { State } from "./types"

export type TurnCompletedCandidate = {
  sessionID: string
  originatingUserMessageId: string
  completedMessageId: string
}

type TurnCompletionDetectionState = Pick<
  State,
  "message" | "part" | "question" | "session" | "revert_transaction"
>

export function detectTurnCompletedCandidate({
  sessionID,
  state,
  isRecordedPlanModeUserMessage,
  planEntry,
}: {
  sessionID: string
  state: TurnCompletionDetectionState
  isRecordedPlanModeUserMessage: (messageId: string) => boolean
  planEntry?: PlanIndicatorEntry | null
}): TurnCompletedCandidate | null {
  const pendingQuestions = state.question[sessionID]
  if (pendingQuestions && pendingQuestions.length > 0) return null

  const rawMessages = state.message[sessionID]
  if (!rawMessages || rawMessages.length === 0) return null

  const revertMessageID = getEffectiveSessionRevertMessageID(state, sessionID)
  const messages = filterMessagesForRevert(rawMessages, revertMessageID)

  for (let assistantIndex = messages.length - 1; assistantIndex >= 0; assistantIndex -= 1) {
    const assistantMessage = messages[assistantIndex]
    if (assistantMessage.role !== "assistant") continue
    if (!isFinalAssistantSummaryMessage(assistantMessage, state.part[assistantMessage.id])) continue
    if (planEntry?.sourceMessageId === assistantMessage.id) return null

    const userMessage = findOriginatingUserMessage(messages, assistantIndex)
    if (!userMessage) return null
    if (isRecordedPlanModeUserMessage(userMessage.id)) return null
    if (planEntry?.implementationMessageId === userMessage.id) return null

    return {
      sessionID,
      originatingUserMessageId: userMessage.id,
      completedMessageId: assistantMessage.id,
    }
  }

  return null
}

function findOriginatingUserMessage(messages: readonly Message[], assistantIndex: number): Message | null {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return message
  }
  return null
}
