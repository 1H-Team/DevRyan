import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { QueuedMessage } from "@/stores/messageQueueStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { createClientMessageId } from "@/sync/client-message-id"
import {
  hasInFlightToolParts,
  hasToolCallAssistantFinish,
  isAssistantTurnComplete,
} from "@/sync/session-working"
import { useSessionUIStore } from "@/sync/session-ui-store"
import {
  getSyncMessages,
  getSyncParts,
  getSyncSessionDirectoryAnyDirectory,
  getSyncSessionStatusAnyDirectory,
} from "@/sync/sync-refs"

export type QueuedSendConfig = {
  providerID: string
  modelID: string
  agent?: string
  variant?: string
  planMode?: boolean
}

export type PreparedQueuedMessage = QueuedSendConfig & {
  content: string
  messageID?: string
  directory?: string
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
  lifecycleCallbacks?: { messageID?: string; directory?: string },
) => Promise<void>

export type FlushQueuedMessagesOptions = {
  sessionId: string
  fallbackSendConfig: QueuedSendConfig
  prepareQueuedMessage: (message: QueuedMessage, sendConfig: QueuedSendConfig) => PreparedQueuedMessage
  sendMessageToSession?: SendQueuedMessageToSession
  waitForReadyToSendNext?: (sessionId: string, messageId?: string, directory?: string) => Promise<void>
  createMessageId?: () => string
  waitForCurrentTurnBeforeFirstSend?: boolean
  getCurrentTurnContext?: (sessionId: string) => { messageId?: string; directory?: string }
  authorizeSend?: (request: {
    sessionId: string
    agentName: string | null | undefined
  }) => Promise<boolean>
}

export type SendQueuedMessagesNowOptions = FlushQueuedMessagesOptions & {
  interruptBeforeFlush: boolean
  interruptCurrentOperation: (sessionId: string) => Promise<void>
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

export class QueuedSendAuthorizationRequiredError extends Error {
  constructor() {
    super("Queued send requires agent handoff confirmation")
    this.name = "QueuedSendAuthorizationRequiredError"
  }
}

export function isQueuedMessageFlushInFlight(sessionId: string): boolean {
  return (queuedMessageFlushCounts.get(sessionId) ?? 0) > 0
}

export function hasCompletedQueuedTurn(
  messages: readonly Message[],
  partsByMessageId: (messageId: string) => readonly Part[],
  userMessageId: string,
): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue
    if ((message as Message & { parentID?: string }).parentID !== userMessageId) continue
    if (!isAssistantTurnComplete(message)) continue

    const parts = partsByMessageId(message.id)
    if (hasToolCallAssistantFinish(message)) continue
    if (hasInFlightToolParts(parts)) continue
    return true
  }

  return false
}

export async function waitForQueuedTurnIdle(
  sessionId: string,
  userMessageId?: string,
  directory?: string,
): Promise<void> {
  if (userMessageId) {
    const completionDeadline = Date.now() + 30 * 60_000
    while (Date.now() < completionDeadline) {
      const resolvedDirectory = directory ?? getSyncSessionDirectoryAnyDirectory(sessionId)
      const messages = getSyncMessages(sessionId, resolvedDirectory)
      if (hasCompletedQueuedTurn(
        messages,
        (messageId) => getSyncParts(messageId, resolvedDirectory),
        userMessageId,
      ) && (getSyncSessionStatusAnyDirectory(sessionId)?.type ?? "idle") === "idle") {
        return
      }
      await delay(250)
    }

    throw new Error("Timed out waiting for queued message turn to finish")
  }

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

function getDefaultCurrentTurnContext(sessionId: string): { messageId?: string; directory?: string } {
  const directory = getSyncSessionDirectoryAnyDirectory(sessionId)
  const messages = getSyncMessages(sessionId, directory)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") {
      return { messageId: message.id, directory }
    }
  }

  return { directory }
}

export async function flushQueuedMessagesForSession(options: FlushQueuedMessagesOptions): Promise<number> {
  const claimedQueue = useMessageQueueStore.getState().claimQueueForSession(options.sessionId)
  if (claimedQueue.length === 0) {
    return 0
  }
  const claimedMessages = [...claimedQueue]

  const sendMessageToSession = options.sendMessageToSession ?? defaultSendMessageToSession
  const waitForReadyToSendNext = options.waitForReadyToSendNext ?? waitForQueuedTurnIdle
  const createMessageId = options.createMessageId ?? (() => createClientMessageId("msg"))
  let nextMessageIndex = 0
  queuedMessageFlushCounts.set(
    options.sessionId,
    (queuedMessageFlushCounts.get(options.sessionId) ?? 0) + 1,
  )

  try {
    if (options.waitForCurrentTurnBeforeFirstSend) {
      const currentTurnContext = (options.getCurrentTurnContext ?? getDefaultCurrentTurnContext)(options.sessionId)
      if (currentTurnContext.messageId) {
        await waitForReadyToSendNext(
          options.sessionId,
          currentTurnContext.messageId,
          currentTurnContext.directory,
        )
      }
    }

    while (nextMessageIndex < claimedMessages.length) {
      const claimedMessage = claimedMessages[nextMessageIndex]
      const queuedMessage = claimedMessage.messageId && claimedMessage.messageIdScope === "dispatch"
        ? claimedMessage
        : {
            ...claimedMessage,
            messageId: createMessageId(),
            messageIdScope: "dispatch" as const,
          }
      claimedMessages[nextMessageIndex] = queuedMessage
      const sendConfig = resolveSendConfig(queuedMessage, options.fallbackSendConfig)
      if (options.authorizeSend && !await options.authorizeSend({
        sessionId: options.sessionId,
        agentName: sendConfig.agent,
      })) {
        throw new QueuedSendAuthorizationRequiredError()
      }
      const preparedMessage = options.prepareQueuedMessage(queuedMessage, sendConfig)
      const messageID = preparedMessage.messageID ?? queuedMessage.messageId
      const directory = preparedMessage.directory ?? queuedMessage.directory

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
        (messageID || directory)
          ? { messageID, directory }
          : undefined,
      )

      nextMessageIndex += 1

      if (nextMessageIndex < claimedMessages.length) {
        await waitForReadyToSendNext(options.sessionId, messageID, directory)
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

export async function sendQueuedMessagesNowForSession(
  options: SendQueuedMessagesNowOptions,
): Promise<number> {
  if (options.interruptBeforeFlush) {
    await options.interruptCurrentOperation(options.sessionId)
  }

  return flushQueuedMessagesForSession(options)
}
