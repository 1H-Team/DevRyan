import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { getPlanBlockId, getPlanImplementationKey, isPlanModeUserMessage, resolveMessagePlanCard } from "@/lib/messages/actionablePlan"
import { filterMessagesForRevert, getEffectiveSessionRevertMessageID } from "./revert-transactions"
import type { State } from "./types"

export type PlanProposedCandidate = {
  sessionID: string
  sourceMessageId: string
  originatingUserMessageId: string
  implementationKey: string
  markdown: string
}

type PlanProposedDetectionState = Pick<
  State,
  "message" | "part" | "permission" | "question" | "session" | "revert_transaction"
>

export function detectPlanProposedCandidate({
  sessionID,
  state,
  isRecordedPlanModeUserMessage,
  implementedPlanRequests,
  externallyHandedOffPlanRequests,
}: {
  sessionID: string
  state: PlanProposedDetectionState
  isRecordedPlanModeUserMessage: (messageId: string) => boolean
  implementedPlanRequests: ReadonlySet<string>
  externallyHandedOffPlanRequests?: ReadonlySet<string>
}): PlanProposedCandidate | null {
  const pendingQuestions = state.question[sessionID]
  if (pendingQuestions && pendingQuestions.length > 0) return null
  const pendingPermissions = state.permission[sessionID]
  if (pendingPermissions && pendingPermissions.length > 0) return null

  const rawMessages = state.message[sessionID]
  if (!rawMessages || rawMessages.length === 0) return null

  const revertMessageID = getEffectiveSessionRevertMessageID(state, sessionID)
  const messages = filterMessagesForRevert(rawMessages, revertMessageID)

  const assistantIndex = messages.length - 1
  const assistantMessage = messages[assistantIndex]
  if (!assistantMessage || assistantMessage.role !== "assistant") return null
  if (!isAssistantTurnComplete(assistantMessage)) return null

  const userMessage = findOriginatingUserMessage(messages, assistantIndex)
  if (!userMessage) return null

  const userParts = state.part[userMessage.id] ?? []
  const recordedPlanMode = isRecordedPlanModeUserMessage(userMessage.id)
  if (!isPlanModeUserMessage(userMessage, userParts, recordedPlanMode)) return null
  const assistantParts = state.part[assistantMessage.id] ?? []
  if (hasRunningToolPart(assistantParts)) return null
  const markdown = getPresentedPlanMarkdown(assistantParts)
  if (!markdown) return null

  const implementationKey = getPlanImplementationKey(
    sessionID,
    getPlanBlockId(assistantMessage.id, 0),
  )
  if (
    implementedPlanRequests.has(implementationKey)
    || externallyHandedOffPlanRequests?.has(implementationKey)
  ) return null

  return {
    sessionID,
    sourceMessageId: assistantMessage.id,
    originatingUserMessageId: userMessage.id,
    implementationKey,
    markdown,
  }
}

function getPresentedPlanMarkdown(parts: readonly Part[]): string | null {
  const split = resolveMessagePlanCard(parts, { isPlanModeSource: true })
  const markdown = split?.planText ?? ""
  return markdown.trim().length > 0 ? markdown : null
}

function hasRunningToolPart(parts: readonly Part[]): boolean {
  for (const part of parts) {
    if (part.type !== "tool") continue
    const status = (part as { state?: { status?: unknown } }).state?.status
    if (status === "pending" || status === "running") return true
  }

  return false
}

function findOriginatingUserMessage(messages: readonly Message[], assistantIndex: number): Message | null {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return message
  }
  return null
}

function isAssistantTurnComplete(message: Message): boolean {
  const candidate = message as Message & { status?: unknown; streaming?: unknown }
  if (candidate.streaming === true) return false

  if (typeof candidate.status === "string") {
    const status = candidate.status.trim().toLowerCase()
    if (status === "running" || status === "pending" || status === "streaming") return false
    if (status === "complete" || status === "completed" || status === "done") return true
  }

  const completedAt = (message.time as { completed?: unknown } | undefined)?.completed
  return typeof completedAt === "number" && completedAt > 0
}
