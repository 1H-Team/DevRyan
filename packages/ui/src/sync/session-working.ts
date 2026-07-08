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

export function isAssistantTurnComplete(message: Message | undefined): boolean {
  if (!message || message.role !== "assistant") return false

  const candidate = message as Message & { status?: unknown; streaming?: unknown }
  if (candidate.streaming === true) return false

  if (typeof candidate.status === "string") {
    const status = candidate.status.trim().toLowerCase()
    if (status === "running" || status === "pending" || status === "streaming") return false
    if (status === "complete" || status === "completed" || status === "done") return true
  }

  return isTerminalAssistantMessage(message)
}

export function isIncompleteAssistantMessage(message: Message | undefined): boolean {
  return Boolean(
    message
    && message.role === "assistant"
    && !isAssistantTurnComplete(message),
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

export function hasVisibleAssistantSummary(parts: readonly Part[] | undefined): boolean {
  for (const part of parts ?? []) {
    if (part.type !== "text" && part.type !== "reasoning") continue

    const text = (part as { text?: unknown }).text
    if (typeof text === "string" && text.trim().length > 0) return true

    const output = (part as { output?: unknown }).output
    if (typeof output === "string" && output.trim().length > 0) return true
  }

  return false
}

export function isFinalAssistantSummaryMessage(
  message: Message | undefined,
  parts?: readonly Part[],
): boolean {
  if (!isAssistantTurnComplete(message)) return false
  if (hasToolCallAssistantFinish(message)) return false
  if (hasInFlightToolParts(parts)) return false
  return hasVisibleAssistantSummary(parts)
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
  const livePartsBelongToLastMessage = !liveStreamingMessageId || lastMessage?.id === liveStreamingMessageId
  const trackedLiveStreaming = Boolean(
    liveStreamingMessageId
    && (() => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.role === "user") return false
        if (message.id !== liveStreamingMessageId) continue
        return isLiveAssistantMessage(message, liveParts)
      }

      return false
    })()
  )
  // Trust authoritative idle status over stale incomplete assistant messages.
  // A currently tracked streaming id is the narrow exception for out-of-order
  // idle status events during the live turn. OpenCode can append a trailing
  // empty assistant shell while the prior tool-call assistant is still live.
  if (hasAuthoritativeStatus) {
    return statusWorking || trackedLiveStreaming
  }

  return trackedLiveStreaming || isLiveAssistantMessage(
    lastMessage,
    livePartsBelongToLastMessage ? liveParts : undefined,
  )
}
