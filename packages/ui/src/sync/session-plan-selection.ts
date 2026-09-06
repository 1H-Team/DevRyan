import type { Part } from "@opencode-ai/sdk/v2"
import { isPlanModeUserMessage, isPlanSelectionMaintenanceMessage } from "@/lib/messages/actionablePlan"
import type { State } from "./types"

type PlanSelectionState = Pick<State, "message" | "part">

export type SessionPlanSelection = {
  messageID: string
  enabled: boolean
}

/** Plan authority excludes exact maintenance wakes without changing model/effort restoration. */
export function createSessionPlanSelectionSelector(
  sessionID: string,
  isRecordedPlanMode: (messageID: string) => boolean = () => false,
) {
  let previousMessages: State["message"][string] | undefined
  let observedParts: { messageID: string; parts: readonly Part[] | undefined }[] = []
  let previousRecordedPlanMode = false
  let previousSelection: SessionPlanSelection | null = null

  return (state: PlanSelectionState): SessionPlanSelection | null => {
    const messages = state.message[sessionID]
    const recordedPlanMode = previousSelection ? isRecordedPlanMode(previousSelection.messageID) : false
    // Assistant streaming never changes the inspected user-part references.
    if (messages === previousMessages && recordedPlanMode === previousRecordedPlanMode
      && observedParts.every(({ messageID, parts }) => state.part[messageID] === parts)) return previousSelection

    previousMessages = messages
    observedParts = []
    for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== "user") continue
      const parts = state.part[message.id]
      observedParts.push({ messageID: message.id, parts })
      // Newest info can precede its parts. It is not evidence of an OFF choice,
      // nor permission to commit an older policy while hydration catches up.
      if (!parts) break
      if (isPlanSelectionMaintenanceMessage(parts)) continue
      previousRecordedPlanMode = isRecordedPlanMode(message.id)
      const enabled = isPlanModeUserMessage(message, parts, previousRecordedPlanMode)
      if (previousSelection?.messageID === message.id && previousSelection.enabled === enabled) return previousSelection
      previousSelection = { messageID: message.id, enabled }
      return previousSelection
    }
    previousRecordedPlanMode = false
    previousSelection = null
    return null
  }
}
