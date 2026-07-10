import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { isLikelyTransientStreamFailure } from "@/lib/messages/transientStreamError"

export type TransientAutoRetryAttemptRecord = {
  anchorUserMessageId: string
  attempts: number
  attemptedErroredMessageIds: ReadonlySet<string>
  recoveryUserMessageIds?: ReadonlySet<string>
}

export type TransientAutoRetryDecision = {
  anchorUserMessageId: string
  erroredMessageId: string
}

type TransientAutoRetryDecisionInput = {
  messages: Message[]
  queuedMessageCount: number
  blockingRequestCount: number
  observedActiveUserMessageId?: string
  attemptRecord?: TransientAutoRetryAttemptRecord
}

export function getLatestUserMessageId(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") {
      return message.id
    }
  }
  return undefined
}

export function didLiveSessionBecomeIdle(
  previous: SessionStatus["type"] | undefined,
  current: SessionStatus["type"] | undefined,
): boolean {
  return (previous === "busy" || previous === "retry") && current === "idle"
}

export function decideTransientAutoRetry({
  messages,
  queuedMessageCount,
  blockingRequestCount,
  observedActiveUserMessageId,
  attemptRecord,
}: TransientAutoRetryDecisionInput): TransientAutoRetryDecision | null {
  if (queuedMessageCount > 0 || blockingRequestCount > 0) {
    return null
  }

  const latestMessage = messages.at(-1)
  if (!latestMessage || latestMessage.role !== "assistant" || !latestMessage.error) {
    return null
  }

  const error = latestMessage.error as {
    name?: unknown
    data?: { message?: unknown }
    message?: unknown
  }
  const detail = typeof error.data?.message === "string"
    ? error.data.message
    : typeof error.message === "string"
      ? error.message
      : error.name
  if (!isLikelyTransientStreamFailure(error.name, detail)) {
    return null
  }

  const anchorUserMessageId = getLatestUserMessageId(messages.slice(0, -1))
  if (!anchorUserMessageId || anchorUserMessageId !== observedActiveUserMessageId) {
    return null
  }

  if (attemptRecord) {
    if (attemptRecord.recoveryUserMessageIds?.has(anchorUserMessageId)) {
      return null
    }
    if (
      attemptRecord.anchorUserMessageId === anchorUserMessageId
      && (
        attemptRecord.attempts >= 1
        || attemptRecord.attemptedErroredMessageIds.has(latestMessage.id)
      )
    ) {
      return null
    }
  }

  return {
    anchorUserMessageId,
    erroredMessageId: latestMessage.id,
  }
}
