import type { QueuedMessage } from "@/stores/messageQueueStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { getSyncSessionStatusAnyDirectory } from "@/sync/sync-refs"

export type QueuedSendConfig = {
  providerID: string
  modelID: string
  agent?: string
  variant?: string
  planMode?: boolean
}

export type PreparedQueuedMessage = QueuedSendConfig & {
  content: string
  attachments?: AttachedFile[]
  agentMentionName?: string
}

export type SendQueuedMessageToSession = (
  sessionId: string,
  content: string,
  providerID: string,
  modelID: string,
  agent?: string,
  attachments?: AttachedFile[],
  agentMentionName?: string,
  additionalParts?: undefined,
  variant?: string,
  inputMode?: "normal",
  planMode?: boolean,
) => Promise<void>

export type FlushQueuedMessagesOptions = {
  sessionId: string
  fallbackSendConfig: QueuedSendConfig
  prepareQueuedMessage: (message: QueuedMessage, sendConfig: QueuedSendConfig) => PreparedQueuedMessage
  sendMessageToSession?: SendQueuedMessageToSession
  waitForReadyToSendNext?: (sessionId: string) => Promise<void>
}

const resolveSendConfig = (
  queuedMessage: QueuedMessage,
  fallbackSendConfig: QueuedSendConfig,
): QueuedSendConfig => ({
  providerID: queuedMessage.sendConfig?.providerID ?? fallbackSendConfig.providerID,
  modelID: queuedMessage.sendConfig?.modelID ?? fallbackSendConfig.modelID,
  agent: queuedMessage.sendConfig?.agent ?? fallbackSendConfig.agent,
  variant: queuedMessage.sendConfig?.variant ?? fallbackSendConfig.variant,
  planMode: typeof queuedMessage.sendConfig?.planMode === "boolean"
    ? queuedMessage.sendConfig.planMode
    : fallbackSendConfig.planMode,
})

const defaultSendMessageToSession: SendQueuedMessageToSession = (...args) =>
  useSessionUIStore.getState().sendMessageToSession(...args)

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

const queuedMessageFlushCounts = new Map<string, number>()

export function isQueuedMessageFlushInFlight(sessionId: string): boolean {
  return (queuedMessageFlushCounts.get(sessionId) ?? 0) > 0
}

export async function waitForQueuedTurnIdle(sessionId: string): Promise<void> {
  const busyDeadline = Date.now() + 5_000

  while (Date.now() < busyDeadline) {
    const status = getSyncSessionStatusAnyDirectory(sessionId)
    if (status && status.type !== "idle") {
      break
    }
    await delay(100)
  }

  const idleDeadline = Date.now() + 30 * 60_000
  while (Date.now() < idleDeadline) {
    const status = getSyncSessionStatusAnyDirectory(sessionId)
    if (!status || status.type === "idle") {
      return
    }
    await delay(250)
  }

  throw new Error("Timed out waiting for queued message turn to finish")
}

export async function flushQueuedMessagesForSession(options: FlushQueuedMessagesOptions): Promise<number> {
  const claimedMessages = useMessageQueueStore.getState().claimQueueForSession(options.sessionId)
  if (claimedMessages.length === 0) {
    return 0
  }

  const sendMessageToSession = options.sendMessageToSession ?? defaultSendMessageToSession
  const waitForReadyToSendNext = options.waitForReadyToSendNext ?? waitForQueuedTurnIdle
  let nextMessageIndex = 0
  queuedMessageFlushCounts.set(
    options.sessionId,
    (queuedMessageFlushCounts.get(options.sessionId) ?? 0) + 1,
  )

  try {
    while (nextMessageIndex < claimedMessages.length) {
      const queuedMessage = claimedMessages[nextMessageIndex]
      const sendConfig = resolveSendConfig(queuedMessage, options.fallbackSendConfig)
      const preparedMessage = options.prepareQueuedMessage(queuedMessage, sendConfig)

      await sendMessageToSession(
        options.sessionId,
        preparedMessage.content,
        preparedMessage.providerID,
        preparedMessage.modelID,
        preparedMessage.agent,
        preparedMessage.attachments,
        preparedMessage.agentMentionName,
        undefined,
        preparedMessage.variant,
        "normal",
        preparedMessage.planMode,
      )

      nextMessageIndex += 1

      if (nextMessageIndex < claimedMessages.length) {
        await waitForReadyToSendNext(options.sessionId)
      }
    }
  } catch (error) {
    useMessageQueueStore.getState().restoreClaimedQueue(
      options.sessionId,
      claimedMessages.slice(nextMessageIndex),
    )
    throw error
  } finally {
    const remainingFlushes = (queuedMessageFlushCounts.get(options.sessionId) ?? 1) - 1
    if (remainingFlushes > 0) {
      queuedMessageFlushCounts.set(options.sessionId, remainingFlushes)
    } else {
      queuedMessageFlushCounts.delete(options.sessionId)
    }
  }

  return claimedMessages.length
}
