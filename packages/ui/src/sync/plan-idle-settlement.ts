import { filterMessagesForRevert, getEffectiveSessionRevertMessageID } from "./revert-transactions"
import { isFinalAssistantSummaryMessage } from "./session-working"
import type { State } from "./types"

type PlanIdleSettlementState = Pick<
  State,
  "message" | "part" | "permission" | "question" | "session" | "session_status" | "revert_transaction"
>

export function isSessionTurnSettledForCompletion({
  sessionID,
  state,
  completedMessageId,
}: {
  sessionID: string
  state: PlanIdleSettlementState
  completedMessageId: string
}): boolean {
  const status = state.session_status[sessionID]
  if (status?.type !== "idle") return false
  if ((state.permission[sessionID]?.length ?? 0) > 0) return false
  if ((state.question[sessionID]?.length ?? 0) > 0) return false

  const rawMessages = state.message[sessionID]
  if (!rawMessages || rawMessages.length === 0) return false

  const revertMessageID = getEffectiveSessionRevertMessageID(state, sessionID)
  const messages = filterMessagesForRevert(rawMessages, revertMessageID)
  const trailingMessage = messages[messages.length - 1]

  if (!trailingMessage || trailingMessage.id !== completedMessageId || trailingMessage.role !== "assistant") {
    return false
  }

  if (!isFinalAssistantSummaryMessage(trailingMessage, state.part[completedMessageId])) return false

  return true
}
