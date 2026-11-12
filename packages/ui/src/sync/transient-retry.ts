import type { AttachedFile } from "@/stores/types/sessionTypes"
import { planManualRecovery, planTransientRecovery } from "@/lib/messages/transientRecovery"
import { latestUserMessageId } from "@/lib/messages/providerRecovery"
import { resolveSessionSendConfig } from "./send-config"
import {
  getSyncMessages,
  getSyncParts,
} from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"
import { waitForAbortGuardSettlement } from "./abort-retry-guard"
import {
  useProviderRecoveryStore,
  type ProviderRecoveryRecord,
} from "@/stores/useProviderRecoveryStore"

async function sendRecovery(
  sessionId: string,
  recovery: NonNullable<ReturnType<typeof planTransientRecovery>>,
  requested: { providerID?: string; modelID?: string; variant?: string | null; agent?: string },
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
  const currentUserMessageId = latestUserMessageId(messages)
  if (currentUserMessageId && currentUserMessageId !== record.anchorUserMessageId) {
    useProviderRecoveryStore.getState().clearRecovery(record.sessionId, record)
    return false
  }
  const recovery = planManualRecovery({
    messages,
    getParts: (messageId) => getSyncParts(messageId, record.directory),
    anchorUserMessageId: record.anchorUserMessageId,
  })
  if (!recovery) throw new Error("The failed turn is no longer available to retry.")
  return await sendRecovery(record.sessionId, recovery, {
    providerID: record.selection.providerId,
    modelID: record.selection.modelId,
    variant: record.selection.variant,
    agent: record.agent ?? undefined,
  }, { preserveProviderRecovery: true })
}
