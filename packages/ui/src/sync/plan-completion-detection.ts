import type { Message } from "@opencode-ai/sdk/v2/client"
import type { PlanIndicatorEntry } from "./plan-indicator"
import { getPlanBlockId, getPlanImplementationKey, isPlanModeUserMessage, resolveMessagePlanCard } from "@/lib/messages/actionablePlan"
import { filterMessagesForRevert, getEffectiveSessionRevertMessageID } from "./revert-transactions"
import { isFinalAssistantSummaryMessage } from "./session-working"
import type { State } from "./types"

export type PlanCompletedCandidate = {
  sessionID: string
  sourceMessageId: string
  implementationMessageId: string
  completedMessageId: string
}

type PlanCompletionDetectionState = Pick<
  State,
  "message" | "part" | "session" | "revert_transaction"
>

export function detectPlanCompletedCandidate({
  sessionID,
  state,
  planEntry,
  isRecordedPlanModeUserMessage,
  implementedPlanRequests,
}: {
  sessionID: string
  state: PlanCompletionDetectionState
  planEntry?: PlanIndicatorEntry | null
  isRecordedPlanModeUserMessage?: (messageId: string) => boolean
  implementedPlanRequests?: ReadonlySet<string>
}): PlanCompletedCandidate | null {
  const rawMessages = state.message[sessionID]
  if (!rawMessages || rawMessages.length === 0) return null

  const revertMessageID = getEffectiveSessionRevertMessageID(state, sessionID)
  const messages = filterMessagesForRevert(rawMessages, revertMessageID)

  if (planEntry?.state === "implementing" && planEntry.sourceMessageId && planEntry.implementationMessageId) {
    const implementationIndex = messages.findIndex((message) => (
      message.id === planEntry.implementationMessageId && message.role === "user"
    ))
    if (implementationIndex < 0) return null

    const completedMessage = findCompletedAssistantAfter(state, messages, implementationIndex)
    if (!completedMessage) return null

    return {
      sessionID,
      sourceMessageId: planEntry.sourceMessageId,
      implementationMessageId: planEntry.implementationMessageId,
      completedMessageId: completedMessage.id,
    }
  }

  if (!implementedPlanRequests || implementedPlanRequests.size === 0) return null

  return detectPersistedPlanCompletedCandidate({
    sessionID,
    state,
    messages,
    planEntry,
    isRecordedPlanModeUserMessage,
    implementedPlanRequests,
  })
}

function detectPersistedPlanCompletedCandidate({
  sessionID,
  state,
  messages,
  planEntry,
  isRecordedPlanModeUserMessage,
  implementedPlanRequests,
}: {
  sessionID: string
  state: PlanCompletionDetectionState
  messages: readonly Message[]
  planEntry?: PlanIndicatorEntry | null
  isRecordedPlanModeUserMessage?: (messageId: string) => boolean
  implementedPlanRequests: ReadonlySet<string>
}): PlanCompletedCandidate | null {
  for (let assistantIndex = messages.length - 1; assistantIndex >= 0; assistantIndex -= 1) {
    const assistantMessage = messages[assistantIndex]
    if (assistantMessage.role !== "assistant") continue
    if (!isFinalAssistantSummaryMessage(assistantMessage, state.part[assistantMessage.id])) continue
    if (!hasPresentedPlanCard(state, assistantMessage.id)) continue

    const userMessage = findOriginatingUserMessage(messages, assistantIndex)
    if (!userMessage) continue
    const recordedPlanMode = isRecordedPlanModeUserMessage?.(userMessage.id) ?? false
    if (!isPlanModeUserMessage(userMessage, state.part[userMessage.id] ?? [], recordedPlanMode)) continue

    const implementationKey = getPlanImplementationKey(sessionID, getPlanBlockId(assistantMessage.id, 0))
    if (!implementedPlanRequests.has(implementationKey)) continue

    const implementationIndex = findImplementationUserIndex(messages, assistantIndex, planEntry, assistantMessage.id)
    if (implementationIndex < 0) return null

    const completedMessage = findCompletedAssistantAfter(state, messages, implementationIndex)
    if (!completedMessage) return null

    return {
      sessionID,
      sourceMessageId: assistantMessage.id,
      implementationMessageId: messages[implementationIndex].id,
      completedMessageId: completedMessage.id,
    }
  }

  return null
}

function findCompletedAssistantAfter(
  state: PlanCompletionDetectionState,
  messages: readonly Message[],
  startIndex: number,
): Message | null {
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    if (!isFinalAssistantSummaryMessage(message, state.part[message.id])) continue
    return message
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

function findImplementationUserIndex(
  messages: readonly Message[],
  assistantIndex: number,
  planEntry: PlanIndicatorEntry | null | undefined,
  sourceMessageId: string,
): number {
  if (planEntry?.sourceMessageId === sourceMessageId && planEntry.implementationMessageId) {
    const knownIndex = messages.findIndex((message) => (
      message.id === planEntry.implementationMessageId && message.role === "user"
    ))
    if (knownIndex > assistantIndex) return knownIndex
  }

  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    if (messages[index].role === "user") return index
  }

  return -1
}

function hasPresentedPlanCard(state: PlanCompletionDetectionState, assistantMessageId: string): boolean {
  const parts = state.part[assistantMessageId] ?? []
  const split = resolveMessagePlanCard(parts, { isPlanModeSource: true })
  return Boolean(split && split.planText.trim().length > 0)
}
