import type { AttachedFile } from "@/stores/types/sessionTypes"
import { isLikelyTransientStreamFailure } from "@/lib/messages/transientStreamError"
import { planManualRecovery, planTransientRecovery } from "@/lib/messages/transientRecovery"
import { resolveSessionSendConfig } from "./send-config"
import {
  getSyncMessages,
  getSyncParts,
  getSyncSessionDirectoryAnyDirectory,
} from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"
import { waitForAbortGuardSettlement } from "./abort-retry-guard"
import type { ProviderRecoveryRecord } from "@/stores/useProviderRecoveryStore"

async function sendRecovery(
  sessionId: string,
  recovery: NonNullable<ReturnType<typeof planTransientRecovery>>,
  requested: { providerID?: string; modelID?: string; variant?: string; agent?: string },
  options: {
    onRecoveryUserMessageId?: (messageId: string) => void
    preserveProviderRecovery?: boolean
  } = {},
): Promise<boolean> {
  const sendConfig = resolveSessionSendConfig(sessionId, requested)
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
    {
      onMessageID: options.onRecoveryUserMessageId,
      preserveProviderRecovery: options.preserveProviderRecovery,
    },
  )
  return true
}

export async function executeProviderRecovery(record: ProviderRecoveryRecord): Promise<boolean> {
  await waitForAbortGuardSettlement(record.sessionId)
  const messages = getSyncMessages(record.sessionId, record.directory)
  const recovery = planManualRecovery({
    messages,
    getParts: (messageId) => getSyncParts(messageId, record.directory),
    anchorUserMessageId: record.anchorUserMessageId,
  })
  if (!recovery) throw new Error("The failed turn is no longer available to retry.")
  return await sendRecovery(record.sessionId, recovery, {
    providerID: record.selection.providerId,
    modelID: record.selection.modelId,
    variant: record.selection.variant ?? undefined,
    agent: record.agent ?? undefined,
  }, { preserveProviderRecovery: true })
}

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

  return await sendRecovery(sessionId, recovery, {
    providerID: recovery.providerID,
    modelID: recovery.modelID,
  }, options)
}
