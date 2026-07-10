import type { AttachedFile } from "@/stores/types/sessionTypes"
import { isLikelyTransientStreamFailure } from "@/lib/messages/transientStreamError"
import { planTransientRecovery } from "@/lib/messages/transientRecovery"
import { resolveSessionSendConfig } from "./send-config"
import {
  getSyncMessages,
  getSyncParts,
  getSyncSessionDirectoryAnyDirectory,
} from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"

export async function executeTransientRetry(
  sessionId: string,
  options: { onRecoveryUserMessageId?: (messageId: string) => void } = {},
): Promise<boolean> {
  const directory = getSyncSessionDirectoryAnyDirectory(sessionId)
  if (!directory) {
    return false
  }

  const messages = getSyncMessages(sessionId, directory)
  const latestMessage = messages.at(-1)
  if (!latestMessage || latestMessage.role !== "assistant" || !latestMessage.error) {
    return false
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
    return false
  }

  const recovery = planTransientRecovery({
    messages,
    getParts: (messageId) => getSyncParts(messageId, directory),
    erroredMessageId: latestMessage.id,
  })
  if (!recovery) {
    return false
  }

  const sendConfig = resolveSessionSendConfig(sessionId, {
    providerID: recovery.providerID,
    modelID: recovery.modelID,
  })
  if (!sendConfig.providerID || !sendConfig.modelID) {
    throw new Error("Unable to resolve a provider and model for this retry.")
  }

  const attachments: AttachedFile[] = recovery.attachments.map((attachment, index) => ({
    id: `transient-retry-${recovery.anchorUserMessageId}-${index}`,
    file: new File([], attachment.filename, { type: attachment.mimeType }),
    dataUrl: attachment.dataUrl,
    mimeType: attachment.mimeType,
    filename: attachment.filename,
    size: 0,
    source: "server",
  }))

  await useSessionUIStore.getState().sendMessageToSession(
    sessionId,
    recovery.content,
    sendConfig.providerID,
    sendConfig.modelID,
    sendConfig.agent,
    attachments,
    undefined,
    undefined,
    sendConfig.variant,
    "normal",
    sendConfig.planMode,
    { onMessageID: options.onRecoveryUserMessageId },
  )
  return true
}
