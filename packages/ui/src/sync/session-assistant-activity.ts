import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { filterMessagesForRevert, getSessionRevertMessageID } from "./revert-transactions"

export type SessionAssistantActivity = Record<string, number>

const toFiniteTimestamp = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export const getAssistantResponseAt = (message: Message): number | undefined => {
  const time = message.time as { completed?: unknown; updated?: unknown; created?: unknown } | undefined
  const completedAt = toFiniteTimestamp(time?.completed)
  if (completedAt !== undefined) return completedAt

  const updatedAt = toFiniteTimestamp(time?.updated)
  if (updatedAt !== undefined) return updatedAt

  return toFiniteTimestamp(time?.created)
}

export const getLastVisibleAssistantResponseAt = (
  session: Session | undefined,
  messages: readonly Message[] | undefined,
): number | undefined => {
  if (!messages) return undefined

  const revertMessageID = getSessionRevertMessageID(session)
  const visibleMessages = revertMessageID ? filterMessagesForRevert(messages, revertMessageID) : messages
  let latest: number | undefined
  for (const message of visibleMessages) {
    if (message.role !== "assistant") continue
    const responseAt = getAssistantResponseAt(message)
    if (responseAt === undefined) continue
    latest = latest === undefined ? responseAt : Math.max(latest, responseAt)
  }
  return latest
}
