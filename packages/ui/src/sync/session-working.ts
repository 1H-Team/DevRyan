import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { getToolLifecycleState } from "@/lib/toolStatus"

export function hasTerminalAssistantFinish(message: Message | undefined): boolean {
  if (!message || message.role !== "assistant") return false
  const finish = (message as { finish?: unknown }).finish
  if (typeof finish !== "string") return false
  const normalized = finish.trim().toLowerCase()
  return normalized.length > 0 && normalized !== "tool-calls"
}

export function hasToolCallAssistantFinish(message: Message | undefined): boolean {
  if (!message || message.role !== "assistant") return false
  const finish = (message as { finish?: unknown }).finish
  return typeof finish === "string" && finish.trim().toLowerCase() === "tool-calls"
}

export function isTerminalAssistantMessage(message: Message | undefined): boolean {
  if (!message || message.role !== "assistant") return false
  const completed = (message as { time?: { completed?: unknown } }).time?.completed
  return typeof completed === "number" || hasTerminalAssistantFinish(message)
}

export function isIncompleteAssistantMessage(message: Message | undefined): boolean {
  return Boolean(
    message
    && message.role === "assistant"
    && !isTerminalAssistantMessage(message),
  )
}

export function hasInFlightToolParts(parts: readonly Part[] | undefined): boolean {
  for (const part of parts ?? []) {
    if (part.type !== "tool") continue
    const state = (part as Part & {
      state?: { status?: unknown; time?: { start?: unknown; end?: unknown } }
    }).state
    if (getToolLifecycleState(state).isInFlight) return true
  }

  return false
}

export function isLiveAssistantMessage(
  message: Message | undefined,
  parts?: readonly Part[],
): boolean {
  if (!message || message.role !== "assistant") return false
  if (isIncompleteAssistantMessage(message)) return true
  return hasToolCallAssistantFinish(message) && hasInFlightToolParts(parts)
}

export function isSessionWorkingFromState({
  status,
  permissions,
  messages,
  liveStreamingMessageId,
  liveParts,
}: {
  status: SessionStatus | undefined
  permissions: readonly unknown[]
  messages: readonly Message[]
  liveStreamingMessageId?: string | null
  liveParts?: readonly Part[]
}): boolean {
  // Permissions pending → not "working" (show permission indicator instead)
  if (permissions.length > 0) return false

  const hasAuthoritativeStatus = status !== undefined
  const statusWorking = hasAuthoritativeStatus && status.type !== "idle"
  const lastMessage = messages[messages.length - 1]
  const trailingLiveStreaming = Boolean(
    isLiveAssistantMessage(lastMessage, liveParts)
    && lastMessage.id === liveStreamingMessageId
  )
  // Trust authoritative idle status over stale incomplete assistant messages.
  // A currently tracked streaming id is the narrow exception for out-of-order
  // idle status events during the live turn.
  if (hasAuthoritativeStatus) {
    return statusWorking || trailingLiveStreaming
  }

  return isLiveAssistantMessage(lastMessage, liveParts)
}
