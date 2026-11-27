// Test wrapper, never part of the product: calls the two draft-mutating exports of
// `session-user-activity.ts` and returns the draft with the result, so a port can be compared.
import type { Message } from "@opencode-ai/sdk/v2/client"
import type { State } from "../../../../ui/src/sync/types"
import {
  updateSessionUserActivityFromMessage,
  updateSessionUserActivityFromMessages,
} from "../../../../ui/src/sync/session-user-activity"

export function updateFromMessagesReturningDraft(draft: State, sessionID: string): { result: boolean; draft: State } {
  const result = updateSessionUserActivityFromMessages(draft, sessionID)
  return { result, draft }
}

export function updateFromMessageReturningDraft(draft: State, message: Message): { result: boolean; draft: State } {
  const result = updateSessionUserActivityFromMessage(draft, message)
  return { result, draft }
}
